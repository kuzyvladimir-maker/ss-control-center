// Turso migration: SkuTemperatureClass + SkuTemperatureClassChange tables for
// the weather-aware shipping rate engine (topic 135, 2026-10-23).
//
// Additive + idempotent. Run with:
//   node scripts/turso-migrate-sku-temperature-class.mjs
// against the Turso env (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN). Seeding of the
// 39 approved SKUs lives in a separate script
// (scripts/seed-sku-temperature-class.mjs) so this migration is pure schema.

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

const classProbe = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='SkuTemperatureClass'`,
});
if (classProbe.rows.length === 0) {
  await client.batch(
    [
      `CREATE TABLE "SkuTemperatureClass" (
         "id" TEXT NOT NULL PRIMARY KEY,
         "sku" TEXT NOT NULL,
         "class" TEXT NOT NULL,
         "source" TEXT NOT NULL DEFAULT 'manual',
         "setBy" TEXT,
         "note" TEXT,
         "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
      `CREATE UNIQUE INDEX "SkuTemperatureClass_sku_key" ON "SkuTemperatureClass"("sku")`,
    ],
    "write",
  );
  console.log("· SkuTemperatureClass created");
} else {
  console.log("· SkuTemperatureClass already exists");
}

const changeProbe = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='SkuTemperatureClassChange'`,
});
if (changeProbe.rows.length === 0) {
  await client.batch(
    [
      `CREATE TABLE "SkuTemperatureClassChange" (
         "id" TEXT NOT NULL PRIMARY KEY,
         "sku" TEXT NOT NULL,
         "fromClass" TEXT,
         "toClass" TEXT NOT NULL,
         "source" TEXT NOT NULL,
         "setBy" TEXT,
         "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
      `CREATE INDEX "SkuTemperatureClassChange_sku_idx" ON "SkuTemperatureClassChange"("sku")`,
    ],
    "write",
  );
  console.log("· SkuTemperatureClassChange created");
} else {
  console.log("· SkuTemperatureClassChange already exists");
}

const MIGRATION_NAME = "20261023170000_sku_temperature_class";
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

console.log("✓ SkuTemperatureClass migration done.");
client.close();
