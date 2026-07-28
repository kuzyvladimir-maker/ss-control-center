import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { test } from "node:test";

import {
  claimProductTruthOperationalQueueJob,
  ensureProductTruthOperationalQueueJob,
  finishProductTruthOperationalQueueJob,
  getProductTruthOperationalQueueJob,
  reapExpiredProductTruthOperationalQueueJobs,
} from "../product-truth-operational-queue";
import type { ProductTruthOperationalTarget } from "../product-truth-operational-run-contract";

const target: ProductTruthOperationalTarget = {
  ordinal: 0,
  listingKey: "amazon:1:Exact SKU",
  listingKeyVersion: "product-truth-listing-key/1.0.0",
  channel: "amazon",
  storeIndex: 1,
  sku: "Exact SKU",
  requestedFields: ["identity", "offers", "content", "cogs"],
};

async function database(): Promise<Client> {
  const db = createClient({ url: "file::memory:" });
  await db.executeMultiple(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE ProductTruthListingScope (
      listingKey TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      storeIndex INTEGER NOT NULL,
      sku TEXT NOT NULL,
      UNIQUE(channel,storeIndex,sku)
    );
    INSERT INTO ProductTruthListingScope VALUES ('amazon:1:Exact SKU','amazon',1,'Exact SKU');
    CREATE TABLE EnrichmentJob (
      id TEXT PRIMARY KEY,
      targetType TEXT NOT NULL,
      target TEXT NOT NULL,
      normalizedTarget TEXT,
      listingKey TEXT REFERENCES ProductTruthListingScope(listingKey),
      idempotencyKey TEXT,
      requestedFields TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL DEFAULT 'manual',
      priority INTEGER NOT NULL DEFAULT 0,
      requestedBy TEXT,
      runId TEXT,
      approvalId TEXT,
      estimatedSpendUnits REAL NOT NULL DEFAULT 0,
      actualSpendUnits REAL NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      providerAttempts TEXT,
      result TEXT,
      error TEXT,
      terminalReason TEXT,
      completedFields TEXT,
      unavailableFields TEXT,
      checkpoint TEXT,
      nextEligibleAt TEXT,
      leaseOwner TEXT,
      leaseToken TEXT,
      leaseExpiresAt TEXT,
      heartbeatAt TEXT,
      queuedAt TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE UNIQUE INDEX EnrichmentJob_one_active_idempotencyKey
      ON EnrichmentJob(idempotencyKey) WHERE status IN ('queued','running','retry_wait');
    CREATE UNIQUE INDEX EnrichmentJob_one_active_listing_intent
      ON EnrichmentJob(listingKey,requestedFields)
      WHERE targetType='sku' AND status IN ('queued','running','retry_wait');
    CREATE TRIGGER EnrichmentJob_queue_v3_quiescence_guard
    BEFORE UPDATE OF listingKey ON EnrichmentJob
    WHEN EXISTS (SELECT 1 FROM EnrichmentJob WHERE targetType='sku' AND listingKey IS NULL AND status='running')
    BEGIN SELECT RAISE(ABORT,'QUEUE_V3_MIGRATION_REQUIRES_QUIESCENCE'); END;
    CREATE TRIGGER EnrichmentJob_listing_scope_contract_insert
    BEFORE INSERT ON EnrichmentJob
    BEGIN
      SELECT CASE WHEN NEW.targetType NOT IN ('brand','product','sku','query')
        THEN RAISE(ABORT,'ENRICHMENT_JOB_TARGET_TYPE_INVALID') END;
      SELECT CASE WHEN NEW.targetType='sku' AND (
        NEW.listingKey IS NULL OR NEW.normalizedTarget IS NOT NEW.target
        OR NEW.idempotencyKey IS NULL OR length(NEW.idempotencyKey)<>64
        OR NEW.idempotencyKey IS NOT lower(NEW.idempotencyKey)
        OR NEW.idempotencyKey GLOB '*[^0-9a-f]*'
        OR NOT EXISTS (SELECT 1 FROM ProductTruthListingScope s
          WHERE s.listingKey=NEW.listingKey AND s.sku=NEW.target)
      ) THEN RAISE(ABORT,'ENRICHMENT_JOB_SKU_LISTING_SCOPE_INVALID') END;
      SELECT CASE WHEN NEW.targetType<>'sku' AND NEW.listingKey IS NOT NULL
        THEN RAISE(ABORT,'ENRICHMENT_JOB_NON_SKU_SCOPE_FORBIDDEN') END;
    END;
    CREATE TRIGGER EnrichmentJob_listing_scope_identity_immutable
    BEFORE UPDATE ON EnrichmentJob
    WHEN OLD.targetType IS NOT NEW.targetType OR OLD.target IS NOT NEW.target
      OR OLD.normalizedTarget IS NOT NEW.normalizedTarget OR OLD.listingKey IS NOT NEW.listingKey
    BEGIN SELECT RAISE(ABORT,'ENRICHMENT_JOB_LISTING_SCOPE_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER EnrichmentJob_listing_scope_contract_update
    BEFORE UPDATE ON EnrichmentJob
    BEGIN
      SELECT CASE WHEN NEW.targetType NOT IN ('brand','product','sku','query')
        THEN RAISE(ABORT,'ENRICHMENT_JOB_TARGET_TYPE_INVALID') END;
      SELECT CASE WHEN NEW.targetType='sku' AND (
        NEW.listingKey IS NULL OR NEW.normalizedTarget IS NOT NEW.target
        OR NEW.idempotencyKey IS NULL OR length(NEW.idempotencyKey)<>64
        OR NEW.idempotencyKey IS NOT lower(NEW.idempotencyKey)
        OR NEW.idempotencyKey GLOB '*[^0-9a-f]*'
        OR NOT EXISTS (SELECT 1 FROM ProductTruthListingScope s
          WHERE s.listingKey=NEW.listingKey AND s.sku=NEW.target)
      ) THEN RAISE(ABORT,'ENRICHMENT_JOB_SKU_LISTING_SCOPE_INVALID') END;
    END;
  `);
  return db;
}

test("operational queue owns one exact attempt and persists spend/result", async () => {
  const db = await database();
  try {
    const queued = await ensureProductTruthOperationalQueueJob(db, {
      target,
      runId: "run-a",
      approvalId: "approval-a",
      estimatedSpendUnits: 7.5,
    });
    assert.equal(queued.status, "queued");
    const duplicate = await ensureProductTruthOperationalQueueJob(db, {
      target,
      runId: "run-a",
      approvalId: "approval-a",
      estimatedSpendUnits: 7.5,
    });
    assert.equal(duplicate.id, queued.id);

    const claimed = await claimProductTruthOperationalQueueJob(db, {
      job: queued,
      leaseOwner: "runner:test",
      leaseToken: "queue-lease-a",
      at: "2026-07-19T12:00:00.000Z",
      leaseExpiresAt: "2026-07-19T12:05:00.000Z",
    });
    assert.equal(claimed.attempts, 1);
    await assert.rejects(
      () => claimProductTruthOperationalQueueJob(db, {
        job: claimed,
        leaseOwner: "runner:other",
        at: "2026-07-19T12:01:00.000Z",
        leaseExpiresAt: "2026-07-19T12:06:00.000Z",
      }),
      /OPERATIONAL_QUEUE_ALREADY_RUNNING/,
    );

    const done = await finishProductTruthOperationalQueueJob(db, {
      job: claimed,
      leaseToken: "queue-lease-a",
      status: "done",
      at: "2026-07-19T12:02:00.000Z",
      completedFields: ["identity", "offers", "content", "cogs"],
      unavailableFields: [],
      actualSpendUnits: 5,
      result: { outcome: "FACT" },
      checkpoint: { receiptIds: ["receipt-a"] },
      terminalReason: null,
    });
    assert.equal(done.status, "done");
    assert.equal(done.actualSpendUnits, 5);
  } finally {
    await db.close();
  }
});
test("cross-run active intent cannot be stolen and expired attempted work is ambiguous", async () => {
  const db = await database();
  try {
    const queued = await ensureProductTruthOperationalQueueJob(db, {
      target,
      runId: "run-a",
      approvalId: "approval-a",
      estimatedSpendUnits: 5,
    });
    await assert.rejects(
      () => ensureProductTruthOperationalQueueJob(db, {
        target,
        runId: "run-b",
        approvalId: "approval-b",
        estimatedSpendUnits: 5,
      }),
      /OPERATIONAL_QUEUE_SCOPE_CONFLICT/,
    );
    await claimProductTruthOperationalQueueJob(db, {
      job: queued,
      leaseOwner: "runner:test",
      leaseToken: "queue-lease-a",
      at: "2026-07-19T12:00:00.000Z",
      leaseExpiresAt: "2026-07-19T12:01:00.000Z",
    });
    assert.equal(await reapExpiredProductTruthOperationalQueueJobs(db, {
      runId: "run-a",
      approvalId: "approval-a",
      at: "2026-07-19T12:02:00.000Z",
    }), 1);
    const reaped = await getProductTruthOperationalQueueJob(db, queued.id);
    assert.equal(reaped?.status, "error");
    assert.equal(reaped?.terminalReason, "METERED_ATTEMPT_OUTCOME_AMBIGUOUS");
  } finally {
    await db.close();
  }
});
