-- Bundle Factory core integrity: durable studio work queue, canonical recipe
-- lineage, explicit approval, and inventory-derived publication quantity.

-- One GenerationJob produces many MasterBundles. The original unique index
-- encoded the opposite cardinality and prevented preserving lineage.
DROP INDEX IF EXISTS "MasterBundle_generation_job_id_key";
CREATE INDEX IF NOT EXISTS "MasterBundle_generation_job_id_idx"
  ON "MasterBundle"("generation_job_id");

ALTER TABLE "BundleDraft" ADD COLUMN "approved_at" DATETIME;
ALTER TABLE "BundleDraft" ADD COLUMN "approved_by" TEXT;
ALTER TABLE "BundleDraft" ADD COLUMN "published_at" DATETIME;
ALTER TABLE "BundleDraft" ADD COLUMN "recipe_fingerprint" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BundleDraft_recipe_fingerprint_key"
  ON "BundleDraft"("recipe_fingerprint");
CREATE INDEX IF NOT EXISTS "BundleDraft_approved_at_idx"
  ON "BundleDraft"("approved_at");

-- No approval backfill: historical UI confirmation was not durably recorded.
-- Existing listings must be revalidated and explicitly reapproved before a
-- real repair/re-publish, just like newly generated listings.

-- Publication is an observable marketplace fact and can be backfilled. Keep
-- the earliest recorded SKU publication/check timestamp so future status polls
-- do not double-count these already-live bundles.
UPDATE "BundleDraft"
SET "published_at" = (
      SELECT MIN(COALESCE(cs."published_at", cs."last_status_check_at", cs."updated_at"))
      FROM "ChannelSKU" cs
      WHERE cs."master_bundle_id" = "BundleDraft"."master_bundle_id"
        AND cs."listing_status" = 'LIVE'
    ),
    "status" = 'PUBLISHED'
WHERE EXISTS (
  SELECT 1
  FROM "ChannelSKU" cs
  WHERE cs."master_bundle_id" = "BundleDraft"."master_bundle_id"
    AND cs."listing_status" = 'LIVE'
);

UPDATE "ChannelSKU"
SET "lifecycle_status" = CASE
      WHEN "listing_status" = 'LIVE' THEN 'LIVE'
      WHEN "listing_status" = 'SUBMITTED' THEN 'SUBMITTED'
      WHEN "listing_status" = 'PENDING_REVIEW' THEN 'PROCESSING'
      WHEN "listing_status" = 'FAILED' THEN 'ERROR'
      ELSE "lifecycle_status"
    END,
    "live_at" = CASE
      WHEN "listing_status" = 'LIVE' THEN COALESCE("live_at", "published_at")
      ELSE "live_at"
    END;

UPDATE "MasterBundle"
SET "lifecycle_status" = 'LIVE'
WHERE EXISTS (
  SELECT 1 FROM "ChannelSKU" cs
  WHERE cs."master_bundle_id" = "MasterBundle"."id"
    AND cs."listing_status" = 'LIVE'
);

-- Reset the approval counter because no pre-migration approval is provable;
-- publication can be recomputed exactly from the factual draft timestamps.
UPDATE "GenerationJob"
SET "bundles_approved" = 0,
    "bundles_published" = (
      SELECT COUNT(*)
      FROM "BundleDraft" d
      WHERE d."generation_job_id" = "GenerationJob"."id"
        AND d."published_at" IS NOT NULL
    );

ALTER TABLE "ChannelSKU" ADD COLUMN "available_quantity" INTEGER;
ALTER TABLE "ChannelSKU" ADD COLUMN "inventory_checked_at" DATETIME;

CREATE TABLE "GenerationWorkItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "generation_job_id" TEXT NOT NULL,
  "spec_index" INTEGER NOT NULL,
  "spec_json" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "locked_at" DATETIME,
  "last_error" TEXT,
  "bundle_draft_id" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "GenerationWorkItem_generation_job_id_fkey"
    FOREIGN KEY ("generation_job_id") REFERENCES "GenerationJob"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GenerationWorkItem_bundle_draft_id_fkey"
    FOREIGN KEY ("bundle_draft_id") REFERENCES "BundleDraft"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "GenerationWorkItem_generation_job_id_spec_index_key"
  ON "GenerationWorkItem"("generation_job_id", "spec_index");
CREATE UNIQUE INDEX "GenerationWorkItem_generation_job_id_fingerprint_key"
  ON "GenerationWorkItem"("generation_job_id", "fingerprint");
CREATE INDEX "GenerationWorkItem_generation_job_id_status_idx"
  ON "GenerationWorkItem"("generation_job_id", "status");
CREATE INDEX "GenerationWorkItem_bundle_draft_id_idx"
  ON "GenerationWorkItem"("bundle_draft_id");
CREATE INDEX "GenerationWorkItem_locked_at_idx"
  ON "GenerationWorkItem"("locked_at");
