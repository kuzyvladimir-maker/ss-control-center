import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import { PHASE1_SCOPE_MANIFEST_VERSION } from "../phase1-scope-manifest";
import {
  PRODUCT_TRUTH_OPERATIONAL_FIELDS,
  PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
  type ProductTruthOperationalPlan,
} from "../product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR,
  ProductTruthOperationalStoreError,
  acquireProductTruthOperationalRunLease,
  assertProductTruthOperationalRunSchema,
  bindProductTruthOperationalQueueJob,
  claimNextProductTruthOperationalItem,
  finishProductTruthOperationalRun,
  getProductTruthOperationalRun,
  heartbeatProductTruthOperationalItemLease,
  listProductTruthOperationalEvents,
  listProductTruthOperationalRunItems,
  reapExpiredProductTruthOperationalEnvironmentRun,
  reapExpiredProductTruthOperationalRun,
  seedProductTruthOperationalRun,
  startProductTruthOperationalAttempt,
  terminalizeProductTruthOperationalAttempt,
  terminalizeProductTruthOperationalPreAttempt,
  transitionProductTruthOperationalItem,
  type StoredProductTruthOperationalRunItem,
} from "../product-truth-operational-run-store";
import { PRODUCT_TRUTH_LISTING_KEY_VERSION } from "../product-truth-listing-scope";

const T0 = "2099-01-01T00:00:00.000Z";
const MANIFEST_SHA = "1".repeat(64);
const TARGET_FINGERPRINT = "2".repeat(64);
const TARGET_SET_SHA = "3".repeat(64);
const REPORT_SHA = "4".repeat(64);
const ARTIFACT_SHA = "5".repeat(64);

const meteredMigrationUrl = new URL(
  "../../../../prisma/migrations/20260719000000_metered_budget_ledger/migration.sql",
  import.meta.url,
);
const operationalMigrationUrl = new URL(
  "../../../../prisma/migrations/20260719004000_product_truth_operational_run/migration.sql",
  import.meta.url,
);

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1_000).toISOString();
}

function plan(runId = "operational-store-run-a", sku = "EXACT-SKU"): ProductTruthOperationalPlan {
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
    runId,
    mode: "WAVE",
    createdAt: T0,
    expiresAt: at(3_600),
    targetFingerprint: TARGET_FINGERPRINT,
    manifest: {
      schemaVersion: PHASE1_SCOPE_MANIFEST_VERSION,
      sha256: MANIFEST_SHA,
      asOf: T0,
      liveListings: 1,
    },
    targetSetSha256: TARGET_SET_SHA,
    targets: [{
      ordinal: 0,
      listingKey: `amazon:1:${sku}`,
      listingKeyVersion: PRODUCT_TRUTH_LISTING_KEY_VERSION,
      channel: "amazon",
      storeIndex: 1,
      sku,
      requestedFields: PRODUCT_TRUTH_OPERATIONAL_FIELDS,
    }],
    sourcePolicy: {
      procurementZip: "33765",
      retailers: ["walmart", "target", "publix"],
      allowClubs: false,
      allowBjs: false,
      listingConcurrency: 1,
      componentConcurrency: 1,
      maxAttemptsPerListing: 1,
    },
    providerCeilings: [{
      provider: "unwrangle",
      operations: ["detail", "search"],
      maxCalls: 2,
      maxUnits: 2,
      reserveFloor: 1_000,
    }],
    verificationPolicy: {
      maxPriceAgeMs: 24 * 60 * 60 * 1_000,
      minGalleryImages: 5,
    },
    maxWallClockMs: 30 * 60 * 1_000,
    claims: {
      defaultDryRun: true,
      automaticPublish: false,
      automaticDelist: false,
      automaticReprice: false,
      automaticPurchase: false,
    },
  };
}

async function migratedDb(): Promise<Client> {
  const db = createClient({ url: "file::memory:?cache=shared", concurrency: 1 });
  await db.execute("PRAGMA foreign_keys=OFF");
  await db.executeMultiple(`
    DROP TABLE IF EXISTS "ProductTruthOperationalEvent";
    DROP TABLE IF EXISTS "ProductTruthOperationalRunItem";
    DROP TABLE IF EXISTS "ProductTruthOperationalRun";
    DROP TABLE IF EXISTS "EnrichmentJob";
    DROP TABLE IF EXISTS "ProductTruthListingScope";
    DROP TABLE IF EXISTS "MeteredReservationSettlement";
    DROP TABLE IF EXISTS "MeteredReservationReceipt";
    DROP TABLE IF EXISTS "MeteredProviderBudget";
  `);
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(await readFile(meteredMigrationUrl, "utf8"));
  await db.executeMultiple(`
    CREATE TABLE "ProductTruthListingScope" (
      "listingKey" TEXT NOT NULL PRIMARY KEY,
      "keyVersion" TEXT NOT NULL,
      "channel" TEXT NOT NULL,
      "storeIndex" INTEGER NOT NULL,
      "sku" TEXT NOT NULL,
      "manifestSha256" TEXT NOT NULL
    );
    CREATE TABLE "EnrichmentJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "targetType" TEXT NOT NULL,
      "target" TEXT NOT NULL,
      "normalizedTarget" TEXT,
      "listingKey" TEXT,
      "idempotencyKey" TEXT,
      "requestedFields" TEXT NOT NULL DEFAULT '[]',
      "status" TEXT NOT NULL DEFAULT 'queued',
      "source" TEXT NOT NULL DEFAULT 'manual',
      "priority" INTEGER NOT NULL DEFAULT 0,
      "requestedBy" TEXT,
      "runId" TEXT,
      "approvalId" TEXT,
      "estimatedSpendUnits" REAL NOT NULL DEFAULT 0,
      "actualSpendUnits" REAL NOT NULL DEFAULT 0,
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "providerAttempts" TEXT,
      "result" TEXT,
      "error" TEXT,
      "terminalReason" TEXT,
      "completedFields" TEXT,
      "unavailableFields" TEXT,
      "checkpoint" TEXT,
      "nextEligibleAt" DATETIME,
      "leaseOwner" TEXT,
      "leaseToken" TEXT,
      "leaseExpiresAt" DATETIME,
      "heartbeatAt" DATETIME,
      "queuedAt" DATETIME,
      "startedAt" DATETIME,
      "finishedAt" DATETIME,
      "createdAt" DATETIME,
      "updatedAt" DATETIME,
      FOREIGN KEY ("listingKey") REFERENCES "ProductTruthListingScope"("listingKey")
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );
  `);
  await db.executeMultiple(await readFile(operationalMigrationUrl, "utf8"));
  const tables = await db.execute({
    sql: `SELECT "name" FROM sqlite_schema WHERE "type"='table' AND "name" IN (?,?,?,?,?)`,
    args: [
      "ProductTruthListingScope",
      "EnrichmentJob",
      "MeteredProviderBudget",
      "ProductTruthOperationalRun",
      "ProductTruthOperationalRunItem",
    ],
  });
  assert.equal(tables.rows.length, 5);
  return db;
}

