// One-off Turso migration creating the ProductPackSizeCache table.
//
// Mirrors prisma/migrations/20260605120000_product_pack_size_cache/migration.sql
// idempotently. Uses CREATE TABLE IF NOT EXISTS so the script is safe to
// re-run without checking state first.
//
// NOT run automatically. Run manually after the PR is merged:
//   node scripts/turso-migrate-product-pack-size-cache.mjs
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

try {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS "ProductPackSizeCache" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "rawTitle" TEXT NOT NULL,
      "size" INTEGER NOT NULL,
      "label" TEXT NOT NULL,
      "source" TEXT NOT NULL DEFAULT 'ai',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS "ProductPackSizeCache_rawTitle_key"
    ON "ProductPackSizeCache"("rawTitle")
  `);
  console.log("✓ ProductPackSizeCache table + index ready");
} catch (e) {
  console.error("✗ Migration failed:", e?.message ?? e);
  process.exit(1);
}

console.log("Done.");
