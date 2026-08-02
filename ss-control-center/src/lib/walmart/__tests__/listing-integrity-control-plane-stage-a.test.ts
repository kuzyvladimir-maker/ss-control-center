import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createClient, type Client } from "@libsql/client";

const H = (value: string) => value.repeat(64).slice(0, 64);
const MIGRATION = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260801172000_walmart_listing_integrity_control_plane_stage_a",
  "migration.sql",
);

async function migrated(): Promise<Client> {
  const db = createClient({ url: "file::memory:" });
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(await readFile(MIGRATION, "utf8"));
  return db;
}

async function insertRun(db: Client, runId = "wlirun-1") {
  await db.execute({
    sql: `INSERT INTO "WalmartListingIntegrityControlRun" (
      runId,schemaVersion,poolBodySha256,releaseIdSha256,manifestSha256,
      runtimeStage,status,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [
      runId,
      "walmart-listing-integrity-control-run/v1",
      H("a"), H("b"), H("c"), "OFF", "ACTIVE",
      "2026-08-01T17:00:00.000Z", "2026-08-01T17:00:00.000Z",
    ],
  });
}

async function insertQueued(db: Client, ordinal: number, runId = "wlirun-1") {
  await db.execute({
    sql: `INSERT INTO "WalmartListingIntegrityControlItem" (
      itemControlId,runId,ordinal,listingKey,sku,itemId,storeIndex,state,
      revision,stateBodySha256,previousStateSha256,evidenceSha256,
      marketplaceWriteCalls,automaticRetryAllowed,automaticReplayAllowed,
      transitionedAt,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      `${runId}-item-${ordinal}`, runId, ordinal,
      `walmart:1:FaisalX-${1143 + ordinal}`, `FaisalX-${1143 + ordinal}`,
      String(8394316917 + ordinal), 1, "QUEUED", 1, H(String(ordinal)), null,
      H("d"), 0, false, false,
      "2026-08-01T17:00:00.000Z", "2026-08-01T17:00:00.000Z",
      "2026-08-01T17:00:00.000Z",
    ],
  });
}

async function transition(db: Client, input: {
  itemControlId: string;
  nextState: string;
  oldBody: string;
  newBody: string;
  revision: number;
  packageSha?: string | null;
  permitSha?: string | null;
  feedId?: string | null;
  writes?: number;
}) {
  await db.execute({
    sql: `UPDATE "WalmartListingIntegrityControlItem" SET
      state=?, revision=?, previousStateSha256=?, stateBodySha256=?,
      evidenceSha256=?, executionPackageSha256=COALESCE(?,executionPackageSha256),
      ownerPermitSha256=COALESCE(?,ownerPermitSha256),
      feedId=COALESCE(?,feedId), marketplaceWriteCalls=?,
      transitionedAt=?, updatedAt=? WHERE itemControlId=?`,
    args: [
      input.nextState, input.revision, input.oldBody, input.newBody, H("e"),
      input.packageSha ?? null, input.permitSha ?? null, input.feedId ?? null,
      input.writes ?? 0, "2026-08-01T17:01:00.000Z",
      "2026-08-01T17:01:00.000Z", input.itemControlId,
    ],
  });
}

test("Stage A migration is durable and hardcodes runtime OFF", async () => {
  const db = await migrated();
  try {
    await insertRun(db);
    await assert.rejects(
      db.execute(`UPDATE "WalmartListingIntegrityControlRun"
        SET runtimeStage='ONE_SKU' WHERE runId='wlirun-1'`),
      /constraint|immutable/iu,
    );
    await assert.rejects(
      db.execute("DELETE FROM WalmartListingIntegrityControlRun WHERE runId='wlirun-1'"),
      /cannot be deleted/iu,
    );
  } finally {
    db.close();
  }
});

