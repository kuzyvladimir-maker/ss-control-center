-- Uncrustables Studio Phase A (owner gate «го» 2026-07-27):
-- run + candidate state machine + append-only sealed manifest records.

CREATE TABLE "UncrustablesStudioRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "owner_order" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE INDEX "UncrustablesStudioRun_status_idx" ON "UncrustablesStudioRun"("status");

CREATE TABLE "UncrustablesStudioCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "run_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PLANNED',
    "recipe_json" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bullets_json" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "cost_cents" INTEGER,
    "pack_count" INTEGER NOT NULL,
    "render_attempts" INTEGER NOT NULL DEFAULT 0,
    "prompt" TEXT,
    "reference_urls" TEXT,
    "main_image_url" TEXT,
    "image_sha256" TEXT,
    "pixel_width" INTEGER,
    "pixel_height" INTEGER,
    "reviewed_by" TEXT,
    "reviewed_at" DATETIME,
    "reject_reason" TEXT,
    "draft_id" TEXT,
    "master_bundle_id" TEXT,
    "channel_sku_id" TEXT,
    "sku" TEXT,
    "proof_id" TEXT,
    "manifest_record_id" TEXT,
    "submission_id" TEXT,
    "asin" TEXT,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "UncrustablesStudioCandidate_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "UncrustablesStudioRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UncrustablesStudioCandidate_run_id_slug_key" ON "UncrustablesStudioCandidate"("run_id", "slug");
CREATE INDEX "UncrustablesStudioCandidate_state_idx" ON "UncrustablesStudioCandidate"("state");
CREATE INDEX "UncrustablesStudioCandidate_run_id_idx" ON "UncrustablesStudioCandidate"("run_id");

CREATE TABLE "UncrustablesOwnerApprovalManifestRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "manifest_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "body_json" TEXT NOT NULL,
    "entry_count" INTEGER NOT NULL,
    "approved_by" TEXT NOT NULL,
    "captured_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "UncrustablesOwnerApprovalManifestRecord_manifest_id_key" ON "UncrustablesOwnerApprovalManifestRecord"("manifest_id");
CREATE UNIQUE INDEX "UncrustablesOwnerApprovalManifestRecord_sha256_key" ON "UncrustablesOwnerApprovalManifestRecord"("sha256");