async function registerScope(db: Client, value: ProductTruthOperationalPlan): Promise<void> {
  const available = await db.execute({
    sql: `SELECT "name" FROM sqlite_schema WHERE "type"='table' ORDER BY "name"`,
    args: [],
  });
  assert.ok(
    available.rows.some((row) => row.name === "ProductTruthListingScope"),
    `fixture schema disappeared: ${available.rows.map((row) => String(row.name)).join(",")}`,
  );
  for (const target of value.targets) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO "ProductTruthListingScope"
            ("listingKey","keyVersion","channel","storeIndex","sku","manifestSha256")
            VALUES (?,?,?,?,?,?)`,
      args: [
        target.listingKey,
        target.listingKeyVersion,
        target.channel,
        target.storeIndex,
        target.sku,
        value.manifest.sha256,
      ],
    });
  }
}

async function seed(
  db: Client,
  value = plan(),
  approvalId = `approval-${value.runId}`,
) {
  await registerScope(db, value);
  return seedProductTruthOperationalRun(db, {
    plan: value,
    approvalId,
    environment: "local-test",
    at: T0,
  });
}

async function acquire(db: Client, value: ProductTruthOperationalPlan, suffix = "a") {
  return acquireProductTruthOperationalRunLease(db, {
    runId: value.runId,
    leaseOwner: `worker-${suffix}`,
    leaseToken: `run-lease-${suffix}`,
    at: at(1),
    leaseExpiresAt: at(300),
  });
}

async function claim(
  db: Client,
  value: ProductTruthOperationalPlan,
  suffix = "a",
): Promise<StoredProductTruthOperationalRunItem> {
  const item = await claimNextProductTruthOperationalItem(db, {
    runId: value.runId,
    runLeaseToken: `run-lease-${suffix}`,
    itemLeaseToken: `item-lease-${suffix}`,
    at: at(2),
    leaseExpiresAt: at(300),
  });
  assert.ok(item);
  return item;
}

async function insertQueueJob(
  db: Client,
  value: ProductTruthOperationalPlan,
  id = `queue-${value.runId}`,
): Promise<string> {
  const target = value.targets[0];
  await db.execute({
    sql: `INSERT INTO "EnrichmentJob"
          ("id","targetType","target","normalizedTarget","listingKey","idempotencyKey",
           "requestedFields","status","source","runId","approvalId","estimatedSpendUnits",
           "actualSpendUnits","attempts","nextEligibleAt","queuedAt","createdAt","updatedAt")
          VALUES (?, 'sku', ?, ?, ?, ?, ?, 'queued', 'product-truth-operational-runner',
                  ?, ?, 2, 0, 0, ?, ?, ?, ?)`,
    args: [
      id,
      target.sku,
      target.sku,
      target.listingKey,
      "6".repeat(64),
      JSON.stringify([...target.requestedFields].sort()),
      value.runId,
      `approval-${value.runId}`,
      at(2),
      at(2),
      at(2),
      at(2),
    ],
  });
  return id;
}

async function claimQueueJob(db: Client, id: string, leaseToken = "queue-lease-a"): Promise<void> {
  const result = await db.execute({
    sql: `UPDATE "EnrichmentJob"
          SET "status"='running',"attempts"=1,"leaseOwner"='queue-worker',
              "leaseToken"=?,"leaseExpiresAt"=?,"heartbeatAt"=?,
              "startedAt"=COALESCE("startedAt",?),"updatedAt"=?
          WHERE "id"=? AND "status"='queued' AND "attempts"=0`,
    args: [leaseToken, at(300), at(3), at(3), at(3), id],
  });
  assert.equal(result.rowsAffected, 1);
}

async function prepareAttempt(
  db: Client,
  value: ProductTruthOperationalPlan,
  item: StoredProductTruthOperationalRunItem,
): Promise<StoredProductTruthOperationalRunItem> {
  const queueJobId = await insertQueueJob(db, value);
  let current = await bindProductTruthOperationalQueueJob(db, {
    item,
    queueJobId,
    runLeaseToken: "run-lease-a",
    itemLeaseToken: "item-lease-a",
    at: at(2),
  });
  current = await transitionProductTruthOperationalItem(db, {
    item: current,
    runLeaseToken: "run-lease-a",
    leaseToken: "item-lease-a",
    nextStatus: "reuse_checked",
    stage: "REUSE_CHECKED",
    at: at(3),
    checkpoint: { reused: false },
  });
  const started = await startProductTruthOperationalAttempt(db, {
    item: current,
    runLeaseToken: "run-lease-a",
    itemLeaseToken: "item-lease-a",
    queueLeaseOwner: "queue-worker",
    queueLeaseToken: "queue-lease-a",
    at: at(4),
    checkpoint: { attemptBoundary: true },
  });
  return started.item;
}

describe("Product Truth operational run store", { concurrency: false }, () => {
test("fails closed when schema or any required guard is absent", async () => {
  const absent = createClient({ url: "file::memory:?cache=shared", concurrency: 1 });
  await absent.execute("PRAGMA foreign_keys=ON");
  try {
    await assert.rejects(
      assertProductTruthOperationalRunSchema(absent),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR,
    );
  } finally {
    await absent.close();
  }

  const db = await migratedDb();
  try {
    await assertProductTruthOperationalRunSchema(db);
    await db.execute(`DROP TRIGGER "ProductTruthOperationalRunItem_attempt_queue_guard"`);
    await assert.rejects(
      assertProductTruthOperationalRunSchema(db),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR
        && error.cause instanceof Error
        && error.cause.message.includes("ProductTruthOperationalRunItem_attempt_queue_guard"),
    );
  } finally {
    await db.close();
  }
});

test("sealed seed is canonical/idempotent and rejects any changed plan identity", async () => {
  const db = await migratedDb();
  const value = plan();
  try {
    const first = await seed(db, value);
    const second = await seed(db, value);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.run.planJson.endsWith("\n"), true);
    assert.equal(second.run.sourcePolicyJson.endsWith("\n"), true);
    assert.equal(second.run.providerCeilingsJson.endsWith("\n"), true);
    assert.equal(second.items.length, 1);
    assert.deepEqual(second.items[0].requestedFields, PRODUCT_TRUTH_OPERATIONAL_FIELDS);
    assert.equal((await listProductTruthOperationalEvents(db, value.runId)).length, 1);

    await assert.rejects(
      seedProductTruthOperationalRun(db, {
        plan: { ...value, maxWallClockMs: value.maxWallClockMs + 1 },
        approvalId: `approval-${value.runId}`,
        environment: "local-test",
        at: at(10),
      }),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === "OPERATIONAL_RUN_CONFLICT",
    );
  } finally {
    await db.close();
  }
});

test("one environment has one run lease and interrupted release permits the next run", async () => {
  const db = await migratedDb();
  const first = plan("environment-run-a");
  const second = plan("environment-run-b");
  try {
    await seed(db, first);
    await seed(db, second);
    await acquire(db, first, "first");
    await assert.rejects(
      acquire(db, second, "second"),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === "OPERATIONAL_RUN_LOCK_HELD",
    );
    const interrupted = await finishProductTruthOperationalRun(db, {
      runId: first.runId,
      leaseToken: "run-lease-first",
      status: "interrupted",
      at: at(10),
    });
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.finishedAt, null);
    const next = await acquireProductTruthOperationalRunLease(db, {
      runId: second.runId,
      leaseOwner: "worker-second",
      leaseToken: "run-lease-second",
      at: at(11),
      leaseExpiresAt: at(301),
    });
    assert.equal(next.status, "running");
  } finally {
    await db.close();
  }
});

test("environment recovery reaps an expired executor without its approval and frees the lock", async () => {
  const db = await migratedDb();
  const expired = plan("expired-environment-run");
  const next = plan("next-environment-run");
  try {
    await seed(db, expired);
    await seed(db, next);
    await acquireProductTruthOperationalRunLease(db, {
      runId: expired.runId,
      leaseOwner: "expired-worker",
      leaseToken: "expired-run-lease",
      at: at(1),
      leaseExpiresAt: at(60),
    });

    const notExpired = await reapExpiredProductTruthOperationalEnvironmentRun(db, {
      environment: "local-test",
      at: at(59),
    });
    assert.equal(notExpired.status, "not_expired");
    assert.equal(notExpired.run?.runId, expired.runId);

    const reaped = await reapExpiredProductTruthOperationalEnvironmentRun(db, {
      environment: "local-test",
      at: at(61),
    });
    assert.equal(reaped.status, "interrupted");
    assert.equal(reaped.run?.status, "interrupted");

    const acquired = await acquireProductTruthOperationalRunLease(db, {
      runId: next.runId,
      leaseOwner: "next-worker",
      leaseToken: "next-run-lease",
      at: at(62),
      leaseExpiresAt: at(300),
    });
    assert.equal(acquired.status, "running");
    assert.equal(acquired.runId, next.runId);
  } finally {
    await db.close();
  }
});

test("atomic pre-attempt terminalization reconciles a committed durable queue binding", async () => {
  const db = await migratedDb();
  const value = plan("pre-attempt-bound-run");
  try {
    await seed(db, value);
    await acquire(db, value);
    let staleItem = await claim(db, value);
    staleItem = await transitionProductTruthOperationalItem(db, {
      item: staleItem,
      runLeaseToken: "run-lease-a",
      leaseToken: "item-lease-a",
      nextStatus: "reuse_checked",
      stage: "REUSE_CHECKED",
      at: at(3),
    });
    const queueJobId = await insertQueueJob(db, value);
    await bindProductTruthOperationalQueueJob(db, {
      item: staleItem,
      queueJobId,
      runLeaseToken: "run-lease-a",
      itemLeaseToken: "item-lease-a",
      at: at(4),
    });
    assert.equal(staleItem.queueJobId, null);

    const terminal = await terminalizeProductTruthOperationalPreAttempt(db, {
      item: staleItem,
      runLeaseToken: "run-lease-a",
      itemLeaseToken: "item-lease-a",
      itemStatus: "failed",
      stage: "PRE_ATTEMPT_FAILED",
      at: at(5),
      result: { outcome: "FAILED", reason: "bind response was lost" },
      checkpoint: { stage: "PRE_ATTEMPT_TERMINAL" },
      error: "bind response was lost",
    });
    assert.equal(terminal.item.status, "failed");
    assert.equal(terminal.item.attempts, 0);
    assert.equal(terminal.item.queueJobId, queueJobId);
    assert.deepEqual(terminal.queue, {
      id: queueJobId,
      status: "cancelled",
      attempts: 0,
      cancelled: true,
    });
    const queue = await db.execute({
      sql: `SELECT "status","attempts","terminalReason","result","checkpoint"
            FROM "EnrichmentJob" WHERE "id"=?`,
      args: [queueJobId],
    });
    assert.deepEqual(
      [queue.rows[0]?.status, queue.rows[0]?.attempts, queue.rows[0]?.terminalReason],
      ["cancelled", 0, "PRE_ATTEMPT_ABORTED"],
    );
    assert.equal(String(queue.rows[0]?.result).endsWith("\n"), true);
    assert.equal(String(queue.rows[0]?.checkpoint).endsWith("\n"), true);
    assert.equal(
      (await listProductTruthOperationalEvents(db, value.runId)).at(-1)?.eventType,
      "PRE_ATTEMPT_TERMINALIZED",
    );
  } finally {
    await db.close();
  }
});

test("atomic pre-attempt terminalization discovers and binds an unobserved enqueued intent", async () => {
  const db = await migratedDb();
  const value = plan("pre-attempt-unbound-run");
  try {
    await seed(db, value);
    await acquire(db, value);
    let item = await claim(db, value);
    item = await transitionProductTruthOperationalItem(db, {
      item,
      runLeaseToken: "run-lease-a",
      leaseToken: "item-lease-a",
      nextStatus: "reuse_checked",
      stage: "REUSE_CHECKED",
      at: at(3),
    });
    const queueJobId = await insertQueueJob(db, value);
    assert.equal(item.queueJobId, null);

    const terminal = await terminalizeProductTruthOperationalPreAttempt(db, {
      item,
      runLeaseToken: "run-lease-a",
      itemLeaseToken: "item-lease-a",
      itemStatus: "blocked",
      stage: "PRE_ATTEMPT_BLOCKED",
      at: at(4),
      result: { outcome: "BLOCKED", reason: "enqueue response was lost" },
      checkpoint: { stage: "PRE_ATTEMPT_TERMINAL" },
      error: "enqueue response was lost",
    });
    assert.equal(terminal.item.status, "blocked");
    assert.equal(terminal.item.queueJobId, queueJobId);
    assert.equal(terminal.queue?.cancelled, true);
    const queue = await db.execute({
      sql: `SELECT "status","attempts" FROM "EnrichmentJob" WHERE "id"=?`,
      args: [queueJobId],
    });
    assert.deepEqual([queue.rows[0]?.status, queue.rows[0]?.attempts], ["cancelled", 0]);
  } finally {
    await db.close();
  }
});

test("pre-attempt terminalization rolls back when either queue or item crossed attempt one", async () => {
  const db = await migratedDb();
  const value = plan("pre-attempt-crossed-run");
  try {
    await seed(db, value);
    await acquire(db, value);
    let item = await claim(db, value);
    item = await prepareAttempt(db, value, item);
    await assert.rejects(
      terminalizeProductTruthOperationalPreAttempt(db, {
        item: { ...item, attempts: 0 },
        runLeaseToken: "run-lease-a",
        itemLeaseToken: "item-lease-a",
        itemStatus: "failed",
        stage: "PRE_ATTEMPT_FAILED",
        at: at(5),
        result: { outcome: "FAILED" },
        checkpoint: { stage: "PRE_ATTEMPT_TERMINAL" },
        error: "must not replay",
      }),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === "OPERATIONAL_ATTEMPT_ALREADY_STARTED",
    );
    const stored = (await listProductTruthOperationalRunItems(db, value.runId))[0];
    assert.equal(stored.status, "costing");
    const queue = await db.execute({
      sql: `SELECT "status","attempts" FROM "EnrichmentJob" WHERE "id"=?`,
      args: [stored.queueJobId!],
    });
    assert.deepEqual([queue.rows[0]?.status, queue.rows[0]?.attempts], ["running", 1]);
  } finally {
    await db.close();
  }
});

test("safe expiry cancels an unbound enqueue, clears binding, and permits fresh intent", async () => {
  const db = await migratedDb();
  const value = plan("safe-unbound-expiry-run");
  try {
    await seed(db, value);
    await acquireProductTruthOperationalRunLease(db, {
      runId: value.runId,
      leaseOwner: "safe-worker",
      leaseToken: "safe-run-lease",
      at: at(1),
      leaseExpiresAt: at(60),
    });
    let item = await claimNextProductTruthOperationalItem(db, {
      runId: value.runId,
      runLeaseToken: "safe-run-lease",
      itemLeaseToken: "safe-item-lease",
      at: at(2),
      leaseExpiresAt: at(60),
    });
    assert.ok(item);
    item = await transitionProductTruthOperationalItem(db, {
      item,
      runLeaseToken: "safe-run-lease",
      leaseToken: "safe-item-lease",
      nextStatus: "reuse_checked",
      stage: "REUSE_CHECKED",
      at: at(3),
    });
    const abandonedQueueJobId = await insertQueueJob(db, value, "queue-abandoned-before-bind");
    assert.equal(item.queueJobId, null);

    const reaped = await reapExpiredProductTruthOperationalRun(db, {
      runId: value.runId,
      at: at(61),
    });
    assert.equal(reaped.status, "interrupted");
    const released = (await listProductTruthOperationalRunItems(db, value.runId))[0];
    assert.equal(released.status, "pending");
    assert.equal(released.queueJobId, null);
    const abandoned = await db.execute({
      sql: `SELECT "status","attempts","actualSpendUnits","terminalReason"
            FROM "EnrichmentJob" WHERE "id"=?`,
      args: [abandonedQueueJobId],
    });
    assert.deepEqual(
      [
        abandoned.rows[0]?.status,
        abandoned.rows[0]?.attempts,
        abandoned.rows[0]?.actualSpendUnits,
        abandoned.rows[0]?.terminalReason,
      ],
      ["cancelled", 0, 0, "PRE_ATTEMPT_ABORTED"],
    );

    await acquireProductTruthOperationalRunLease(db, {
      runId: value.runId,
      leaseOwner: "safe-resume-worker",
      leaseToken: "safe-resume-run-lease",
      at: at(62),
      leaseExpiresAt: at(300),
    });
    let resumed = await claimNextProductTruthOperationalItem(db, {
      runId: value.runId,
      runLeaseToken: "safe-resume-run-lease",
      itemLeaseToken: "safe-resume-item-lease",
      at: at(63),
      leaseExpiresAt: at(300),
    });
    assert.ok(resumed);
    resumed = await transitionProductTruthOperationalItem(db, {
      item: resumed,
      runLeaseToken: "safe-resume-run-lease",
      leaseToken: "safe-resume-item-lease",
      nextStatus: "reuse_checked",
      stage: "REUSE_CHECKED",
      at: at(64),
    });
    const replacementQueueJobId = await insertQueueJob(db, value, "queue-safe-replacement");
    const rebound = await bindProductTruthOperationalQueueJob(db, {
      item: resumed,
      queueJobId: replacementQueueJobId,
      runLeaseToken: "safe-resume-run-lease",
      itemLeaseToken: "safe-resume-item-lease",
      at: at(65),
    });
    assert.equal(rebound.queueJobId, replacementQueueJobId);
  } finally {
    await db.close();
  }
});

test("safe expiry clears a durable pre-attempt queue binding after cancellation", async () => {
  const db = await migratedDb();
  const value = plan("safe-bound-expiry-run");
  try {
    await seed(db, value);
    await acquireProductTruthOperationalRunLease(db, {
      runId: value.runId,
      leaseOwner: "bound-worker",
      leaseToken: "bound-run-lease",
      at: at(1),
      leaseExpiresAt: at(60),
    });
    let item = await claimNextProductTruthOperationalItem(db, {
      runId: value.runId,
      runLeaseToken: "bound-run-lease",
      itemLeaseToken: "bound-item-lease",
      at: at(2),
      leaseExpiresAt: at(60),
    });
    assert.ok(item);
    item = await transitionProductTruthOperationalItem(db, {
      item,
      runLeaseToken: "bound-run-lease",
      leaseToken: "bound-item-lease",
      nextStatus: "reuse_checked",
      stage: "REUSE_CHECKED",
      at: at(3),
    });
    const queueJobId = await insertQueueJob(db, value, "queue-bound-before-expiry");
    item = await bindProductTruthOperationalQueueJob(db, {
      item,
      queueJobId,
      runLeaseToken: "bound-run-lease",
      itemLeaseToken: "bound-item-lease",
      at: at(4),
    });
    assert.equal(item.queueJobId, queueJobId);

    const reaped = await reapExpiredProductTruthOperationalRun(db, {
      runId: value.runId,
      at: at(61),
    });
    assert.equal(reaped.status, "interrupted");
    const released = (await listProductTruthOperationalRunItems(db, value.runId))[0];
    assert.equal(released.status, "pending");
    assert.equal(released.queueJobId, null);
    const queue = await db.execute({
      sql: `SELECT "status","attempts","actualSpendUnits" FROM "EnrichmentJob" WHERE "id"=?`,
      args: [queueJobId],
    });
    assert.deepEqual(
      [queue.rows[0]?.status, queue.rows[0]?.attempts, queue.rows[0]?.actualSpendUnits],
      ["cancelled", 0, 0],
    );
  } finally {
    await db.close();
  }
});

test("exact claim, heartbeat, one attempt and atomic queue/item completion require final report", async () => {
  const db = await migratedDb();
  const value = plan();
  try {
    await seed(db, value);
    await acquire(db, value);
    let item = await claim(db, value);
    item = await prepareAttempt(db, value, item);
    assert.equal(item.status, "costing");
    assert.equal(item.attempts, 1);

    await assert.rejects(
      db.execute({
        sql: `UPDATE "ProductTruthOperationalRunItem" SET "attempts"=0,"updatedAt"=? WHERE "id"=?`,
        args: [at(5), item.id],
      }),
      /PRODUCT_TRUTH_OPERATIONAL_ITEM_ATTEMPT_INVALID/,
    );

    const heartbeat = await heartbeatProductTruthOperationalItemLease(db, {
      runId: value.runId,
      runLeaseToken: "run-lease-a",
      itemId: item.id,
      itemLeaseToken: "item-lease-a",
      queueLeaseToken: "queue-lease-a",
      at: at(5),
      leaseExpiresAt: at(480),
    });
    item = heartbeat.item;
    assert.equal(item.leaseExpiresAt, at(480));
    const queueHeartbeat = await db.execute({
      sql: `SELECT "leaseExpiresAt" FROM "EnrichmentJob" WHERE "id"=?`,
      args: [item.queueJobId!],
    });
    assert.equal(new Date(String(queueHeartbeat.rows[0]?.leaseExpiresAt)).toISOString(), at(480));

    item = await transitionProductTruthOperationalItem(db, {
      item,
      runLeaseToken: "run-lease-a",
      leaseToken: "item-lease-a",
      nextStatus: "verifying",
      stage: "VERIFYING",
      at: at(6),
      checkpoint: { verified: true },
    });

    await assert.rejects(
      terminalizeProductTruthOperationalAttempt(db, {
        item,
        runLeaseToken: "run-lease-a",
        itemLeaseToken: "item-lease-a",
        queueLeaseToken: "wrong-queue-lease",
        queueStatus: "done",
        itemStatus: "done",
        stage: "DONE",
        at: at(7),
        completedFields: PRODUCT_TRUTH_OPERATIONAL_FIELDS,
        unavailableFields: [],
        actualSpendUnits: 1.5,
        result: { outcome: "FACT" },
        checkpoint: { reconciled: true },
        terminalReason: null,
      }),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === "OPERATIONAL_QUEUE_CAS_LOST",
    );
    const afterRollback = await db.execute({
      sql: `SELECT "status" FROM "EnrichmentJob" WHERE "id"=?`,
      args: [item.queueJobId!],
    });
    assert.equal(afterRollback.rows[0]?.status, "running");
    assert.equal((await listProductTruthOperationalRunItems(db, value.runId))[0].status, "verifying");

    const terminal = await terminalizeProductTruthOperationalAttempt(db, {
      item,
      runLeaseToken: "run-lease-a",
      itemLeaseToken: "item-lease-a",
      queueLeaseToken: "queue-lease-a",
      queueStatus: "done",
      itemStatus: "done",
      stage: "DONE",
      at: at(8),
      completedFields: PRODUCT_TRUTH_OPERATIONAL_FIELDS,
      unavailableFields: [],
      actualSpendUnits: 1.5,
      result: { outcome: "FACT" },
      checkpoint: { reconciled: true },
      terminalReason: null,
    });
    assert.equal(terminal.item.status, "done");
    assert.equal(terminal.queue.status, "done");
    assert.equal(terminal.queue.actualSpendUnits, 1.5);

    await assert.rejects(
      finishProductTruthOperationalRun(db, {
        runId: value.runId,
        leaseToken: "run-lease-a",
        status: "completed",
        at: at(9),
      }),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === "OPERATIONAL_REPORT_REQUIRED",
    );
    const completed = await finishProductTruthOperationalRun(db, {
      runId: value.runId,
      leaseToken: "run-lease-a",
      status: "completed",
      at: at(10),
      reportSha256: REPORT_SHA,
      artifactIndexSha256: ARTIFACT_SHA,
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.reportSha256, REPORT_SHA);
    const eventTypes = (await listProductTruthOperationalEvents(db, value.runId))
      .map((event) => event.eventType);
    assert.deepEqual(eventTypes, [
      "RUN_PREPARED",
      "RUN_LEASE_ACQUIRED",
      "ITEM_CLAIMED",
      "ITEM_QUEUE_BOUND",
      "ITEM_TRANSITIONED",
      "ATTEMPT_STARTED",
      "RUN_HEARTBEAT",
      "ITEM_TRANSITIONED",
      "ATTEMPT_TERMINALIZED",
      "RUN_FINISHED",
    ]);
  } finally {
    await db.close();
  }
});

test("expiry before the attempt is safely resumable, after attempt is terminally ambiguous", async () => {
  const safeDb = await migratedDb();
  const safePlan = plan("safe-expiry-run");
  try {
    await seed(safeDb, safePlan);
    await acquireProductTruthOperationalRunLease(safeDb, {
      runId: safePlan.runId,
      leaseOwner: "safe-worker",
      leaseToken: "safe-run-lease",
      at: at(1),
      leaseExpiresAt: at(60),
    });
    let item = await claimNextProductTruthOperationalItem(safeDb, {
      runId: safePlan.runId,
      runLeaseToken: "safe-run-lease",
      itemLeaseToken: "safe-item-lease",
      at: at(2),
      leaseExpiresAt: at(60),
    });
    assert.ok(item);
    item = await transitionProductTruthOperationalItem(safeDb, {
      item,
      runLeaseToken: "safe-run-lease",
      leaseToken: "safe-item-lease",
      nextStatus: "reuse_checked",
      stage: "REUSE_CHECKED",
      at: at(3),
      checkpoint: { freeReuseChecked: true },
    });
    item = await transitionProductTruthOperationalItem(safeDb, {
      item,
      runLeaseToken: "safe-run-lease",
      leaseToken: "safe-item-lease",
      nextStatus: "verifying",
      stage: "VERIFYING_REUSED_PRODUCT_TRUTH",
      at: at(4),
      checkpoint: { freeReuseVerifying: true },
    });
    assert.equal(item.attempts, 0);
    const reaped = await reapExpiredProductTruthOperationalRun(safeDb, {
      runId: safePlan.runId,
      at: at(61),
    });
    assert.equal(reaped.status, "interrupted");
    const pending = (await listProductTruthOperationalRunItems(safeDb, safePlan.runId))[0];
    assert.equal(pending.status, "pending");
    assert.equal(pending.attempts, 0);
    assert.equal(pending.startedAt, null);
    assert.ok(pending.checkpointJson?.endsWith("\n"));

    await acquireProductTruthOperationalRunLease(safeDb, {
      runId: safePlan.runId,
      leaseOwner: "safe-worker-resume",
      leaseToken: "safe-run-lease-resume",
      at: at(62),
      leaseExpiresAt: at(300),
    });
    const resumed = await claimNextProductTruthOperationalItem(safeDb, {
      runId: safePlan.runId,
      runLeaseToken: "safe-run-lease-resume",
      itemLeaseToken: "safe-item-lease-resume",
      at: at(63),
      leaseExpiresAt: at(300),
    });
    assert.equal(resumed?.status, "claimed");
  } finally {
    await safeDb.close();
  }

  const ambiguousDb = await migratedDb();
  const ambiguousPlan = plan("ambiguous-expiry-run");
  try {
    await seed(ambiguousDb, ambiguousPlan);
    await acquireProductTruthOperationalRunLease(ambiguousDb, {
      runId: ambiguousPlan.runId,
      leaseOwner: "worker-a",
      leaseToken: "run-lease-a",
      at: at(1),
      leaseExpiresAt: at(60),
    });
    let item = await claimNextProductTruthOperationalItem(ambiguousDb, {
      runId: ambiguousPlan.runId,
      runLeaseToken: "run-lease-a",
      itemLeaseToken: "item-lease-a",
      at: at(2),
      leaseExpiresAt: at(60),
    });
    assert.ok(item);
    const queueJobId = await insertQueueJob(ambiguousDb, ambiguousPlan);
    item = await bindProductTruthOperationalQueueJob(ambiguousDb, {
      item,
      queueJobId,
      runLeaseToken: "run-lease-a",
      itemLeaseToken: "item-lease-a",
      at: at(2),
    });
    item = await transitionProductTruthOperationalItem(ambiguousDb, {
      item,
      runLeaseToken: "run-lease-a",
      leaseToken: "item-lease-a",
      nextStatus: "reuse_checked",
      stage: "REUSE_CHECKED",
      at: at(3),
      checkpoint: { freeReuseChecked: true },
    });
    // Simulate the old split crash boundary: queue crossed attempt=1, while
    // the item still looks pre-attempt. Reaper must never replay this state.
    await claimQueueJob(ambiguousDb, queueJobId);
    assert.equal(item.attempts, 0);

    const reaped = await reapExpiredProductTruthOperationalRun(ambiguousDb, {
      runId: ambiguousPlan.runId,
      at: at(61),
    });
    assert.equal(reaped.status, "ambiguous");
    assert.equal(reaped.run.status, "ambiguous");
    const storedItem = (await listProductTruthOperationalRunItems(ambiguousDb, ambiguousPlan.runId))[0];
    assert.equal(storedItem.status, "ambiguous");
    const queue = await ambiguousDb.execute({
      sql: `SELECT "status","terminalReason" FROM "EnrichmentJob" WHERE "id"=?`,
      args: [storedItem.queueJobId!],
    });
    assert.deepEqual(
      [queue.rows[0]?.status, queue.rows[0]?.terminalReason],
      ["error", "METERED_ATTEMPT_OUTCOME_AMBIGUOUS"],
    );
    await assert.rejects(
      acquireProductTruthOperationalRunLease(ambiguousDb, {
        runId: ambiguousPlan.runId,
        leaseOwner: "forbidden-replay",
        leaseToken: "forbidden-replay",
        at: at(62),
        leaseExpiresAt: at(300),
      }),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === "OPERATIONAL_RUN_TERMINAL",
    );

    const overlap = plan("ambiguous-overlap-run");
    await registerScope(ambiguousDb, overlap);
    await assert.rejects(
      seedProductTruthOperationalRun(ambiguousDb, {
        plan: overlap,
        approvalId: `approval-${overlap.runId}`,
        environment: "local-test",
        at: at(63),
      }),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === "OPERATIONAL_AMBIGUOUS_TARGET_OVERLAP",
    );

    const unrelated = plan("unrelated-after-ambiguous-run", "UNRELATED-SKU");
    const unrelatedSeed = await seed(ambiguousDb, unrelated);
    assert.equal(unrelatedSeed.created, true);
  } finally {
    await ambiguousDb.close();
  }
});

test("metered budgets and receipts are byte-bound to a live sealed run lease", async () => {
  const db = await migratedDb();
  const value = plan("metered-binding-run");
  try {
    await seed(db, value);
    await assert.rejects(
      insertBudget(db, value.runId, `approval-${value.runId}`),
      /METERED_BUDGET_OPERATIONAL_RUN_MISMATCH/,
    );
    await acquire(db, value);
    await insertBudget(db, value.runId, `approval-${value.runId}`);
    await insertReceipt(db, "receipt-live", "budget-metered-binding-run");

    await finishProductTruthOperationalRun(db, {
      runId: value.runId,
      leaseToken: "run-lease-a",
      status: "interrupted",
      at: at(10),
    });
    await assert.rejects(
      insertReceipt(db, "receipt-after-stop", "budget-metered-binding-run"),
      /METERED_RECEIPT_OPERATIONAL_RUN_NOT_LIVE/,
    );
    await assert.rejects(
      db.execute(`UPDATE "MeteredProviderBudget"
                  SET "reservedCalls"=1,"reservedUnitsMicros"=1000000
                  WHERE "id"='budget-metered-binding-run'`),
      /METERED_BUDGET_OPERATIONAL_RUN_NOT_LIVE/,
    );

    const resumeSeed = await seedProductTruthOperationalRun(db, {
      plan: value,
      approvalId: `approval-${value.runId}`,
      environment: "local-test",
      at: at(11),
    });
    assert.equal(resumeSeed.created, false);
    assert.equal(resumeSeed.run.status, "interrupted");
    assert.equal(resumeSeed.items.length, value.targets.length);
    const resumed = await acquireProductTruthOperationalRunLease(db, {
      runId: value.runId,
      leaseOwner: "resume-worker",
      leaseToken: "resume-run-lease",
      at: at(12),
      leaseExpiresAt: at(300),
    });
    assert.equal(resumed.status, "running");
  } finally {
    await db.close();
  }

  const preseeded = await migratedDb();
  const blockedPlan = plan("preseeded-budget-run");
  try {
    await insertBudget(preseeded, blockedPlan.runId, `approval-${blockedPlan.runId}`);
    await registerScope(preseeded, blockedPlan);
    await assert.rejects(
      seedProductTruthOperationalRun(preseeded, {
        plan: blockedPlan,
        approvalId: `approval-${blockedPlan.runId}`,
        environment: "local-test",
        at: T0,
      }),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === "OPERATIONAL_RUN_SEED_FAILED"
        && String(error.cause).includes("PRODUCT_TRUTH_OPERATIONAL_RUN_INITIAL_STATE_INVALID"),
    );
  } finally {
    await preseeded.close();
  }
});

async function insertBudget(db: Client, runId: string, approvalId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO "MeteredProviderBudget"
          ("id","permitVersion","runId","approvalId","approvedBy","provider",
           "issuedAt","expiresAt","operations","maxCalls","maxUnitsMicros",
           "reservedCalls","reservedUnitsMicros","createdAt","updatedAt")
          VALUES (?,1,?,?,'owner','unwrangle',?,?,?,2,2000000,0,0,?,?)`,
    args: [
      `budget-${runId}`,
      runId,
      approvalId,
      T0,
      at(3_600),
      JSON.stringify(["detail", "search"]),
      at(2),
      at(2),
    ],
  });
}

