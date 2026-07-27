// Turso migration: add mainImageUrl + mainImageFetchedAt to WalmartCatalogItem.

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

const cols = await client.execute({
  sql: `PRAGMA table_info("WalmartCatalogItem")`,
});
const have = new Set(cols.rows.map((r) => r.name));

const statements = [];
if (!have.has("mainImageUrl")) {
  statements.push(
    `ALTER TABLE "WalmartCatalogItem" ADD COLUMN "mainImageUrl" TEXT`,
  );
}
if (!have.has("mainImageFetchedAt")) {
  statements.push(
    `ALTER TABLE "WalmartCatalogItem" ADD COLUMN "mainImageFetchedAt" DATETIME`,
  );
}

if (statements.length === 0) {
  console.log("· both columns already present — skipping");
  client.close();
  process.exit(0);
}

await client.batch(statements, "write");

const MIGRATION_NAME = "20260530070000_walmart_catalog_images";
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

console.log(`✓ WalmartCatalogItem image columns migration done (added ${statements.length}).`);
client.close();
