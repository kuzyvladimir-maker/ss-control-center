-- Bundle Factory Phase 2.4 Stage 6 — Validation Pipeline migration.
--
-- Adds 12 columns to ChannelSKU: validation_* state + missing operational
-- fields the validators check for presence (package_*, weight, country,
-- item_type, main_image_url). Plus one index on validation_status for
-- the "show me all FAILED SKUs" query.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS — for repeated prod application
-- use scripts/turso-migrate-phase-2-4-validation.mjs which traps the
-- duplicate-column error.

ALTER TABLE "ChannelSKU" ADD COLUMN "main_image_url" TEXT;
ALTER TABLE "ChannelSKU" ADD COLUMN "validation_status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "ChannelSKU" ADD COLUMN "validation_errors" TEXT;
ALTER TABLE "ChannelSKU" ADD COLUMN "validated_at" DATETIME;
ALTER TABLE "ChannelSKU" ADD COLUMN "validation_check_id" TEXT;
ALTER TABLE "ChannelSKU" ADD COLUMN "validation_attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChannelSKU" ADD COLUMN "package_length_in" REAL;
ALTER TABLE "ChannelSKU" ADD COLUMN "package_width_in" REAL;
ALTER TABLE "ChannelSKU" ADD COLUMN "package_height_in" REAL;
ALTER TABLE "ChannelSKU" ADD COLUMN "package_weight_oz" REAL;
ALTER TABLE "ChannelSKU" ADD COLUMN "country_of_origin" TEXT DEFAULT 'US';
ALTER TABLE "ChannelSKU" ADD COLUMN "item_type" TEXT;

CREATE INDEX IF NOT EXISTS "ChannelSKU_validation_status_idx"
  ON "ChannelSKU" ("validation_status");