test("SQL permits only one ACTIVE control run", async () => {
  const db = await migrated();
  await insertRun(db, "wlirun-1");
  await assert.rejects(
    insertRun(db, "wlirun-2"),
    /UNIQUE constraint failed: WalmartListingIntegrityControlRun.status/,
  );
  await db.execute(
    "UPDATE WalmartListingIntegrityControlRun SET status='PAUSED',updatedAt='2026-08-01T17:01:00.000Z' WHERE runId='wlirun-1'",
  );
  await insertRun(db, "wlirun-2");
  const rows = await db.execute(
    "SELECT runId,status FROM WalmartListingIntegrityControlRun ORDER BY runId",
  );
  assert.deepEqual(rows.rows, [
    { runId: "wlirun-1", status: "PAUSED" },
    { runId: "wlirun-2", status: "ACTIVE" },
  ]);
});

test("SQL state machine enforces strict sequence and immutable terminal items", async () => {
  const db = await migrated();
  try {
    await insertRun(db);
    await insertQueued(db, 1);
    await insertQueued(db, 2);
    await assert.rejects(transition(db, {
      itemControlId: "wlirun-1-item-2",
      nextState: "DIAGNOSING",
      oldBody: H("2"),
      newBody: H("f"),
      revision: 2,
    }), /predecessor is not terminal/iu);

    await transition(db, {
      itemControlId: "wlirun-1-item-1",
      nextState: "DIAGNOSING",
      oldBody: H("1"),
      newBody: H("f"),
      revision: 2,
    });
    await transition(db, {
      itemControlId: "wlirun-1-item-1",
      nextState: "AUDITED_PASS",
      oldBody: H("f"),
      newBody: H("9"),
      revision: 3,
    });
    await assert.rejects(transition(db, {
      itemControlId: "wlirun-1-item-1",
      nextState: "DIAGNOSING",
      oldBody: H("9"),
      newBody: H("8"),
      revision: 4,
    }), /terminal item is immutable|transition is not permitted/iu);
    await assert.doesNotReject(transition(db, {
      itemControlId: "wlirun-1-item-2",
      nextState: "DIAGNOSING",
      oldBody: H("2"),
      newBody: H("7"),
      revision: 2,
    }));
  } finally {
    db.close();
  }
});

