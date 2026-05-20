// One-off Turso migration for Bundle Factory Phase 2.5 Stage 7
// (Distribution). Adds 6 columns to ChannelSKU + one index.
// Idempotent — traps duplicate-column on re-run.
//
//   node -r dotenv/config scripts/turso-migrate-phase-2-5-distribution.mjs

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
  { label: "ChannelSKU.listing_status",             sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "listing_status" TEXT NOT NULL DEFAULT 'PENDING'` },
  { label: "ChannelSKU.submission_id",              sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "submission_id" TEXT` },
  { label: "ChannelSKU.published_at",               sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "published_at" DATETIME` },
  { label: "ChannelSKU.distribution_errors",        sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "distribution_errors" TEXT` },
  { label: "ChannelSKU.distribution_attempt_count", sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "distribution_attempt_count" INTEGER NOT NULL DEFAULT 0` },
  { label: "ChannelSKU.last_status_check_at",       sql: `ALTER TABLE "ChannelSKU" ADD COLUMN "last_status_check_at" DATETIME` },
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
  `CREATE INDEX IF NOT EXISTS "ChannelSKU_listing_status_idx" ON "ChannelSKU" ("listing_status")`,
);

console.log(`\n✓ Phase 2.5 distribution migration done — added ${applied}, skipped ${skipped}.`);
client.close();
