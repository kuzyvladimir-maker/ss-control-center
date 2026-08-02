import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  transitionWalmartListingIntegrityControlState,
} from "../listing-integrity-control-plane.ts";
import {
  buildWalmartListingIntegrityControlSeedPlan,
} from "../listing-integrity-control-seed.ts";
import {
  completeWalmartListingIntegrityControlRun,
  persistWalmartListingIntegrityControlTransition,
  seedWalmartListingIntegrityControlRun,
} from "../listing-integrity-control-writer.server.ts";
import {
  buildWalmartListingIntegrityRunCompletionEvidence,
} from "../listing-integrity-control-run-completion.ts";
import {
  walmartListingIntegrityCatalogSha256,
} from "../listing-integrity-catalog-orchestrator.ts";
import type {
  WalmartListingIntegrityControlledPool,
  WalmartListingIntegrityControlledPoolItem,
} from "../listing-integrity-operations.ts";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const MIGRATION = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260801172000_walmart_listing_integrity_control_plane_stage_a",
  "migration.sql",
);

class TestRawClient {
  constructor(readonly db: Client) {}

  async $queryRawUnsafe<T>(sql: string, ...args: unknown[]): Promise<T> {
    const result = await this.db.execute({ sql, args: args as never[] });
    return result.rows as T;
  }

  async $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<number> {
    const result = await this.db.execute({ sql, args: args as never[] });
    return result.rowsAffected;
  }

  async $transaction<T>(operation: (client: TestRawClient) => Promise<T>): Promise<T> {
    await this.db.execute("BEGIN IMMEDIATE");
    try {
      const result = await operation(this);
      await this.db.execute("COMMIT");
      return result;
    } catch (error) {
      await this.db.execute("ROLLBACK");
      throw error;
    }
  }
}

function item(ordinal: number): WalmartListingIntegrityControlledPoolItem {
  return {
    ordinal,
    listingKey: "walmart:1:FaisalX-2000",
    storeIndex: 1,
    sku: "FaisalX-2000",
    itemId: "3EXACTWPID",
    title: "Exact Product Pack of 2",
    stage: "PRODUCT_TRUTH_READY",
    nextAction: "FRESH_SOURCE_AWARE_AUDIT",
    titleOuterCount: 2,
    deterministicFindings: ["TITLE_COUNT_REVIEW"],
    reasonCodes: [],
    productTruthBlockers: [],
    performance: {
      computedAt: null,
      units30: 0,
      sales30: 0,
      orders30: 0,
      returns30: 0,
      units90: 0,
      sales90: 0,
      orders90: 0,
      returns90: 0,
      returnRate90: null,
    },
    authority: {
      productTruthReady: true,
      freshBuyerRereadReady: false,
      repairPlanReady: false,
      ownerPermitReady: false,
      walmartWriteAuthorized: false,
    },
  };
}

function pool(): WalmartListingIntegrityControlledPool {
  const body = {
    schemaVersion: "walmart-listing-integrity-controlled-pool/v3" as const,
    createdAt: "2026-08-01T18:00:00.000Z",
    storeIndex: 1,
    source: {
      censusId: "census-test",
      censusBodySha256: H("census-body"),
      censusFileSha256: H("census-file"),
      scanPlanId: "scan-test",
      scanPlanBodySha256: H("scan-body"),
      scanPlanFileSha256: H("scan-file"),
      authoritativeManifestSha256: H("manifest"),
    },
    policy: {
      mode: "READ_ONLY_CONTROLLED_POOL" as const,
      requestedSize: 1,
      sourceRequiredPreviewSize: 0,
      strictSequence: true as const,
      maxApplyInFlight: 1 as const,
      automaticRetryAllowed: false as const,
      unknownPostReplayAllowed: false as const,
      walmartWritesAllowed: false as const,
      modelCallsAllowed: false as const,
      paidProviderCallsAllowed: false as const,
      terminalFailureMayQuarantineAndAdvance: true as const,
    },
    completedListingKeys: [],
    quarantinedListingKeys: [],
    quarantinedItems: [],
    items: [item(0)],
    sourceRequiredItems: [],
    sourceReadiness: {
      candidateCount: 1,
      repairReadyCount: 1,
      sourceRequiredCount: 0,
      quarantinedCount: 0,
    },
    externalEffects: {
      databaseReads: 1,
      databaseWrites: 0 as const,
      walmartReads: 0 as const,
      walmartWrites: 0 as const,
      modelCalls: 0 as const,
      paidProviderCalls: 0 as const,
    },
  };
  const bodySha256 = walmartListingIntegrityCatalogSha256(body);
  return {
    ...body,
    poolId: `controlled-pool-${bodySha256.slice(0, 20)}`,
    bodySha256,
  };
}

async function migrated() {
  const db = createClient({ url: "file::memory:" });
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(await readFile(MIGRATION, "utf8"));
  return { db, client: new TestRawClient(db) };
}

