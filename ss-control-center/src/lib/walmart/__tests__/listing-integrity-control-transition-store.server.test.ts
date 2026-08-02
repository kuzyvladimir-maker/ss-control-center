import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createClient,
  type Client,
  type InValue,
} from "@libsql/client";

import {
  createWalmartListingIntegrityQueuedState,
  transitionWalmartListingIntegrityControlState,
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
} from "../listing-integrity-control-plane";
import {
  admitAndPersistWalmartListingIntegrityOperatorReceipt,
  persistWalmartListingIntegrityControlTransition,
  WALMART_LISTING_INTEGRITY_CONTROL_ZERO_HASH,
} from "../listing-integrity-control-transition-store.server";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const PACKAGE = H("package");
const PERMIT = H("permit");
const FEED = "18C7B9727AC0538CA1F1E40C884D0BCD@AX8BBwA";
const MIGRATION = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260801172000_walmart_listing_integrity_control_plane_stage_a",
  "migration.sql",
);

function advance(
  current: WalmartListingIntegrityControlState,
  nextState: Parameters<typeof transitionWalmartListingIntegrityControlState>[0]["next_state"],
  extras: Partial<Parameters<typeof transitionWalmartListingIntegrityControlState>[0]> = {},
) {
  return transitionWalmartListingIntegrityControlState({
    current,
    next_state: nextState,
    transitioned_at: new Date(Date.parse(current.transitioned_at) + 1_000).toISOString(),
    evidence_sha256: H(`${current.state}-${nextState}`),
    ...extras,
  });
}

function applyRequesting() {
  let state = createWalmartListingIntegrityQueuedState({
    identity: {
      run_id: "wlirun-transition-1",
      pool_body_sha256: H("pool"),
      ordinal: 1,
      listing_key: "walmart:1:FaisalX-1144",
      sku: "FaisalX-1144",
      item_id: "3AVBUC6GCQH2",
      store_index: 1,
    },
    created_at: "2026-08-01T17:00:00.000Z",
    queue_evidence_sha256: H("queue"),
  });
  state = advance(state, "DIAGNOSING");
  state = advance(state, "ISSUE_PROVEN");
  state = advance(state, "REPAIR_PLANNED", { execution_package_sha256: PACKAGE });
  state = advance(state, "AWAITING_OWNER");
  state = advance(state, "OWNER_APPROVED", { owner_permit_sha256: PERMIT });
  return advance(state, "APPLY_REQUESTING");
}

function receiptBytes() {
  const body = {
    schema_version: "walmart-listing-repair-operator-receipt/v1",
    command: "execute",
    completed_at: "2026-08-01T17:10:00.000Z",
    listing: {
      channel: "WALMART_US",
      item_id: "8394316918",
      listing_key: "walmart:1:FaisalX-1144",
      sku: "FaisalX-1144",
      store_index: 1,
    },
    status: "APPLIED_PROPAGATING",
    reason_code: "FEED_STATUS_HTTP_PENDING",
    feed_id: FEED,
    execution_package_artifact_sha256: PACKAGE,
    permit_authorization_sha256: PERMIT,
    marketplace_write_calls: 1,
    automatic_reapply_allowed: false,
    transport_counts: {
      feed_status_get_calls: 20,
      maintenance_post_calls: 1,
      oauth_token_calls: 1,
      total_http_calls: 22,
    },
  };
  return Buffer.from(`${JSON.stringify({
    ...body,
    body_sha256: walmartListingIntegrityControlSha256(body),
  }, null, 2)}\n`, "utf8");
}

function normalize(value: unknown): InValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value as InValue;
}

function store(db: Client) {
  return {
    async $transaction<T>(callback: (transaction: {
      $queryRawUnsafe<R = unknown>(query: string, ...values: unknown[]): Promise<R>;
      $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
    }) => Promise<T>): Promise<T> {
      const transaction = await db.transaction("write");
      const adapter = {
        async $queryRawUnsafe<R = unknown>(query: string, ...values: unknown[]): Promise<R> {
          const result = await transaction.execute({
            sql: query,
            args: values.map(normalize),
          });
          return result.rows as R;
        },
        async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
          const result = await transaction.execute({
            sql: query,
            args: values.map(normalize),
          });
          return result.rowsAffected;
        },
      };
      try {
        const result = await callback(adapter);
        await transaction.commit();
        return result;
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        transaction.close();
      }
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "listing-integrity-transition-"));
  const db = createClient({ url: `file:${path.join(root, "control.sqlite")}` });
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(await readFile(MIGRATION, "utf8"));
  const current = applyRequesting();
  await db.execute({
    sql: `INSERT INTO WalmartListingIntegrityControlRun (
      runId,schemaVersion,poolBodySha256,releaseIdSha256,manifestSha256,
      runtimeStage,status,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [
      current.identity.run_id,
      "walmart-listing-integrity-control-run/v1",
      current.identity.pool_body_sha256,
      H("release"), H("manifest"), "OFF", "ACTIVE",
      current.transitioned_at, current.transitioned_at,
    ],
  });
  await db.execute({
    sql: `INSERT INTO WalmartListingIntegrityControlItem (
      itemControlId,runId,ordinal,listingKey,sku,itemId,storeIndex,state,
      revision,stateBodySha256,previousStateSha256,evidenceSha256,
      executionPackageSha256,ownerPermitSha256,feedId,
      marketplaceWriteCalls,automaticRetryAllowed,automaticReplayAllowed,
      transitionedAt,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      "control-item-1", current.identity.run_id, current.identity.ordinal,
      current.identity.listing_key, current.identity.sku,
      current.identity.item_id, current.identity.store_index, current.state,
      current.revision, current.body_sha256, current.previous_state_sha256,
      current.evidence_sha256, current.execution_package_sha256,
      current.owner_permit_sha256, current.feed_id,
      current.marketplace_write_calls, false, false,
      current.transitioned_at, current.transitioned_at, current.transitioned_at,
    ],
  });
  return { db, current, root };
}

