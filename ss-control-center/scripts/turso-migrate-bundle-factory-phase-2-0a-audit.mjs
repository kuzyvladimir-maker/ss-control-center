// One-off Turso migration for Bundle Factory Phase 2.0a (Listing Audit).
//
// Mirrors prisma/migrations/20260517010000_bundle_factory_phase_2_0a_audit/migration.sql
// idempotently — every CREATE TABLE / CREATE INDEX uses IF NOT EXISTS.
// Safe to re-run.
//
// NOT run automatically. Vladimir runs this manually after PR review:
//   node scripts/turso-migrate-bundle-factory-phase-2-0a-audit.mjs
//
// Required env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.
//
// After this script completes successfully, optionally seed the
// permanent blocklist into production:
//   SEED_TARGET=turso npx tsx prisma/seed.ts

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

// ─── Tables ──────────────────────────────────────────────────────────

console.log("\nCreating ListingAuditScan…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ListingAuditScan" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "initiated_by"     TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'pending',
    "started_at"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"     DATETIME,
    "accounts_scanned" TEXT NOT NULL,
    "total_listings"   INTEGER NOT NULL DEFAULT 0,
    "blocked_count"    INTEGER NOT NULL DEFAULT 0,
    "warning_count"    INTEGER NOT NULL DEFAULT 0,
    "low_risk_count"   INTEGER NOT NULL DEFAULT 0,
    "compliant_count"  INTEGER NOT NULL DEFAULT 0,
    "error_message"    TEXT
  )
`);

console.log("Creating ListingAuditResult…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ListingAuditResult" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
    "scan_id"              TEXT NOT NULL,
    "asin"                 TEXT NOT NULL,
    "sku"                  TEXT,
    "account"              TEXT NOT NULL,
    "title"                TEXT NOT NULL,
    "brand"                TEXT NOT NULL,
    "browse_node"          TEXT,
    "main_image_url"       TEXT,
    "original_bullets"     TEXT NOT NULL,
    "original_description" TEXT NOT NULL DEFAULT '',
    "risk_score"           INTEGER NOT NULL DEFAULT 0,
    "risk_category"        TEXT NOT NULL DEFAULT 'COMPLIANT',
    "risk_reasons"         TEXT NOT NULL DEFAULT '[]',
    "detected_brands"      TEXT,
    "detected_logos"       TEXT,
    "vision_cost_cents"    INTEGER NOT NULL DEFAULT 0,
    "remediation_status"   TEXT NOT NULL DEFAULT 'PENDING',
    "created_at"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           DATETIME NOT NULL,
    CONSTRAINT "ListingAuditResult_scan_id_fkey"
      FOREIGN KEY ("scan_id") REFERENCES "ListingAuditScan" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
  )
`);

console.log("Creating ListingRemediation…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ListingRemediation" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
    "audit_result_id"      TEXT NOT NULL,
    "status"               TEXT NOT NULL DEFAULT 'pending',
    "original_title"       TEXT NOT NULL,
    "new_title"            TEXT,
    "original_bullets"     TEXT NOT NULL,
    "new_bullets"          TEXT,
    "original_description" TEXT NOT NULL,
    "new_description"      TEXT,
    "original_image_url"   TEXT,
    "new_image_url"        TEXT,
    "ai_cost_cents"        INTEGER NOT NULL DEFAULT 0,
    "sp_api_response"      TEXT,
    "sp_api_error"         TEXT,
    "started_at"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"         DATETIME,
    CONSTRAINT "ListingRemediation_audit_result_id_fkey"
      FOREIGN KEY ("audit_result_id") REFERENCES "ListingAuditResult" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
  )
`);

console.log("Creating BrandConflict…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "BrandConflict" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "asin"             TEXT,
    "account"          TEXT,
    "foreign_brand"    TEXT NOT NULL,
    "product_keywords" TEXT NOT NULL,
    "incident_date"    DATETIME NOT NULL,
    "incident_type"    TEXT NOT NULL,
    "amazon_action"    TEXT,
    "notes"            TEXT,
    "status"           TEXT NOT NULL DEFAULT 'active',
    "resolved_at"      DATETIME,
    "created_at"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

// ─── Indexes ─────────────────────────────────────────────────────────

console.log("\nCreating indexes…");
const indexStatements = [
  `CREATE INDEX IF NOT EXISTS "ListingAuditScan_initiated_by_started_at_idx"
     ON "ListingAuditScan" ("initiated_by", "started_at")`,
  `CREATE INDEX IF NOT EXISTS "ListingAuditScan_status_idx"
     ON "ListingAuditScan" ("status")`,
  `CREATE INDEX IF NOT EXISTS "ListingAuditResult_scan_id_risk_category_idx"
     ON "ListingAuditResult" ("scan_id", "risk_category")`,
  `CREATE INDEX IF NOT EXISTS "ListingAuditResult_asin_idx"
     ON "ListingAuditResult" ("asin")`,
  `CREATE INDEX IF NOT EXISTS "ListingAuditResult_account_risk_category_idx"
     ON "ListingAuditResult" ("account", "risk_category")`,
  `CREATE INDEX IF NOT EXISTS "ListingAuditResult_remediation_status_idx"
     ON "ListingAuditResult" ("remediation_status")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ListingRemediation_audit_result_id_key"
     ON "ListingRemediation" ("audit_result_id")`,
  `CREATE INDEX IF NOT EXISTS "ListingRemediation_status_idx"
     ON "ListingRemediation" ("status")`,
  `CREATE INDEX IF NOT EXISTS "BrandConflict_foreign_brand_idx"
     ON "BrandConflict" ("foreign_brand")`,
  `CREATE INDEX IF NOT EXISTS "BrandConflict_asin_idx"
     ON "BrandConflict" ("asin")`,
  `CREATE INDEX IF NOT EXISTS "BrandConflict_status_idx"
     ON "BrandConflict" ("status")`,
];

for (const stmt of indexStatements) {
  await client.execute(stmt);
}

console.log("\n✓ Phase 2.0a audit tables + indexes applied.");
console.log(
  "Next step (optional, only if you want the 5-ASIN blocklist in prod):\n" +
    "  SEED_TARGET=turso npx tsx prisma/seed.ts",
);

client.close();
