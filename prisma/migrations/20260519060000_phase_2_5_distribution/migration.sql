-- Bundle Factory Phase 2.5 Stage 7 — Distribution migration.
--
-- Adds 6 columns to ChannelSKU tracking marketplace submission state
-- plus one index. SQLite has no ADD COLUMN IF NOT EXISTS — for repeated
-- prod application use scripts/turso-migrate-phase-2-5-distribution.mjs
-- which traps the duplicate-column error.

ALTER TABLE "ChannelSKU" ADD COLUMN "listing_status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "ChannelSKU" ADD COLUMN "submission_id" TEXT;
ALTER TABLE "ChannelSKU" ADD COLUMN "published_at" DATETIME;
ALTER TABLE "ChannelSKU" ADD COLUMN "distribution_errors" TEXT;
ALTER TABLE "ChannelSKU" ADD COLUMN "distribution_attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChannelSKU" ADD COLUMN "last_status_check_at" DATETIME;

CREATE INDEX IF NOT EXISTS "ChannelSKU_listing_status_idx"
  ON "ChannelSKU" ("listing_status");