test("one admitted operator receipt atomically persists state, artifact, and hash-chain event", async () => {
  const { db, current, root } = await fixture();
  try {
    const receipt = receiptBytes();
    const persisted = await admitAndPersistWalmartListingIntegrityOperatorReceipt({
      stage: "ONE_SKU",
      current,
      receipt_bytes: receipt,
      store: store(db),
    });
    assert.equal(persisted.state.state, "APPLIED");
    assert.equal(persisted.state.feed_id, FEED);
    assert.equal(persisted.event.sequence, 1);
    assert.equal(
      persisted.event.previous_event_hash,
      WALMART_LISTING_INTEGRITY_CONTROL_ZERO_HASH,
    );
    assert.equal(persisted.artifact.sha256, H(receipt.toString("binary")));

    const item = await db.execute(
      "SELECT state,revision,stateBodySha256,previousStateSha256,feedId,marketplaceWriteCalls FROM WalmartListingIntegrityControlItem",
    );
    assert.deepEqual(item.rows[0], {
      state: "APPLIED",
      revision: current.revision + 1,
      stateBodySha256: persisted.state.body_sha256,
      previousStateSha256: current.body_sha256,
      feedId: FEED,
      marketplaceWriteCalls: 1,
    });
    assert.equal((await db.execute(
      "SELECT COUNT(*) AS count FROM WalmartListingIntegrityControlArtifact",
    )).rows[0]?.count, 1);
    assert.equal((await db.execute(
      "SELECT COUNT(*) AS count FROM WalmartListingIntegrityControlEvent",
    )).rows[0]?.count, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a replay with the stale predecessor loses CAS and adds no duplicate evidence", async () => {
  const { db, current, root } = await fixture();
  try {
    const receipt = receiptBytes();
    const input = {
      stage: "ONE_SKU" as const,
      current,
      receipt_bytes: receipt,
      store: store(db),
    };
    await admitAndPersistWalmartListingIntegrityOperatorReceipt(input);
    await assert.rejects(
      admitAndPersistWalmartListingIntegrityOperatorReceipt(input),
      /TRANSITION_CAS_LOST/,
    );
    assert.equal((await db.execute(
      "SELECT COUNT(*) AS count FROM WalmartListingIntegrityControlArtifact",
    )).rows[0]?.count, 1);
    assert.equal((await db.execute(
      "SELECT COUNT(*) AS count FROM WalmartListingIntegrityControlEvent",
    )).rows[0]?.count, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a transient SQLITE_BUSY retries only the atomic transaction and persists once", async () => {
  const { db, current, root } = await fixture();
  try {
    const next = advance(current, "MANUAL_REVIEW");
    const evidence = Buffer.from("{\"status\":\"manual-review\"}\n", "utf8");
    const boundNext = transitionWalmartListingIntegrityControlState({
      current,
      next_state: next.state,
      transitioned_at: next.transitioned_at,
      evidence_sha256: H(evidence.toString("binary")),
    });
    const actual = store(db);
    let attempts = 0;
    const persisted = await persistWalmartListingIntegrityControlTransition({
      current,
      next: boundNext,
      evidence_bytes: evidence,
      evidence_role: "TRANSIENT_BUSY_TEST",
      created_by_principal: "test",
      store: {
        async $transaction<T>(callback: Parameters<typeof actual.$transaction<T>>[0]) {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("SQLITE_BUSY: database is locked");
          }
          return actual.$transaction(callback);
        },
      },
    });
    assert.equal(attempts, 3);
    assert.equal(persisted.state.state, "MANUAL_REVIEW");
    assert.equal((await db.execute(
      "SELECT COUNT(*) AS count FROM WalmartListingIntegrityControlArtifact",
    )).rows[0]?.count, 1);
    assert.equal((await db.execute(
      "SELECT COUNT(*) AS count FROM WalmartListingIntegrityControlEvent",
    )).rows[0]?.count, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("default-OFF admission fails before opening a database transaction", async () => {
  const current = applyRequesting();
  let transactions = 0;
  await assert.rejects(
    admitAndPersistWalmartListingIntegrityOperatorReceipt({
      stage: "OFF",
      current,
      receipt_bytes: receiptBytes(),
      store: {
        async $transaction() {
          transactions += 1;
          throw new Error("must not reach persistence");
        },
      },
    }),
    /requires explicitly activated ONE_SKU/,
  );
  assert.equal(transactions, 0);
});
