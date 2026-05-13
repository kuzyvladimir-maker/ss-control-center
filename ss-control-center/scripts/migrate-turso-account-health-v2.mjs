// One-shot Turso migration for Account Health v2.
// Idempotent: every statement uses IF NOT EXISTS / probes table_info before
// ALTER. Safe to re-run.

import { createClient } from "@libsql/client";

function clean(v) { if (!v) return v; return v.trim().replace(/^['"]|['"]$/g, ""); }

const url = clean(process.env.TURSO_DATABASE_URL);
const token = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !token) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}
const client = createClient({ url, authToken: token });
console.log(`→ Target: Turso (${url.split("@")[1] || url})`);

async function addColumnIfMissing(table, column, ddl) {
  const info = await client.execute(`PRAGMA table_info("${table}")`);
  if (info.rows.some((r) => r.name === column)) {
    console.log(`  · ${table}.${column} already exists`);
    return;
  }
  await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  console.log(`  + added ${table}.${column}`);
}

console.log("Extending AccountHealthSnapshot…");
await addColumnIfMissing("AccountHealthSnapshot", "accountHealthRating",       `"accountHealthRating" INTEGER`);
await addColumnIfMissing("AccountHealthSnapshot", "accountHealthRatingStatus", `"accountHealthRatingStatus" TEXT`);
await addColumnIfMissing("AccountHealthSnapshot", "odrSellerFulfilled",         `"odrSellerFulfilled" REAL`);
await addColumnIfMissing("AccountHealthSnapshot", "odrSellerFulfilledOrders",   `"odrSellerFulfilledOrders" INTEGER`);
await addColumnIfMissing("AccountHealthSnapshot", "odrFulfilledByAmazon",       `"odrFulfilledByAmazon" REAL`);
await addColumnIfMissing("AccountHealthSnapshot", "odrFulfilledByAmazonOrders", `"odrFulfilledByAmazonOrders" INTEGER`);
await addColumnIfMissing("AccountHealthSnapshot", "negativeFeedbackSF",         `"negativeFeedbackSF" REAL`);
await addColumnIfMissing("AccountHealthSnapshot", "negativeFeedbackFBA",        `"negativeFeedbackFBA" REAL`);
await addColumnIfMissing("AccountHealthSnapshot", "atozClaimsRateSF",           `"atozClaimsRateSF" REAL`);
await addColumnIfMissing("AccountHealthSnapshot", "atozClaimsRateFBA",          `"atozClaimsRateFBA" REAL`);
await addColumnIfMissing("AccountHealthSnapshot", "chargebackRateSF",           `"chargebackRateSF" REAL`);
await addColumnIfMissing("AccountHealthSnapshot", "chargebackRateFBA",          `"chargebackRateFBA" REAL`);

console.log("Extending WalmartPerformanceSnapshot…");
await addColumnIfMissing("WalmartPerformanceSnapshot", "status", `"status" TEXT`);

console.log("Creating new tables…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "PolicyViolationCategory" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "snapshotId"  TEXT NOT NULL,
    "category"    TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "count"       INTEGER NOT NULL DEFAULT 0,
    "status"      TEXT NOT NULL,
    "detectedAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("snapshotId") REFERENCES "AccountHealthSnapshot"("id") ON DELETE CASCADE
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "PolicyViolationCategory_snapshotId_idx" ON "PolicyViolationCategory"("snapshotId")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "PolicyViolationCategory_category_idx"   ON "PolicyViolationCategory"("category")`);

await client.execute(`
  CREATE TABLE IF NOT EXISTS "PolicyViolationDetail" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "categoryId"        TEXT NOT NULL,
    "asin"              TEXT,
    "sku"               TEXT,
    "listingTitle"      TEXT,
    "violationType"     TEXT NOT NULL,
    "severity"          TEXT NOT NULL,
    "message"           TEXT NOT NULL,
    "reportedAt"        DATETIME NOT NULL,
    "resolvedAt"        DATETIME,
    "status"            TEXT NOT NULL DEFAULT 'OPEN',
    "amazonReferenceId" TEXT,
    FOREIGN KEY ("categoryId") REFERENCES "PolicyViolationCategory"("id") ON DELETE CASCADE
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "PolicyViolationDetail_categoryId_idx" ON "PolicyViolationDetail"("categoryId")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "PolicyViolationDetail_asin_idx"       ON "PolicyViolationDetail"("asin")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "PolicyViolationDetail_status_idx"     ON "PolicyViolationDetail"("status")`);

await client.execute(`
  CREATE TABLE IF NOT EXISTS "WalmartItemCompliance" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "storeIndex"   INTEGER NOT NULL DEFAULT 1,
    "capturedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemId"       TEXT NOT NULL,
    "sku"          TEXT,
    "title"        TEXT,
    "issueType"    TEXT NOT NULL,
    "issueDetails" TEXT,
    "severity"     TEXT NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'OPEN',
    "reportedAt"   DATETIME NOT NULL,
    "resolvedAt"   DATETIME
  )
`);
await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS "WalmartItemCompliance_itemId_issueType_key" ON "WalmartItemCompliance"("itemId", "issueType")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "WalmartItemCompliance_storeIndex_idx" ON "WalmartItemCompliance"("storeIndex")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "WalmartItemCompliance_status_idx"     ON "WalmartItemCompliance"("status")`);

await client.execute(`
  CREATE TABLE IF NOT EXISTS "CriticalAlert" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "storeId"           TEXT NOT NULL,
    "channel"           TEXT NOT NULL,
    "alertType"         TEXT NOT NULL,
    "severity"          TEXT NOT NULL,
    "metricName"        TEXT NOT NULL,
    "metricValue"       TEXT NOT NULL,
    "metricThreshold"   TEXT NOT NULL,
    "title"             TEXT NOT NULL,
    "message"           TEXT NOT NULL,
    "actionUrl"         TEXT,
    "detectedAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "telegramSent"      INTEGER NOT NULL DEFAULT 0,
    "telegramSentAt"    DATETIME,
    "telegramMessageId" TEXT,
    "acknowledged"      INTEGER NOT NULL DEFAULT 0,
    "acknowledgedAt"    DATETIME,
    "acknowledgedBy"    TEXT,
    "resolvedAt"        DATETIME
  )
`);
await client.execute(`CREATE INDEX IF NOT EXISTS "CriticalAlert_storeId_idx"      ON "CriticalAlert"("storeId")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "CriticalAlert_acknowledged_idx" ON "CriticalAlert"("acknowledged")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "CriticalAlert_detectedAt_idx"   ON "CriticalAlert"("detectedAt")`);
await client.execute(`CREATE INDEX IF NOT EXISTS "CriticalAlert_severity_idx"     ON "CriticalAlert"("severity")`);

console.log("\n✅ Migration complete.");
