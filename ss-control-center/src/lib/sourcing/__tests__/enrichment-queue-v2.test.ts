import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { test } from "node:test";

import {
  enqueueEnrichment,
  enrichmentIdempotencyKey,
  normalizeEnrichmentFields,
  normalizeEnrichmentTarget,
} from "../enrichment-queue";

async function queueDb(): Promise<Client> {
  const db = createClient({ url: "file::memory:" });
  await db.executeMultiple(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE ProductTruthListingScope (
    listingKey TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    storeIndex INTEGER NOT NULL,
    sku TEXT NOT NULL,
    UNIQUE(channel, storeIndex, sku)
  );
  CREATE TABLE EnrichmentJob (
    id TEXT PRIMARY KEY,
    targetType TEXT NOT NULL,
    target TEXT NOT NULL,
    normalizedTarget TEXT,
    listingKey TEXT REFERENCES ProductTruthListingScope(listingKey)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    idempotencyKey TEXT,
    requestedFields TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued',
    source TEXT NOT NULL DEFAULT 'manual',
    priority INTEGER NOT NULL DEFAULT 0,
    requestedBy TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    runId TEXT,
    approvalId TEXT,
    estimatedSpendUnits REAL NOT NULL DEFAULT 0,
    actualSpendUnits REAL NOT NULL DEFAULT 0,
    nextEligibleAt TEXT,
    queuedAt TEXT,
    createdAt TEXT,
    updatedAt TEXT
  );
  CREATE UNIQUE INDEX EnrichmentJob_one_active_idempotencyKey
    ON EnrichmentJob(idempotencyKey)
    WHERE status IN ('queued','running','retry_wait');
  CREATE UNIQUE INDEX EnrichmentJob_one_active_listing_intent
    ON EnrichmentJob(listingKey,requestedFields)
    WHERE targetType='sku' AND status IN ('queued','running','retry_wait');
  CREATE TRIGGER EnrichmentJob_queue_v3_quiescence_guard
  BEFORE UPDATE OF listingKey ON EnrichmentJob
  WHEN EXISTS (
    SELECT 1 FROM EnrichmentJob running
    WHERE running.targetType='sku'
      AND running.listingKey IS NULL
      AND running.status='running'
  )
  BEGIN
    SELECT RAISE(ABORT, 'QUEUE_V3_MIGRATION_REQUIRES_QUIESCENCE');
  END;
  CREATE TRIGGER EnrichmentJob_listing_scope_contract_insert
  BEFORE INSERT ON EnrichmentJob
  BEGIN
    SELECT CASE WHEN NEW.targetType NOT IN ('brand','product','sku','query')
      THEN RAISE(ABORT, 'ENRICHMENT_JOB_TARGET_TYPE_INVALID') END;
    SELECT CASE WHEN NEW.targetType='sku' AND (
      NEW.listingKey IS NULL
      OR NEW.normalizedTarget IS NOT NEW.target
      OR NEW.idempotencyKey IS NULL
      OR length(NEW.idempotencyKey)<>64
      OR NEW.idempotencyKey IS NOT lower(NEW.idempotencyKey)
      OR NEW.idempotencyKey GLOB '*[^0-9a-f]*'
      OR NOT EXISTS (
        SELECT 1 FROM ProductTruthListingScope scope
        WHERE scope.listingKey=NEW.listingKey AND scope.sku=NEW.target
      )
    ) THEN RAISE(ABORT, 'ENRICHMENT_JOB_SKU_LISTING_SCOPE_INVALID') END;
    SELECT CASE WHEN NEW.targetType<>'sku' AND NEW.listingKey IS NOT NULL
      THEN RAISE(ABORT, 'ENRICHMENT_JOB_NON_SKU_SCOPE_FORBIDDEN') END;
  END;
  CREATE TRIGGER EnrichmentJob_listing_scope_identity_immutable
  BEFORE UPDATE ON EnrichmentJob
  WHEN OLD.targetType IS NOT NEW.targetType
    OR OLD.target IS NOT NEW.target
    OR OLD.normalizedTarget IS NOT NEW.normalizedTarget
    OR OLD.listingKey IS NOT NEW.listingKey
  BEGIN
    SELECT RAISE(ABORT, 'ENRICHMENT_JOB_LISTING_SCOPE_IDENTITY_IMMUTABLE');
  END;
  CREATE TRIGGER EnrichmentJob_listing_scope_contract_update
  BEFORE UPDATE ON EnrichmentJob
  BEGIN
    SELECT CASE WHEN NEW.targetType NOT IN ('brand','product','sku','query')
      THEN RAISE(ABORT, 'ENRICHMENT_JOB_TARGET_TYPE_INVALID') END;
    SELECT CASE WHEN NEW.targetType='sku' AND (
      NEW.listingKey IS NULL
      OR NEW.normalizedTarget IS NOT NEW.target
      OR NEW.idempotencyKey IS NULL
      OR length(NEW.idempotencyKey)<>64
      OR NEW.idempotencyKey IS NOT lower(NEW.idempotencyKey)
      OR NEW.idempotencyKey GLOB '*[^0-9a-f]*'
      OR NOT EXISTS (
        SELECT 1 FROM ProductTruthListingScope scope
        WHERE scope.listingKey=NEW.listingKey AND scope.sku=NEW.target
      )
    ) THEN RAISE(ABORT, 'ENRICHMENT_JOB_SKU_LISTING_SCOPE_INVALID') END;
    SELECT CASE WHEN NEW.targetType<>'sku' AND NEW.listingKey IS NOT NULL
      THEN RAISE(ABORT, 'ENRICHMENT_JOB_NON_SKU_SCOPE_FORBIDDEN') END;
  END;
  `);
  return db;
}

async function registerScope(
  db: Client,
  channel: "amazon" | "walmart",
  storeIndex: number,
  sku: string,
): Promise<string> {
  const listingKey = `${channel}:${storeIndex}:${sku}`;
  await db.execute({
    sql: `INSERT INTO ProductTruthListingScope(listingKey,channel,storeIndex,sku)
          VALUES (?,?,?,?)`,
    args: [listingKey, channel, storeIndex, sku],
  });
  return listingKey;
}

test("target and field canonicalization produces stable scoped v3 keys", () => {
  const a = normalizeEnrichmentTarget("product", "  Smucker’s   Uncrustables — Grape  ");
  const b = normalizeEnrichmentTarget("product", "smucker's uncrustables grape");
  assert.equal(a, b);
  const fields = normalizeEnrichmentFields(["cogs", "identity", "cogs"]);
  assert.deepEqual(fields, ["cogs", "identity"]);
  assert.equal(
    enrichmentIdempotencyKey({ targetType: "product", normalizedTarget: a, requestedFields: fields }),
    enrichmentIdempotencyKey({ targetType: "product", normalizedTarget: b, requestedFields: ["cogs", "identity"] }),
  );
  assert.equal(normalizeEnrichmentTarget("sku", "Ab C-123"), "Ab C-123");
  assert.throws(
    () => normalizeEnrichmentTarget("sku", " Ab C-123 "),
    /exact non-empty raw SKU/,
  );
  assert.notEqual(
    enrichmentIdempotencyKey({
      targetType: "sku",
      normalizedTarget: "SAME-SKU",
      requestedFields: ["identity"],
      listingKey: "amazon:1:SAME-SKU",
    }),
    enrichmentIdempotencyKey({
      targetType: "sku",
      normalizedTarget: "SAME-SKU",
      requestedFields: ["identity"],
      listingKey: "amazon:2:SAME-SKU",
    }),
  );
});

test("parallel producers create one active canonical job", async () => {
  const db = await queueDb();
  try {
    const results = await Promise.all(Array.from({ length: 20 }, (_, priority) => enqueueEnrichment(db, {
      targetType: "product",
      target: priority % 2 ? "Smucker's Uncrustables Grape" : "  SMUCKER’S  UNCRUSTABLES — GRAPE ",
      requestedFields: ["identity", "offers"],
      priority,
      source: "test",
    })));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    assert.equal(results.every((result) => result.contractVersion === "v3"), true);
    const active = await db.execute(`SELECT COUNT(*) AS n, MAX(priority) AS priority FROM EnrichmentJob WHERE status IN ('queued','running','retry_wait')`);
    assert.equal(Number(active.rows[0]?.n), 1);
    assert.equal(Number(active.rows[0]?.priority), 19);
  } finally {
    await db.close();
  }
});

test("same raw SKU in different channels/accounts creates independent active jobs", async () => {
  const db = await queueDb();
  try {
    const sku = "Case-Sensitive SKU 01";
    const amazon1 = await registerScope(db, "amazon", 1, sku);
    const amazon2 = await registerScope(db, "amazon", 2, sku);
    const walmart7 = await registerScope(db, "walmart", 7, sku);

    const jobs = await Promise.all([
      enqueueEnrichment(db, {
        targetType: "sku", target: sku, channel: "amazon", storeIndex: 1,
        requestedFields: ["identity", "offers"],
      }),
      enqueueEnrichment(db, {
        targetType: "sku", target: sku, channel: "amazon", storeIndex: 2,
        requestedFields: ["identity", "offers"],
      }),
      enqueueEnrichment(db, {
        targetType: "sku", target: sku, channel: "walmart", storeIndex: 7,
        requestedFields: ["identity", "offers"],
      }),
    ]);

    assert.deepEqual(jobs.map((job) => job.listingKey), [amazon1, amazon2, walmart7]);
    assert.equal(new Set(jobs.map((job) => job.id)).size, 3);
    assert.equal(new Set(jobs.map((job) => job.idempotencyKey)).size, 3);

    const duplicate = await enqueueEnrichment(db, {
      targetType: "sku", target: sku, channel: "amazon", storeIndex: 1,
      requestedFields: ["offers", "identity"],
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.id, jobs[0]?.id);

    const rows = await db.execute(
      `SELECT listingKey,target,normalizedTarget FROM EnrichmentJob ORDER BY listingKey`,
    );
    assert.equal(rows.rows.length, 3);
    assert.equal(rows.rows.every((row) => row.target === sku && row.normalizedTarget === sku), true);
  } finally {
    await db.close();
  }
});

test("SKU work fails closed without exact registry scope and non-SKU scope is rejected", async () => {
  const db = await queueDb();
  try {
    const listingKey = await registerScope(db, "amazon", 1, "SKU-1");
    await assert.rejects(
      enqueueEnrichment(db, {
        targetType: "sku", target: "SKU-1", channel: "amazon", storeIndex: 2,
      }),
      /PRODUCT_TRUTH_LISTING_SCOPE_NOT_REGISTERED/,
    );
    await assert.rejects(
      enqueueEnrichment(db, {
        targetType: "sku", target: "sku-1", channel: "amazon", storeIndex: 1,
      }),
      /PRODUCT_TRUTH_LISTING_SCOPE_NOT_REGISTERED/,
    );
    await assert.rejects(
      enqueueEnrichment(db, {
        targetType: "brand",
        target: "Jimmy Dean",
        channel: "amazon",
        storeIndex: 1,
      } as never),
      /must not carry channel\/storeIndex/,
    );
    await assert.rejects(
      enqueueEnrichment(db, {
        targetType: "SKU",
        target: "SKU-1",
      } as never),
      /invalid enrichment targetType/,
    );
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO EnrichmentJob
              (id,targetType,target,normalizedTarget,listingKey,idempotencyKey,status,source,priority,attempts)
              VALUES ('bad','sku','OTHER','OTHER',?,'bad','queued','test',0,0)`,
        args: [listingKey],
      }),
      /ENRICHMENT_JOB_SKU_LISTING_SCOPE_INVALID/,
    );
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO EnrichmentJob
              (id,targetType,target,normalizedTarget,listingKey,idempotencyKey,status,source,priority,attempts)
              VALUES ('null-key','sku','SKU-1','SKU-1',?,NULL,'queued','test',0,0)`,
        args: [listingKey],
      }),
      /ENRICHMENT_JOB_SKU_LISTING_SCOPE_INVALID/,
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO EnrichmentJob
         (id,targetType,target,normalizedTarget,listingKey,idempotencyKey,status,source,priority,attempts)
         VALUES ('bad-type','SKU','SKU-1','SKU-1',NULL,
                 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                 'queued','test',0,0)`,
      ),
      /ENRICHMENT_JOB_TARGET_TYPE_INVALID/,
    );
  } finally {
    await db.close();
  }
});

