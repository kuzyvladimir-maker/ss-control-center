// One-off Turso migration for Bundle Factory Phase 2.2
// (Variation Matrix + Generated Content).
//
// Mirrors prisma/migrations/20260519020000_phase_2_2_content_generation/migration.sql
// idempotently — every CREATE TABLE / CREATE INDEX uses IF NOT EXISTS.
// Safe to re-run.
//
// NOT run automatically. Vladimir runs this manually after PR review:
//   node scripts/turso-migrate-phase-2-2-content-generation.mjs
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

console.log("\nCreating VariationMatrix…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "VariationMatrix" (
    "id"                    TEXT NOT NULL PRIMARY KEY,
    "bundle_draft_id"       TEXT NOT NULL,
    "variants_json"         TEXT NOT NULL,
    "selected_variant_idx"  INTEGER,
    "generation_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "generated_at"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selected_at"           DATETIME,
    "created_at"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            DATETIME NOT NULL,
    CONSTRAINT "VariationMatrix_bundle_draft_id_fkey"
      FOREIGN KEY ("bundle_draft_id") REFERENCES "BundleDraft" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
  )
`);

console.log("Creating GeneratedContent…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "GeneratedContent" (
    "id"                     TEXT NOT NULL PRIMARY KEY,
    "bundle_draft_id"        TEXT NOT NULL,
    "channel"                TEXT NOT NULL,
    "template"               TEXT NOT NULL,
    "title"                  TEXT NOT NULL,
    "bullets_json"           TEXT NOT NULL,
    "description"            TEXT NOT NULL,
    "compliance_status"      TEXT NOT NULL DEFAULT 'PENDING',
    "compliance_check_id"    TEXT,
    "compliance_attempts"    INTEGER NOT NULL DEFAULT 0,
    "manual_review_required" INTEGER NOT NULL DEFAULT 0,
    "failed_rule_ids"        TEXT,
    "generation_cost_cents"  INTEGER NOT NULL DEFAULT 0,
    "claude_response_id"     TEXT,
    "claude_input_tokens"    INTEGER NOT NULL DEFAULT 0,
    "claude_output_tokens"   INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens"      INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens"     INTEGER NOT NULL DEFAULT 0,
    "created_at"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             DATETIME NOT NULL,
    CONSTRAINT "GeneratedContent_bundle_draft_id_fkey"
      FOREIGN KEY ("bundle_draft_id") REFERENCES "BundleDraft" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
  )
`);

console.log("\nCreating indexes…");
const indexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "VariationMatrix_bundle_draft_id_key"
     ON "VariationMatrix" ("bundle_draft_id")`,
  `CREATE INDEX IF NOT EXISTS "VariationMatrix_bundle_draft_id_idx"
     ON "VariationMatrix" ("bundle_draft_id")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "GeneratedContent_bundle_draft_id_channel_key"
     ON "GeneratedContent" ("bundle_draft_id", "channel")`,
  `CREATE INDEX IF NOT EXISTS "GeneratedContent_bundle_draft_id_idx"
     ON "GeneratedContent" ("bundle_draft_id")`,
  `CREATE INDEX IF NOT EXISTS "GeneratedContent_compliance_status_idx"
     ON "GeneratedContent" ("compliance_status")`,
  `CREATE INDEX IF NOT EXISTS "GeneratedContent_manual_review_required_idx"
     ON "GeneratedContent" ("manual_review_required")`,
];
for (const stmt of indexes) {
  await client.execute(stmt);
}

console.log("\n✓ Phase 2.2 content-generation tables + indexes applied.");
client.close();
