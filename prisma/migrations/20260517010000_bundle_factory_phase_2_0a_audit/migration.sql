-- Bundle Factory Phase 2.0a — Listing Audit Tool migration.
-- Adds 4 tables that track scans of existing Amazon listings for
-- foreign-brand violations (Trademark Logo Misuse — the 2026-05-17
-- Retailer Distributor block class), the per-listing risk scores those
-- scans produce, the remediation work that turns risky listings into
-- compliant ones, and a permanent blocklist of brand/keyword pairs
-- seeded from past incidents.
--
-- Pattern matches Phase 1: `CREATE TABLE IF NOT EXISTS` so the same DDL
-- can be re-run idempotently against Turso via
-- scripts/turso-migrate-bundle-factory-phase-2-0a-audit.mjs.

-- ─── Tables ─────────────────────────────────────────────────────────────

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
);

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
);

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
);

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
);

-- ─── Indexes ────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "ListingAuditScan_initiated_by_started_at_idx"
  ON "ListingAuditScan" ("initiated_by", "started_at");
CREATE INDEX IF NOT EXISTS "ListingAuditScan_status_idx"
  ON "ListingAuditScan" ("status");

CREATE INDEX IF NOT EXISTS "ListingAuditResult_scan_id_risk_category_idx"
  ON "ListingAuditResult" ("scan_id", "risk_category");
CREATE INDEX IF NOT EXISTS "ListingAuditResult_asin_idx"
  ON "ListingAuditResult" ("asin");
CREATE INDEX IF NOT EXISTS "ListingAuditResult_account_risk_category_idx"
  ON "ListingAuditResult" ("account", "risk_category");
CREATE INDEX IF NOT EXISTS "ListingAuditResult_remediation_status_idx"
  ON "ListingAuditResult" ("remediation_status");

CREATE UNIQUE INDEX IF NOT EXISTS "ListingRemediation_audit_result_id_key"
  ON "ListingRemediation" ("audit_result_id");
CREATE INDEX IF NOT EXISTS "ListingRemediation_status_idx"
  ON "ListingRemediation" ("status");

CREATE INDEX IF NOT EXISTS "BrandConflict_foreign_brand_idx"
  ON "BrandConflict" ("foreign_brand");
CREATE INDEX IF NOT EXISTS "BrandConflict_asin_idx"
  ON "BrandConflict" ("asin");
CREATE INDEX IF NOT EXISTS "BrandConflict_status_idx"
  ON "BrandConflict" ("status");
