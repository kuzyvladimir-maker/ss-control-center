// Turso migration: Walmart Growth Phase B — Buy Box (WalmartReport + WalmartBuyBoxItem).
// Additive only. Idempotent (exits if WalmartReport already exists).
//   node -r dotenv/config scripts/turso-migrate-walmart-buybox.mjs

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
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartReport'`,
});
if (existing.rows.length > 0) {
  console.log("· already migrated (WalmartReport present) — skipping");
  client.close();
  process.exit(0);
}

console.log("Creating Buy Box tables…");
await client.batch(
  [
    `CREATE TABLE "WalmartReport" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "storeIndex" INTEGER NOT NULL DEFAULT 1,
       "reportType" TEXT NOT NULL,
       "requestId" TEXT NOT NULL,
       "status" TEXT NOT NULL DEFAULT 'REQUESTED',
       "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "statusCheckedAt" DATETIME,
       "readyAt" DATETIME,
       "downloadedAt" DATETIME,
       "rowCount" INTEGER,
       "error" TEXT,
       "updatedAt" DATETIME NOT NULL
     )`,
    `CREATE UNIQUE INDEX "WalmartReport_requestId_key" ON "WalmartReport"("requestId")`,
    `CREATE INDEX "WalmartReport_storeIndex_reportType_requestedAt_idx" ON "WalmartReport"("storeIndex", "reportType", "requestedAt")`,
    `CREATE INDEX "WalmartReport_status_idx" ON "WalmartReport"("status")`,
    `CREATE TABLE "WalmartBuyBoxItem" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "storeIndex" INTEGER NOT NULL DEFAULT 1,
       "sku" TEXT NOT NULL,
       "itemId" TEXT,
       "productName" TEXT,
       "productCategory" TEXT,
       "sellerItemPrice" REAL,
       "sellerShipPrice" REAL,
       "sellerTotalPrice" REAL,
       "isWinner" BOOLEAN NOT NULL DEFAULT false,
       "buyBoxItemPrice" REAL,
       "buyBoxShipPrice" REAL,
       "buyBoxTotalPrice" REAL,
       "priceGap" REAL,
       "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE UNIQUE INDEX "WalmartBuyBoxItem_storeIndex_sku_key" ON "WalmartBuyBoxItem"("storeIndex", "sku")`,
    `CREATE INDEX "WalmartBuyBoxItem_storeIndex_isWinner_idx" ON "WalmartBuyBoxItem"("storeIndex", "isWinner")`,
    `CREATE INDEX "WalmartBuyBoxItem_storeIndex_priceGap_idx" ON "WalmartBuyBoxItem"("storeIndex", "priceGap")`,
  ],
  "write",
);

const MIGRATION_NAME = "20260607150000_walmart_buybox";
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

// Register the already-fired Buy Box request so the cron continues IT rather
// than burning the tiny /reports rate bucket on a duplicate. Skips gracefully
// if the env var isn't provided.
const inflight = process.env.INFLIGHT_BUYBOX_REQUEST_ID;
if (inflight) {
  try {
    await client.execute({
      sql: `INSERT INTO "WalmartReport" ("id","storeIndex","reportType","requestId","status","requestedAt","updatedAt")
            VALUES (?, 1, 'BUYBOX', ?, 'INPROGRESS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      args: [crypto.randomUUID(), inflight],
    });
    console.log(`✓ registered in-flight Buy Box request ${inflight}`);
  } catch (e) {
    console.log(`  (in-flight registration skipped: ${e instanceof Error ? e.message : e})`);
  }
}

console.log("✓ Buy Box migration done.");
client.close();
