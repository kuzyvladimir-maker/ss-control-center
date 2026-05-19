-- Bundle Factory Phase 2.2 — Variation Matrix + Generated Content migration.
--
-- Two new tables:
--   VariationMatrix    — one row per BundleDraft (unique FK). Stores 5-10
--                        composition variants in JSON plus the selected
--                        index. No AI cost — deterministic generator.
--   GeneratedContent   — one row per (BundleDraft, channel) pair. Stores
--                        Claude Sonnet 4.5 generated title + bullets +
--                        description plus the post-compliance-gate status.
--
-- BundleDraft is back-related to both via Prisma relations only — no
-- schema change to BundleDraft itself.
--
-- Idempotent via `CREATE TABLE IF NOT EXISTS`; safe to re-run.

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
);

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
);

CREATE UNIQUE INDEX IF NOT EXISTS "VariationMatrix_bundle_draft_id_key"
  ON "VariationMatrix" ("bundle_draft_id");
CREATE INDEX IF NOT EXISTS "VariationMatrix_bundle_draft_id_idx"
  ON "VariationMatrix" ("bundle_draft_id");

CREATE UNIQUE INDEX IF NOT EXISTS "GeneratedContent_bundle_draft_id_channel_key"
  ON "GeneratedContent" ("bundle_draft_id", "channel");
CREATE INDEX IF NOT EXISTS "GeneratedContent_bundle_draft_id_idx"
  ON "GeneratedContent" ("bundle_draft_id");
CREATE INDEX IF NOT EXISTS "GeneratedContent_compliance_status_idx"
  ON "GeneratedContent" ("compliance_status");
CREATE INDEX IF NOT EXISTS "GeneratedContent_manual_review_required_idx"
  ON "GeneratedContent" ("manual_review_required");