test("default-OFF seed and one optimistic transition persist atomically", async () => {
  const { db, client } = await migrated();
  try {
    const plan = buildWalmartListingIntegrityControlSeedPlan({
      pool: pool(),
      release_id_sha256: H("release"),
      manifest_sha256: H("release-manifest"),
      created_at: "2026-08-01T18:00:00.000Z",
    });
    const seeded = await seedWalmartListingIntegrityControlRun({ plan, client });
    assert.equal(seeded.runtimeStage, "OFF");
    assert.equal(seeded.walmartWrites, 0);

    const current = plan.items[0]!;
    const next = transitionWalmartListingIntegrityControlState({
      current,
      next_state: "DIAGNOSING",
      transitioned_at: "2026-08-01T18:01:00.000Z",
      evidence_sha256: H("diagnosis-start"),
    });
    const persisted = await persistWalmartListingIntegrityControlTransition({
      next,
      expected_current_body_sha256: current.body_sha256,
      event_type: "DIAGNOSIS_STARTED",
      client,
    });
    assert.equal(persisted.state.state, "DIAGNOSING");
    assert.equal(persisted.walmartWrites, 0);

    const rows = await db.execute(`
      SELECT state,revision,stateBodySha256 FROM WalmartListingIntegrityControlItem
    `);
    assert.deepEqual(rows.rows[0], {
      state: "DIAGNOSING",
      revision: 2,
      stateBodySha256: next.body_sha256,
    });
    const events = await db.execute(`
      SELECT sequence,eventType FROM WalmartListingIntegrityControlEvent
      ORDER BY sequence
    `);
    assert.deepEqual(events.rows, [
      { sequence: 1, eventType: "RUN_SEEDED_DEFAULT_OFF" },
      { sequence: 2, eventType: "DIAGNOSIS_STARTED" },
    ]);

    await assert.rejects(
      persistWalmartListingIntegrityControlTransition({
        next,
        expected_current_body_sha256: current.body_sha256,
        event_type: "STALE_REPLAY",
        client,
      }),
      /persisted predecessor or exact listing identity changed/,
    );
  } finally {
    db.close();
  }
});

test("persistence rejects any unresolved external predecessor", async () => {
  const { db, client } = await migrated();
  try {
    const plan = buildWalmartListingIntegrityControlSeedPlan({
      pool: pool(),
      release_id_sha256: H("release"),
      manifest_sha256: H("release-manifest"),
      created_at: "2026-08-01T18:00:00.000Z",
      external_active_listing_keys: ["walmart:1:FaisalX-1434"],
    });
    await assert.rejects(
      seedWalmartListingIntegrityControlRun({ plan, client }),
      /external predecessor is active/,
    );
  } finally {
    db.close();
  }
});

test("a fully qualified epoch closes atomically and permits one fresh successor run", async () => {
  const { db, client } = await migrated();
  try {
    const firstPlan = buildWalmartListingIntegrityControlSeedPlan({
      pool: pool(),
      release_id_sha256: H("release"),
      manifest_sha256: H("release-manifest"),
      created_at: "2026-08-01T18:00:00.000Z",
    });
    await seedWalmartListingIntegrityControlRun({ plan: firstPlan, client });
    const queued = firstPlan.items[0]!;
    const diagnosing = transitionWalmartListingIntegrityControlState({
      current: queued,
      next_state: "DIAGNOSING",
      transitioned_at: "2026-08-01T18:01:00.000Z",
      evidence_sha256: H("diagnosis"),
    });
    await persistWalmartListingIntegrityControlTransition({
      next: diagnosing,
      expected_current_body_sha256: queued.body_sha256,
      event_type: "DIAGNOSIS_STARTED",
      client,
    });
    const passed = transitionWalmartListingIntegrityControlState({
      current: diagnosing,
      next_state: "AUDITED_PASS",
      transitioned_at: "2026-08-01T18:02:00.000Z",
      evidence_sha256: H("qualified-no-change"),
    });
    await persistWalmartListingIntegrityControlTransition({
      next: passed,
      expected_current_body_sha256: diagnosing.body_sha256,
      event_type: "AUDITED_PASS",
      client,
    });
    const completion = buildWalmartListingIntegrityRunCompletionEvidence({
      run: {
        run_id: firstPlan.run.run_id,
        pool_body_sha256: firstPlan.run.pool_body_sha256,
        release_id_sha256: firstPlan.run.release_id_sha256,
        manifest_sha256: firstPlan.run.manifest_sha256,
        status: "ACTIVE",
        items: [passed],
      },
      galleries: [{
        sku: passed.identity.sku,
        published: {
          status: "GALLERY_ALREADY_PUBLISHED",
          destination: "/immutable/no-change-gallery",
          verification_file_sha256: H("verification"),
          gallery_file_sha256: H("gallery"),
        },
      }],
      completed_at: "2026-08-01T18:03:00.000Z",
    });
    const closed = await completeWalmartListingIntegrityControlRun({
      expected_run: {
        run_id: firstPlan.run.run_id,
        pool_body_sha256: firstPlan.run.pool_body_sha256,
        release_id_sha256: firstPlan.run.release_id_sha256,
        manifest_sha256: firstPlan.run.manifest_sha256,
        status: "ACTIVE",
        updated_at: firstPlan.run.created_at,
        items: [passed],
      },
      evidence_bytes: Buffer.from(`${JSON.stringify(completion)}\n`, "utf8"),
      client,
    });
    assert.equal(closed.status, "CONTROL_RUN_COMPLETED");
    assert.equal(closed.walmart_writes, 0);
    const firstRun = await db.execute({
      sql: "SELECT status FROM WalmartListingIntegrityControlRun WHERE runId=?",
      args: [firstPlan.run.run_id],
    });
    assert.equal(firstRun.rows[0]?.status, "COMPLETED");
    const completionRows = await db.execute(`
      SELECT role FROM WalmartListingIntegrityControlArtifact
      WHERE runId='${firstPlan.run.run_id}' AND itemControlId IS NULL
    `);
    assert.deepEqual(completionRows.rows, [{ role: "RUN_COMPLETION_EVIDENCE" }]);
    const secondPlan = buildWalmartListingIntegrityControlSeedPlan({
      pool: pool(),
      release_id_sha256: H("release"),
      manifest_sha256: H("release-manifest"),
      created_at: "2026-08-01T18:04:00.000Z",
    });
    const second = await seedWalmartListingIntegrityControlRun({ plan: secondPlan, client });
    assert.notEqual(second.runId, firstPlan.run.run_id);
    assert.equal(second.walmartWrites, 0);
  } finally {
    db.close();
  }
});
