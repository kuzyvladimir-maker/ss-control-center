// One-off migration: create the CatalogSnapshot table on Turso.
// Run: node --env-file=.env.local --env-file=.env scripts/turso-migrate-catalog-snapshot.mjs
// Idempotent (IF NOT EXISTS).
//
// CatalogSnapshot = one row per hourly capture of catalog/COGS/enrichment progress.
// It's the time-series behind the Catalog Status dashboard's graph — how coverage,
// enrichment, and quality move as the background crons grind through the catalog.

import { createClient } from "@libsql/client";

function clean(v) { return v ? v.trim().replace(/^['"]|['"]$/g, "") : v; }
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN"); process.exit(1); }

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "CatalogSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "walmartTotal" INTEGER NOT NULL DEFAULT 0,
    "walmartPublished" INTEGER NOT NULL DEFAULT 0,
    "costedTotal" INTEGER NOT NULL DEFAULT 0,
    "costedPublished" INTEGER NOT NULL DEFAULT 0,
    "needsReview" INTEGER NOT NULL DEFAULT 0,
    "ownBrand" INTEGER NOT NULL DEFAULT 0,
    "exact" INTEGER NOT NULL DEFAULT 0,
    "linePrice" INTEGER NOT NULL DEFAULT 0,
    "google" INTEGER NOT NULL DEFAULT 0,
    "donorProducts" INTEGER NOT NULL DEFAULT 0,
    "donorOffers" INTEGER NOT NULL DEFAULT 0,
    "withBom" INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS "CatalogSnapshot_capturedAt_idx" ON "CatalogSnapshot"("capturedAt")`,
];

for (const sql of STATEMENTS) {
  const head = sql.replace(/\s+/g, " ").slice(0, 80);
  try { await client.execute(sql); console.log(`OK  ${head}`); }
  catch (e) { console.error(`ERR ${head}`); console.error("    ", e.message ?? e); process.exit(2); }
}
console.log("\n✓ CatalogSnapshot table ensured on Turso.");
process.exit(0);
