-- Bundle Factory Phase 2.3 Stage 5 — Main Image Generation migration.
--
-- Adds image-related columns to BundleDraft + GeneratedContent. No new
-- tables. SQLite doesn't have `ADD COLUMN IF NOT EXISTS`; for repeated
-- prod application use scripts/turso-migrate-phase-2-3-image-generation.mjs
-- which traps the duplicate-column error.

ALTER TABLE "BundleDraft" ADD COLUMN "image_generated_at" DATETIME;

ALTER TABLE "GeneratedContent" ADD COLUMN "main_image_url" TEXT;
ALTER TABLE "GeneratedContent" ADD COLUMN "image_generation_cost_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GeneratedContent" ADD COLUMN "image_retry_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GeneratedContent" ADD COLUMN "image_generated_at" DATETIME;
