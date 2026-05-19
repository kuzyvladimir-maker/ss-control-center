// One-off Turso migration for Bundle Factory Phase 2.0 (Compliance Gate).
//
// Mirrors prisma/migrations/20260519010000_phase_2_0_compliance_gate/migration.sql
// idempotently. CREATE TABLE / CREATE INDEX use IF NOT EXISTS. The
// ALTER TABLE ADD COLUMN statements (SQLite has no IF NOT EXISTS for
// those) are wrapped in try/catch — a duplicate-column error is treated
// as already-applied. Safe to re-run.
//
// BrandConflict was created and seeded in Phase 2.0a — this script does
// NOT touch that table.
//
// NOT run automatically. Vladimir runs this manually after PR review:
//   node scripts/turso-migrate-phase-2-0-compliance-gate.mjs
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

// ─── Tables ──────────────────────────────────────────────────────────

console.log("\nCreating ComplianceCheck…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ComplianceCheck" (
    "id"                 TEXT NOT NULL PRIMARY KEY,
    "bundle_draft_id"    TEXT NOT NULL,
    "channel_sku_id"     TEXT,
    "decision"           TEXT NOT NULL,
    "hard_rules_passed"  TEXT NOT NULL,
    "hard_rules_failed"  TEXT NOT NULL,
    "detected_brands"    TEXT,
    "detected_logos"     TEXT,
    "ai_vision_response" TEXT,
    "cost_cents"         INTEGER NOT NULL DEFAULT 0,
    "created_at"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplianceCheck_bundle_draft_id_fkey"
      FOREIGN KEY ("bundle_draft_id") REFERENCES "BundleDraft" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ComplianceCheck_channel_sku_id_fkey"
      FOREIGN KEY ("channel_sku_id") REFERENCES "ChannelSKU" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
  )
`);

console.log("Creating ComplianceAuditLog…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ComplianceAuditLog" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "bundle_draft_id" TEXT NOT NULL,
    "channel_sku_id"  TEXT,
    "event_type"      TEXT NOT NULL,
    "event_details"   TEXT NOT NULL,
    "actor"           TEXT NOT NULL,
    "decision"        TEXT,
    "created_at"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

// ─── Indexes ─────────────────────────────────────────────────────────

console.log("\nCreating indexes…");
const indexStatements = [
  `CREATE INDEX IF NOT EXISTS "ComplianceCheck_bundle_draft_id_created_at_idx"
     ON "ComplianceCheck" ("bundle_draft_id", "created_at")`,
  `CREATE INDEX IF NOT EXISTS "ComplianceCheck_decision_idx"
     ON "ComplianceCheck" ("decision")`,
  `CREATE INDEX IF NOT EXISTS "ComplianceAuditLog_bundle_draft_id_created_at_idx"
     ON "ComplianceAuditLog" ("bundle_draft_id", "created_at")`,
  `CREATE INDEX IF NOT EXISTS "ComplianceAuditLog_event_type_idx"
     ON "ComplianceAuditLog" ("event_type")`,
];
for (const stmt of indexStatements) {
  await client.execute(stmt);
}

// ─── ALTER TABLE — guarded ───────────────────────────────────────────
//
// libsql / SQLite raises an error if the column already exists. We catch
// that one specifically and treat it as "already applied"; anything else
// re-throws.

async function addColumnIfMissing(table, column, ddl) {
  try {
    await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
    console.log(`  + ${table}.${column} added`);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).toLowerCase();
    if (msg.includes("duplicate column") || msg.includes("already exists")) {
      console.log(`  · ${table}.${column} already present — skipping`);
      return;
    }
    throw e;
  }
}

console.log("\nAdding BundleDraft.compliance_* columns…");
await addColumnIfMissing(
  "BundleDraft",
  "compliance_status",
  `"compliance_status" TEXT NOT NULL DEFAULT 'PENDING'`,
);
await addColumnIfMissing(
  "BundleDraft",
  "compliance_check_id",
  `"compliance_check_id" TEXT`,
);
await addColumnIfMissing(
  "BundleDraft",
  "compliance_blocked_at",
  `"compliance_blocked_at" DATETIME`,
);
await addColumnIfMissing(
  "BundleDraft",
  "compliance_blocked_reasons",
  `"compliance_blocked_reasons" TEXT`,
);

console.log("\nAdding ChannelSKU.compliance_* columns…");
await addColumnIfMissing(
  "ChannelSKU",
  "compliance_status",
  `"compliance_status" TEXT NOT NULL DEFAULT 'PENDING'`,
);
await addColumnIfMissing(
  "ChannelSKU",
  "compliance_check_id",
  `"compliance_check_id" TEXT`,
);
await addColumnIfMissing(
  "ChannelSKU",
  "compliance_blocked_at",
  `"compliance_blocked_at" DATETIME`,
);
await addColumnIfMissing(
  "ChannelSKU",
  "compliance_blocked_reasons",
  `"compliance_blocked_reasons" TEXT`,
);

await client.execute(
  `CREATE INDEX IF NOT EXISTS "BundleDraft_compliance_status_idx"
     ON "BundleDraft" ("compliance_status")`,
);
await client.execute(
  `CREATE INDEX IF NOT EXISTS "ChannelSKU_compliance_status_idx"
     ON "ChannelSKU" ("compliance_status")`,
);

console.log("\n✓ Phase 2.0 compliance-gate tables + columns + indexes applied.");
console.log(
  "BrandConflict was created and seeded in Phase 2.0a — left untouched.",
);

client.close();