test("terminal history does not prevent a later active job, while field intents remain distinct", async () => {
  const db = await queueDb();
  try {
    const first = await enqueueEnrichment(db, { targetType: "brand", target: "Jimmy Dean", requestedFields: ["offers"] });
    await db.execute({ sql: `UPDATE EnrichmentJob SET status='done' WHERE id=?`, args: [first.id] });
    const second = await enqueueEnrichment(db, { targetType: "brand", target: "jimmy-dean", requestedFields: ["offers"] });
    const content = await enqueueEnrichment(db, { targetType: "brand", target: "Jimmy Dean", requestedFields: ["content"] });
    assert.equal(second.created, true);
    assert.notEqual(second.id, first.id);
    assert.equal(content.created, true);
    assert.notEqual(content.id, second.id);
    const all = await db.execute(`SELECT COUNT(*) AS n FROM EnrichmentJob`);
    assert.equal(Number(all.rows[0]?.n), 3);
  } finally {
    await db.close();
  }
});

test("queue v2 schema fails closed without inserting a non-idempotent v3 job", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute(`CREATE TABLE EnrichmentJob (
      id TEXT PRIMARY KEY,
      targetType TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      priority INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      queuedAt TEXT,
      createdAt TEXT,
      updatedAt TEXT
    )`);
    await assert.rejects(
      () => enqueueEnrichment(db, { targetType: "product", target: "Test Product" }),
      /PRODUCT_TRUTH_QUEUE_V3_REQUIRED/,
    );
    const rows = await db.execute(`SELECT COUNT(*) AS n FROM EnrichmentJob`);
    assert.equal(Number(rows.rows[0]?.n), 0);
  } finally {
    await db.close();
  }
});
