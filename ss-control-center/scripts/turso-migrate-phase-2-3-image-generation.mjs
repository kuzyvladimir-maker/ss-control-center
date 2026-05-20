// One-off Turso migration for Bundle Factory Phase 2.3 Stage 5
// (Main Image Generation).
//
// Adds image-related columns to BundleDraft + GeneratedContent. Every
// ALTER TABLE is wrapped in a try/catch so re-runs are safe — SQLite
// has no "ADD COLUMN IF NOT EXISTS", so we treat the duplicate-column
// error as "already applied" and continue.
//
// NOT run automatically. Vladimir runs this manually after PR review:
//   node scripts/turso-migrate-phase-2-3-image-generation.mjs
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

// Each entry = { sql, label }. We try every one; "duplicate column" errors
// are logged as skipped (idempotent re-run) but anything else aborts.
const alters = [
  {
    label: "BundleDraft.image_generated_at",
    sql: `ALTER TABLE "BundleDraft" ADD COLUMN "image_generated_at" DATETIME`,
  },
  {
    label: "GeneratedContent.main_image_url",
    sql: `ALTER TABLE "GeneratedContent" ADD COLUMN "main_image_url" TEXT`,
  },
  {
    label: "GeneratedContent.image_generation_cost_cents",
    sql: `ALTER TABLE "GeneratedContent" ADD COLUMN "image_generation_cost_cents" INTEGER NOT NULL DEFAULT 0`,
  },
  {
    label: "GeneratedContent.image_retry_count",
    sql: `ALTER TABLE "GeneratedContent" ADD COLUMN "image_retry_count" INTEGER NOT NULL DEFAULT 0`,
  },
  {
    label: "GeneratedContent.image_generated_at",
    sql: `ALTER TABLE "GeneratedContent" ADD COLUMN "image_generated_at" DATETIME`,
  },
];

let applied = 0;
let skipped = 0;

for (const a of alters) {
  try {
    await client.execute(a.sql);
    console.log(`  ✓ added ${a.label}`);
    applied++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // libsql/sqlite duplicate-column error wording.
    if (/duplicate column|already exists/i.test(msg)) {
      console.log(`  · skip  ${a.label} (already exists)`);
      skipped++;
      continue;
    }
    console.error(`  ✗ FAIL  ${a.label}: ${msg}`);
    process.exit(2);
  }
}

console.log(
  `\n✓ Phase 2.3 image-generation migration done — added ${applied}, skipped ${skipped}.`,
);
client.close();