async function insertReceipt(db: Client, id: string, budgetId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO "MeteredReservationReceipt"
          ("id","budgetId","reservationKey","operation","unitsMicros","status",
           "failureCode","createdAt","reservedAt","settledAt","updatedAt")
          VALUES (?,?,?,'detail',1000000,'pending',NULL,?,NULL,NULL,?)`,
    args: [id, budgetId, id, at(3), at(3)],
  });
}

test("event journal is immutable and hash corruption fails closed on every read", async () => {
  const db = await migratedDb();
  const value = plan("event-chain-run");
  try {
    await seed(db, value);
    const events = await listProductTruthOperationalEvents(db, value.runId);
    assert.equal(events.length, 1);
    await assert.rejects(
      db.execute({
        sql: `UPDATE "ProductTruthOperationalEvent" SET "eventType"='FORGED' WHERE "id"=?`,
        args: [events[0].id],
      }),
      /PRODUCT_TRUTH_OPERATIONAL_EVENT_IMMUTABLE/,
    );
    await assert.rejects(
      db.execute({
        sql: `DELETE FROM "ProductTruthOperationalEvent" WHERE "id"=?`,
        args: [events[0].id],
      }),
      /PRODUCT_TRUTH_OPERATIONAL_EVENT_IMMUTABLE/,
    );
    await assert.rejects(
      db.execute({
        sql: `UPDATE "ProductTruthOperationalRun" SET "eventChainHead"=? WHERE "runId"=?`,
        args: ["a".repeat(64), value.runId],
      }),
      /PRODUCT_TRUTH_OPERATIONAL_EVENT_CHAIN_HEAD_INVALID/,
    );

    await db.execute({
      sql: `INSERT INTO "ProductTruthOperationalEvent"
            ("id","runId","eventIndex","eventType","itemId","previousHash",
             "payloadJson","payloadSha256","eventHash","createdAt")
            VALUES (?,?,1,'FORGED',NULL,?,?,?, ?,?)`,
      args: [
        `ptore_${"a".repeat(64)}`,
        value.runId,
        events[0].eventHash,
        "{}\n",
        "b".repeat(64),
        "a".repeat(64),
        at(1),
      ],
    });
    await assert.rejects(
      getProductTruthOperationalRun(db, value.runId),
      (error: unknown) => error instanceof ProductTruthOperationalStoreError
        && error.code === PRODUCT_TRUTH_OPERATIONAL_SCHEMA_ERROR,
    );
  } finally {
    await db.close();
  }
});
});
