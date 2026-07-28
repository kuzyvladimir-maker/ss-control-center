// One-off migration: create the SkuComponent table on Turso.
// Run with: node --env-file=.env.local --env-file=.env scripts/turso-migrate-sku-component.mjs
// Idempotent — safe to re-run (uses IF NOT EXISTS).
//
// SkuComponent is the STRUCTURAL bill-of-materials for each of our listings: one
// row per distinct product a SKU is made of (a plain product = 1 row = itself; a
// bundle/gift-set = N rows, one per component). Each row carries the resolved
// per-unit cost + how we got it + a link into DonorProduct for full content
// (photos / description / nutrition). This is what lets the same catalog serve
// three jobs at once: economics (SUM the rows), NEW listings (reuse component
// content), and IMPROVING listings (pull donor photos/nutrition per component).

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
  `CREATE TABLE IF NOT EXISTS "SkuComponent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "channel" TEXT,
    "idx" INTEGER NOT NULL DEFAULT 0,
    "product" TEXT NOT NULL,
    "flavor" TEXT,
    "size" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "perUnitCost" REAL,
    "lineCost" REAL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "retailer" TEXT,
    "matchedTitle" TEXT,
    "costMethod" TEXT,
    "donorProductId" TEXT,
    "isBundleComponent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SkuComponent_sku_idx_key" ON "SkuComponent"("sku", "idx")`,
  `CREATE INDEX IF NOT EXISTS "SkuComponent_sku_idx" ON "SkuComponent"("sku")`,
  `CREATE INDEX IF NOT EXISTS "SkuComponent_donorProductId_idx" ON "SkuComponent"("donorProductId")`,
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

console.log("\n✓ SkuComponent table ensured on Turso.");
process.exit(0);