test("SQL guard permits only one globally in-flight apply", async () => {
  const db = await migrated();
  try {
    await insertRun(db, "wlirun-a");
    const insertApply = (ordinal: number) => db.execute({
      sql: `INSERT INTO "WalmartListingIntegrityControlItem" (
        itemControlId,runId,ordinal,listingKey,sku,itemId,storeIndex,state,
        revision,stateBodySha256,evidenceSha256,executionPackageSha256,
        ownerPermitSha256,marketplaceWriteCalls,automaticRetryAllowed,
        automaticReplayAllowed,transitionedAt,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        `wlirun-a-item-${ordinal}`, "wlirun-a", ordinal,
        `walmart:1:sku-${ordinal}`, `sku-${ordinal}`, String(ordinal), 1,
        "APPLY_REQUESTING", 1, H("a"), H("b"), H("c"), H("d"), 0,
        false, false, "2026-08-01T17:00:00.000Z",
        "2026-08-01T17:00:00.000Z", "2026-08-01T17:00:00.000Z",
      ],
    });
    await insertApply(1);
    await assert.rejects(insertApply(2), /one live apply globally/iu);
  } finally {
    db.close();
  }
});

test("event and artifact custody is append-only with exact event predecessor", async () => {
  const db = await migrated();
  try {
    await insertRun(db);
    await db.execute({
      sql: `INSERT INTO "WalmartListingIntegrityControlEvent" (
        eventId,runId,sequence,schemaVersion,eventType,occurredAt,payload,
        payloadSha256,previousEventHash,eventHash,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "event-1", "wlirun-1", 1,
        "walmart-listing-integrity-control-event/v1", "RUN_CREATED",
        "2026-08-01T17:00:00.000Z", new Uint8Array([1]), H("1"), H("0"),
        H("a"), "2026-08-01T17:00:00.000Z",
      ],
    });
    await assert.rejects(db.execute({
      sql: `INSERT INTO "WalmartListingIntegrityControlEvent" (
        eventId,runId,sequence,schemaVersion,eventType,occurredAt,payload,
        payloadSha256,previousEventHash,eventHash,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "event-2", "wlirun-1", 2,
        "walmart-listing-integrity-control-event/v1", "BAD_CHAIN",
        "2026-08-01T17:01:00.000Z", new Uint8Array([2]), H("2"), H("b"),
        H("c"), "2026-08-01T17:01:00.000Z",
      ],
    }), /event chain is invalid/iu);
    await assert.rejects(
      db.execute("UPDATE WalmartListingIntegrityControlEvent SET eventType='X' WHERE eventId='event-1'"),
      /append-only/iu,
    );

    await db.execute({
      sql: `INSERT INTO "WalmartListingIntegrityControlArtifact" (
        artifactId,runId,role,mediaType,byteSize,sha256,locator,createdAt,
        createdByPrincipal
      ) VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [
        "artifact-1", "wlirun-1", "POOL", "application/json", 1, H("a"),
        "sha256:a", "2026-08-01T17:00:00.000Z", "codex",
      ],
    });
    await assert.rejects(
      db.execute("DELETE FROM WalmartListingIntegrityControlArtifact WHERE artifactId='artifact-1'"),
      /append-only/iu,
    );
  } finally {
    db.close();
  }
});

test("SQL permits a sealed LIVE_REREAD revision for pending propagation", async () => {
  const db = await migrated();
  await insertRun(db);
  await insertQueued(db, 1);

  const states = [
    "DIAGNOSING",
    "ISSUE_PROVEN",
    "REPAIR_PLANNED",
    "AWAITING_OWNER",
    "OWNER_APPROVED",
    "APPLY_REQUESTING",
    "APPLIED",
    "PROPAGATING",
    "LIVE_REREAD",
  ];
  let body = H("1");
  let revision = 1;
  for (const nextState of states) {
    const nextBody = H(String(revision + 1));
    await transition(db, {
      itemControlId: "wlirun-1-item-1",
      nextState,
      oldBody: body,
      newBody: nextBody,
      revision: revision + 1,
      packageSha: ["REPAIR_PLANNED", "AWAITING_OWNER", "OWNER_APPROVED", "APPLY_REQUESTING", "APPLIED", "PROPAGATING", "LIVE_REREAD"].includes(nextState)
        ? H("b") : null,
      permitSha: ["OWNER_APPROVED", "APPLY_REQUESTING", "APPLIED", "PROPAGATING", "LIVE_REREAD"].includes(nextState)
        ? H("c") : null,
      feedId: ["APPLIED", "PROPAGATING", "LIVE_REREAD"].includes(nextState)
        ? "feed-1" : null,
      writes: ["APPLIED", "PROPAGATING", "LIVE_REREAD"].includes(nextState) ? 1 : 0,
    });
    revision += 1;
    body = nextBody;
  }

  const pendingBody = H("f");
  await transition(db, {
    itemControlId: "wlirun-1-item-1",
    nextState: "LIVE_REREAD",
    oldBody: body,
    newBody: pendingBody,
    revision: revision + 1,
    packageSha: H("b"),
    permitSha: H("c"),
    feedId: "feed-1",
    writes: 1,
  });
  const result = await db.execute(
    "SELECT state,revision,previousStateSha256,stateBodySha256 FROM WalmartListingIntegrityControlItem WHERE itemControlId='wlirun-1-item-1'",
  );
  assert.deepEqual(result.rows[0], {
    state: "LIVE_REREAD",
    revision: revision + 1,
    previousStateSha256: body,
    stateBodySha256: pendingBody,
  });

  await assert.rejects(transition(db, {
    itemControlId: "wlirun-1-item-1",
    nextState: "PROPAGATING",
    oldBody: pendingBody,
    newBody: H("8"),
    revision: revision + 2,
    packageSha: H("b"),
    permitSha: H("c"),
    feedId: "feed-1",
    writes: 1,
  }), /transition is not permitted/iu);
});
