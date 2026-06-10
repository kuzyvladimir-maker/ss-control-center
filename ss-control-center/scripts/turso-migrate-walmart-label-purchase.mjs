// Turso migration: WalmartLabelPurchase table.
//
// Durable record of Ship-with-Walmart labels we buy, so a freshly-bought
// label can never reappear as buyable while Walmart's labels endpoint is
// still catching up (the double-buy window). Additive + idempotent —
// CREATE TABLE IF NOT EXISTS, never touches existing data.
//
// Run against whichever DB the TURSO_* env points at (prod by default;
// pass a local file via DATABASE_URL fallback for dev):
//   node -r dotenv/config scripts/turso-migrate-walmart-label-purchase.mjs

import { createClient } from "@libsql/client";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

const url = clean(process.env.TURSO_DATABASE_URL) || clean(process.env.DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url) {
  console.error("Missing TURSO_DATABASE_URL (or DATABASE_URL)");
  process.exit(1);
}

const client = createClient(authToken ? { url, authToken } : { url });
console.log(`→ Target: ${url.split("@")[1] || url}`);

// Idempotency probe.
const existing = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartLabelPurchase'`,
});
if (existing.rows.length > 0) {
  console.log("· WalmartLabelPurchase already exists — skipping");
  client.close();
  process.exit(0);
}

console.log("Creating WalmartLabelPurchase…");
await client.batch(
  [
    `CREATE TABLE IF NOT EXISTS "WalmartLabelPurchase" (
       "id"              TEXT PRIMARY KEY NOT NULL,
       "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"       DATETIME NOT NULL,
       "purchaseOrderId" TEXT NOT NULL,
       "customerOrderId" TEXT NOT NULL,
       "storeIndex"      INTEGER NOT NULL DEFAULT 1,
       "trackingNumber"  TEXT NOT NULL,
       "carrierName"     TEXT NOT NULL,
       "serviceType"     TEXT,
       "boughtAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "discardedAt"     DATETIME
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "WalmartLabelPurchase_purchaseOrderId_key" ON "WalmartLabelPurchase"("purchaseOrderId")`,
    `CREATE INDEX IF NOT EXISTS "WalmartLabelPurchase_customerOrderId_idx" ON "WalmartLabelPurchase"("customerOrderId")`,
  ],
  "write",
);

const check = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='WalmartLabelPurchase'`,
});
console.log(check.rows.length > 0 ? "✓ created" : "✗ FAILED — table not present after create");
client.close();
process.exit(check.rows.length > 0 ? 0 : 3);
