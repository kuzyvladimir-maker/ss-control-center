-- Publish queue: batch publishing that survives a closed browser tab.
--
-- Additive only. No existing table is touched, so this cannot disturb the
-- submission ledger that guards "one SKU, one POST, zero retry".

CREATE TABLE "PublishBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketplace" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "requested_total" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "daily_cap_at_creation" INTEGER NOT NULL,
    "note" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "started_at" DATETIME,
    "finished_at" DATETIME
);

CREATE INDEX "PublishBatch_status_idx" ON "PublishBatch"("status");
CREATE INDEX "PublishBatch_marketplace_created_at_idx" ON "PublishBatch"("marketplace", "created_at");

CREATE TABLE "PublishBatchItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publish_batch_id" TEXT NOT NULL,
    "bundle_draft_id" TEXT NOT NULL,
    "sku" TEXT,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failed_stage" TEXT,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" DATETIME,
    "submission_id" TEXT,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    CONSTRAINT "PublishBatchItem_publish_batch_id_fkey"
      FOREIGN KEY ("publish_batch_id") REFERENCES "PublishBatch" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PublishBatchItem_publish_batch_id_bundle_draft_id_key"
  ON "PublishBatchItem"("publish_batch_id", "bundle_draft_id");
CREATE INDEX "PublishBatchItem_publish_batch_id_status_idx"
  ON "PublishBatchItem"("publish_batch_id", "status");
CREATE INDEX "PublishBatchItem_locked_at_idx" ON "PublishBatchItem"("locked_at");
CREATE INDEX "PublishBatchItem_bundle_draft_id_idx" ON "PublishBatchItem"("bundle_draft_id");
