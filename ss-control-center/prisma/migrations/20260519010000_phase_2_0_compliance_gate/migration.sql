-- Bundle Factory Phase 2.0 — Compliance Gate migration.
--
-- Adds the protective gate that sits between AI content generation
-- (Stage 4) and Distribution (Stage 7). Each invocation evaluates the
-- 8 hard rules from docs/BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md and
-- writes one ComplianceCheck row plus one ComplianceAuditLog entry.
--
-- BrandConflict (Rule 7's permanent blocklist) was created and seeded
-- back in Phase 2.0a (20260517010000) — we do NOT touch it here.
--
-- Idempotent via `CREATE TABLE IF NOT EXISTS`; safe to re-run.

-- ─── New tables ─────────────────────────────────────────────────────────

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
);

CREATE TABLE IF NOT EXISTS "ComplianceAuditLog" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "bundle_draft_id" TEXT NOT NULL,
    "channel_sku_id"  TEXT,
    "event_type"      TEXT NOT NULL,
    "event_details"   TEXT NOT NULL,
    "actor"           TEXT NOT NULL,
    "decision"        TEXT,
    "created_at"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── Indexes ────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "ComplianceCheck_bundle_draft_id_created_at_idx"
  ON "ComplianceCheck" ("bundle_draft_id", "created_at");
CREATE INDEX IF NOT EXISTS "ComplianceCheck_decision_idx"
  ON "ComplianceCheck" ("decision");
CREATE INDEX IF NOT EXISTS "ComplianceAuditLog_bundle_draft_id_created_at_idx"
  ON "ComplianceAuditLog" ("bundle_draft_id", "created_at");
CREATE INDEX IF NOT EXISTS "ComplianceAuditLog_event_type_idx"
  ON "ComplianceAuditLog" ("event_type");

-- ─── Add compliance_* columns to BundleDraft + ChannelSKU ───────────────
--
-- SQLite doesn't support `ADD COLUMN IF NOT EXISTS`. These migrations run
-- once against a fresh schema, so plain `ADD COLUMN` is correct here.
-- The Turso migration script (scripts/turso-migrate-phase-2-0-compliance-gate.mjs)
-- wraps the same statements in try/catch so it stays idempotent against
-- the live database.

ALTER TABLE "BundleDraft" ADD COLUMN "compliance_status"          TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "BundleDraft" ADD COLUMN "compliance_check_id"        TEXT;
ALTER TABLE "BundleDraft" ADD COLUMN "compliance_blocked_at"      DATETIME;
ALTER TABLE "BundleDraft" ADD COLUMN "compliance_blocked_reasons" TEXT;

ALTER TABLE "ChannelSKU" ADD COLUMN "compliance_status"          TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "ChannelSKU" ADD COLUMN "compliance_check_id"        TEXT;
ALTER TABLE "ChannelSKU" ADD COLUMN "compliance_blocked_at"      DATETIME;
ALTER TABLE "ChannelSKU" ADD COLUMN "compliance_blocked_reasons" TEXT;

CREATE INDEX IF NOT EXISTS "BundleDraft_compliance_status_idx"
  ON "BundleDraft" ("compliance_status");
CREATE INDEX IF NOT EXISTS "ChannelSKU_compliance_status_idx"
  ON "ChannelSKU" ("compliance_status");
