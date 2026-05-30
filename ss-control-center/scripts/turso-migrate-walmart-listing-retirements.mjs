// Turso migration: WalmartListingRetirement table.

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

const probe = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartListingRetirement'`,
});
if (probe.rows.length > 0) {
  console.log("· table already exists — skipping");
  client.close();
  process.exit(0);
}

await client.batch(
  [
    `CREATE TABLE "WalmartListingRetirement" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "sku" TEXT NOT NULL,
       "storeIndex" INTEGER NOT NULL DEFAULT 1,
       "itemId" TEXT,
       "productTitle" TEXT,
       "previousQty" INTEGER,
       "reason" TEXT,
       "triggeredFrom" TEXT,
       "searchQuery" TEXT,
       "retiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "rolledBackAt" DATETIME,
       "rolledBackBy" TEXT
     )`,
    `CREATE INDEX "WalmartListingRetirement_storeIndex_retiredAt_idx"
       ON "WalmartListingRetirement"("storeIndex", "retiredAt")`,
    `CREATE INDEX "WalmartListingRetirement_sku_idx"
       ON "WalmartListingRetirement"("sku")`,
  ],
  "write",
);

const MIGRATION_NAME = "20260530060000_walmart_listing_retirements";
try {
  await client.execute({
    sql: `INSERT INTO "_prisma_migrations"
            ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
          VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    args: [crypto.randomUUID(), "turso-applied", MIGRATION_NAME],
  });
} catch (e) {
  console.log(`  (_prisma_migrations bookkeeping skipped: ${e.message})`);
}

console.log("✓ WalmartListingRetirement migration done.");
client.close();
