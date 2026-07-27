// One-off Turso migration for Bundle Factory Phase 2.4 Stage 6
// (Validation Pipeline).
//
// Adds 12 columns to ChannelSKU plus one index. Idempotent via ADD COLUMN
// error trapping (SQLite has no IF NOT EXISTS for columns).
//
// NOT run automatically. Vladimir runs this manually after PR review:
//   node -r dotenv/config scripts/turso-migrate-phase-2-4-validation.mjs
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

const alters = [
  { label: "ChannelSKU.main_image_url",           sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "main_image_url" TEXT` },
  { label: "ChannelSKU.validation_status",        sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "validation_status" TEXT NOT NULL DEFAULT 'PENDING'` },
  { label: "ChannelSKU.validation_errors",        sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "validation_errors" TEXT` },
  { label: "ChannelSKU.validated_at",             sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "validated_at" DATETIME` },
  { label: "ChannelSKU.validation_check_id",      sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "validation_check_id" TEXT` },
  { label: "ChannelSKU.validation_attempt_count", sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "validation_attempt_count" INTEGER NOT NULL DEFAULT 0` },
  { label: "ChannelSKU.package_length_in",        sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "package_length_in" REAL` },
  { label: "ChannelSKU.package_width_in",         sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "package_width_in" REAL` },
  { label: "ChannelSKU.package_height_in",        sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "package_height_in" REAL` },
  { label: "ChannelSKU.package_weight_oz",        sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "package_weight_oz" REAL` },
  { label: "ChannelSKU.country_of_origin",        sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "country_of_origin" TEXT DEFAULT 'US'` },
  { label: "ChannelSKU.item_type",                sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "item_type" TEXT` },
];

let applied = 0, skipped = 0;
for (const a of alters) {
  try {
    await client.execute(a.sql);
    console.log(`  ✓ added ${a.label}`);
    applied++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate column|already exists/i.test(msg)) {
      console.log(`  · skip  ${a.label} (already exists)`);
      skipped++;
      continue;
    }
    console.error(`  ✗ FAIL  ${a.label}: ${msg}`);
    process.exit(2);
  }
}

await client.execute(
  `CREATE INDEX IF NOT EXISTS "ChannelSKU_validation_status_idx" ON "ChannelSKU" ("validation_status")`,
);

console.log(`\n✓ Phase 2.4 validation migration done — added ${applied}, skipped ${skipped}.`);
client.close();
