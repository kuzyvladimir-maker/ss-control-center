// Turso migration: AmazonOrderShipment table for adjustment carrier
// enrichment. Idempotent — checks existence first.
//
//   node -r dotenv/config scripts/turso-migrate-amazon-order-shipment.mjs

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
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='AmazonOrderShipment'`,
});
if (probe.rows.length > 0) {
  console.log("· table already exists — skipping");
  client.close();
  process.exit(0);
}

console.log("Creating AmazonOrderShipment…");
await client.batch(
  [
    `CREATE TABLE "AmazonOrderShipment" (
       "id" TEXT NOT NULL PRIMARY KEY,
       "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt" DATETIME NOT NULL,
       "amazonOrderId" TEXT NOT NULL,
       "sku" TEXT,
       "asin" TEXT,
       "storeIndex" INTEGER,
       "carrier" TEXT,
       "trackingNumber" TEXT,
       "shipServiceLevel" TEXT,
       "shipDate" TEXT,
       "promiseDate" TEXT,
       "carrierInferred" TEXT
     )`,
    `CREATE UNIQUE INDEX "AmazonOrderShipment_amazonOrderId_sku_key"
       ON "AmazonOrderShipment"("amazonOrderId", "sku")`,
    `CREATE INDEX "AmazonOrderShipment_amazonOrderId_idx"
       ON "AmazonOrderShipment"("amazonOrderId")`,
    `CREATE INDEX "AmazonOrderShipment_trackingNumber_idx"
       ON "AmazonOrderShipment"("trackingNumber")`,
  ],
  "write",
);

const MIGRATION_NAME = "20260530000000_amazon_order_shipment";
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

console.log("✓ AmazonOrderShipment migration done.");
client.close();
