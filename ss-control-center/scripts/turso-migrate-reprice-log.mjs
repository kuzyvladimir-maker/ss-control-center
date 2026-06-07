// One-off Turso migration creating the RepriceLog table.
//
// Mirrors prisma/migrations/20260607150000_reprice_log/migration.sql
// idempotently — CREATE TABLE IF NOT EXISTS so it's safe to re-run.
//
// NOT run automatically. Run manually after the PR is merged:
//   node scripts/turso-migrate-reprice-log.mjs
//
// Required env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.

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

await client.execute(`
  CREATE TABLE IF NOT EXISTS "RepriceLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storeIndex" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "asin" TEXT,
    "title" TEXT,
    "oldPrice" REAL NOT NULL,
    "newPrice" REAL,
    "shipping" REAL NOT NULL DEFAULT 0,
    "targetLanded" REAL,
    "competitors" INTEGER NOT NULL DEFAULT 0,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false
  )
`);
console.log("  + RepriceLog table ready");

await client.execute(
  `CREATE INDEX IF NOT EXISTS "RepriceLog_storeIndex_createdAt_idx" ON "RepriceLog"("storeIndex", "createdAt")`,
);
await client.execute(
  `CREATE INDEX IF NOT EXISTS "RepriceLog_sku_idx" ON "RepriceLog"("sku")`,
);
console.log("  + indexes ready");

console.log("\n✓ RepriceLog migration applied.");
client.close();
