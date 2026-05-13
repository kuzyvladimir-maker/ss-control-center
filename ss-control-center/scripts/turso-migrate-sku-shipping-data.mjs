// One-off migration: create the SkuShippingData table on Turso.
// Run with: node --env-file=.env scripts/turso-migrate-sku-shipping-data.mjs
// Idempotent — safe to re-run (uses IF NOT EXISTS).

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

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "SkuShippingData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "productTitle" TEXT,
    "marketplace" TEXT,
    "category" TEXT,
    "length" REAL,
    "width" REAL,
    "height" REAL,
    "weight" REAL,
    "weightFedex" REAL,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SkuShippingData_sku_key" ON "SkuShippingData"("sku")`,
];

for (const sql of STATEMENTS) {
  const head = sql.replace(/\s+/g, " ").slice(0, 80);
  try {
    await client.execute(sql);
    console.log(`OK  ${head}`);
  } catch (e) {
    console.error(`ERR ${head}`);
    console.error("    ", e.message ?? e);
    process.exit(2);
  }
}

console.log("\n✓ SkuShippingData table ensured on Turso.");
process.exit(0);
