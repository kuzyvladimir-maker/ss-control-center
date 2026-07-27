// Turso migration: Walmart Growth — Listing Quality.
//
// Additive only (CREATE TABLE / CREATE INDEX) — creates:
//   • WalmartListingQualitySnapshot  (seller score history)
//   • WalmartListingQualityItem      (per-SKU worklist)
//   • WalmartLqSyncState             (resumable sweep cursor)
//
// Idempotent — exits early if WalmartListingQualityItem already exists.
//
//   node -r dotenv/config scripts/turso-migrate-walmart-listing-quality.mjs

import { createClient } from "@libsql/client";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

const existing = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartListingQualityItem'`,
});
if (existing.rows.length > 0) {
  console.log("· already migrated (WalmartListingQualityItem present) — skipping");
  client.close();
  process.exit(0);
}

console.log("Creating Listing Quality tables…");

await client.batch(
  [
    `CREATE TABLE "WalmartListingQualitySnapshot" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "storeIndex" INTEGER NOT NULL DEFAULT 1,
       "listingQuality" REAL NOT NULL,
       "offerScore" REAL,
       "ratingReviewScore" REAL,
       "contentScore" REAL,
       "priceScore" REAL,
       "shippingScore" REAL,
       "transactibilityScore" REAL,
       "itemDefectCnt" INTEGER,
       "defectRatio" REAL,
       "rawData" TEXT NOT NULL
     )`,
    `CREATE INDEX "WalmartListingQualitySnapshot_storeIndex_capturedAt_idx"
       ON "WalmartListingQualitySnapshot"("storeIndex", "capturedAt")`,
    `CREATE TABLE "WalmartListingQualityItem" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "storeIndex" INTEGER NOT NULL DEFAULT 1,
       "sku" TEXT NOT NULL,
       "itemId" TEXT,
       "productId" TEXT,
       "productName" TEXT,
       "productType" TEXT,
       "categoryName" TEXT,
       "condition" TEXT,
       "lqScore" REAL,
       "priority" TEXT,
       "ratingReviewScore" REAL,
       "shippingScore" REAL,
       "publishScore" REAL,
       "contentScore" REAL,
       "priceScore" REAL,
       "offerScore" REAL,
       "isInStock" BOOLEAN NOT NULL DEFAULT false,
       "isFastAndFreeShipping" BOOLEAN NOT NULL DEFAULT false,
       "wfsEnabled" BOOLEAN NOT NULL DEFAULT false,
       "ratingCount" INTEGER,
       "pageViews30d" INTEGER,
       "conversionRate30d" REAL,
       "gmv30d" REAL,
       "orders30d" INTEGER,
       "units30d" INTEGER,
       "topFixComponent" TEXT,
       "issueCount" INTEGER NOT NULL DEFAULT 0,
       "issuesSummary" TEXT,
       "scoredAt" DATETIME,
       "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE UNIQUE INDEX "WalmartListingQualityItem_storeIndex_sku_key"
       ON "WalmartListingQualityItem"("storeIndex", "sku")`,
    `CREATE INDEX "WalmartListingQualityItem_storeIndex_lqScore_idx"
       ON "WalmartListingQualityItem"("storeIndex", "lqScore")`,
    `CREATE INDEX "WalmartListingQualityItem_storeIndex_priority_idx"
       ON "WalmartListingQualityItem"("storeIndex", "priority")`,
    `CREATE INDEX "WalmartListingQualityItem_storeIndex_syncedAt_idx"
       ON "WalmartListingQualityItem"("storeIndex", "syncedAt")`,
    `CREATE TABLE "WalmartLqSyncState" (
       "storeIndex" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
       "cursor" TEXT,
       "sweepStartedAt" DATETIME,
       "pagesThisSweep" INTEGER NOT NULL DEFAULT 0,
       "itemsThisSweep" INTEGER NOT NULL DEFAULT 0,
       "lastFullSweepAt" DATETIME,
       "updatedAt" DATETIME NOT NULL
     )`,
  ],
  "write",
);

const MIGRATION_NAME = "20260607130000_walmart_listing_quality";
try {
  await client.execute({
    sql: `INSERT INTO "_prisma_migrations"
            ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
          VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    args: [crypto.randomUUID(), "turso-applied", MIGRATION_NAME],
  });
  console.log(`✓ registered ${MIGRATION_NAME} in _prisma_migrations`);
} catch (e) {
  console.log(`  (_prisma_migrations bookkeeping skipped: ${e instanceof Error ? e.message : e})`);
}

console.log("✓ Listing Quality migration done.");
client.close();
