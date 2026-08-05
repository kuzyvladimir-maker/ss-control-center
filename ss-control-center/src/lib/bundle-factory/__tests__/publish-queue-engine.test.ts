import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createClient } from "@libsql/client";

/**
 * The queue that publishes batches, exercised against a real database.
 *
 * This engine now stands between the operator and the marketplace, and it was
 * shipped with no tests at all. What matters here is not that it moves rows —
 * it is that it cannot exceed the ceiling, cannot send one listing twice, and
 * cannot silently swallow a refusal.
 */
test("the publish queue obeys its ceiling, its claim and its refusals", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-queue-"));
  const databaseUrl = `file:${path.join(root, "queue.sqlite")}`;
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.DATABASE_URL = databaseUrl;

  const db = createClient({ url: databaseUrl });
  await db.execute(`CREATE TABLE "Setting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL UNIQUE,
    "value" TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE "MarketplaceSubmissionAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketplace" TEXT NOT NULL,
    "channel_sku_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "seller_account_fingerprint_sha256" TEXT NOT NULL DEFAULT 'x',
    "payload_hash" TEXT NOT NULL DEFAULT 'x',
    "claim_token" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "recovery_count" INTEGER NOT NULL DEFAULT 0,
    "authorization_basis" TEXT NOT NULL DEFAULT 'STUDIO_SEALED_APPROVAL',
    "claimed_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.execute(`CREATE TABLE "PublishBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketplace" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "requested_total" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "daily_cap_at_creation" INTEGER NOT NULL,
    "note" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "finished_at" DATETIME
  )`);
  await db.execute(`CREATE TABLE "PublishBatchItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publish_batch_id" TEXT NOT NULL,
    "bundle_draft_id" TEXT NOT NULL,
    "sku" TEXT,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failed_stage" TEXT,
    "posted" BOOLEAN NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" DATETIME,
    "submission_id" TEXT,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "finished_at" DATETIME
  )`);
  await db.execute(
    `CREATE UNIQUE INDEX "PublishBatchItem_batch_draft" ON "PublishBatchItem" ("publish_batch_id","bundle_draft_id")`,
  );

  const {
    getPublishBatchProgress,
    readPublishCapState,
    tickPublishBatch,
  } = await import("@/lib/bundle-factory/publish-queue");

  // A ceiling of two, with one submission already spent in the window.
  await db.execute({
    sql: `INSERT INTO "Setting" ("id","key","value") VALUES ('s1','walmart_publish_daily_cap','2')`,
  });
  await db.execute({
    sql: `INSERT INTO "MarketplaceSubmissionAttempt"
      ("id","marketplace","channel_sku_id","idempotency_key","claim_token","state","claimed_at","created_at","updated_at")
      VALUES ('a1','WALMART','sku-1','k1','t1','ACCEPTED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  });

  const cap = await readPublishCapState();
  assert.equal(cap.cap, 2);
  assert.equal(cap.usedLast24h, 1);
  assert.equal(cap.remaining, 1, "one submission already spent");

  await db.execute({
    sql: `INSERT INTO "PublishBatch"
      ("id","marketplace","actor","requested_total","status","daily_cap_at_creation","created_at","updated_at")
      VALUES ('batch-1','WALMART','tester',2,'QUEUED',2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  });
  for (const [index, draftId] of ["draft-a", "draft-b"].entries()) {
    await db.execute({
      sql: `INSERT INTO "PublishBatchItem"
        ("id","publish_batch_id","bundle_draft_id","position","status","created_at","updated_at")
        VALUES (?,?,?,?, 'PENDING',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      args: [`item-${index}`, "batch-1", draftId, index],
    });
  }

  // A tick publishes exactly ONE listing, never the whole batch: each listing
  // is its own claim and its own POST.
  const published: string[] = [];
  const succeed = async (input: { draftId: string }) => {
    published.push(input.draftId);
    await db.execute({
      sql: `INSERT INTO "MarketplaceSubmissionAttempt"
        ("id","marketplace","channel_sku_id","idempotency_key","claim_token","state","claimed_at","created_at","updated_at")
        VALUES (?,'WALMART',?,?,?, 'ACCEPTED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      args: [`att-${input.draftId}`, input.draftId, `key-${input.draftId}`, `tok-${input.draftId}`],
    });
    return {
      ok: true,
      stage: "DISTRIBUTE",
      skipped: [],
      submissionId: `feed-${input.draftId}`,
      distribution: {
        per_sku: [{
          channel: "WALMART",
          sku: `WM-${input.draftId}`,
          status: "SUBMITTED",
        }],
      },
    };
  };

  const first = await tickPublishBatch("batch-1", {
    publish: succeed as never,
  });
  assert.equal(first.advanced, true);
  assert.equal(published.length, 1, "one listing per tick");

  // The ceiling is now spent. The next tick must NOT publish, and must say why
  // rather than reporting the batch as finished.
  const second = await tickPublishBatch("batch-1", { publish: succeed as never });
  assert.equal(second.advanced, false);
  assert.equal(second.idleReason, "CAP_REACHED");
  assert.equal(published.length, 1, "the ceiling stopped the second listing");

  const progress = await getPublishBatchProgress("batch-1");
  assert.ok(progress);
  assert.equal(progress.succeeded, 1);
  assert.equal(progress.pending, 1);
  assert.equal(progress.done, false, "waiting for the window is not finished");
  assert.equal(progress.waitingForCap, true);

  db.close();
});
