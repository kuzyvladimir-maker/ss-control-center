-- Walmart Listing Integrity persistent control plane — Stage A.
--
-- This migration creates only durable run/item/event/artifact custody. Runtime
-- is constrained to OFF and the migration is not applied to production merely
-- because these bytes exist in the repository. It grants no Walmart write.

CREATE TABLE "WalmartListingIntegrityControlRun" (
  "runId" TEXT NOT NULL PRIMARY KEY,
  "schemaVersion" TEXT NOT NULL,
  "poolBodySha256" TEXT NOT NULL,
  "releaseIdSha256" TEXT NOT NULL,
  "manifestSha256" TEXT NOT NULL,
  "runtimeStage" TEXT NOT NULL DEFAULT 'OFF',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalmartListingIntegrityControlRun_schema_check"
    CHECK ("schemaVersion" = 'walmart-listing-integrity-control-run/v1'),
  CONSTRAINT "WalmartListingIntegrityControlRun_hashes_check"
    CHECK (
      length("poolBodySha256") = 64 AND "poolBodySha256" NOT GLOB '*[^0-9a-f]*'
      AND length("releaseIdSha256") = 64 AND "releaseIdSha256" NOT GLOB '*[^0-9a-f]*'
      AND length("manifestSha256") = 64 AND "manifestSha256" NOT GLOB '*[^0-9a-f]*'
    ),
  CONSTRAINT "WalmartListingIntegrityControlRun_stage_a_off_check"
    CHECK ("runtimeStage" = 'OFF'),
  CONSTRAINT "WalmartListingIntegrityControlRun_status_check"
    CHECK ("status" IN ('ACTIVE','PAUSED','COMPLETED','FAILED'))
);

CREATE INDEX "WalmartListingIntegrityControlRun_status_created_idx"
  ON "WalmartListingIntegrityControlRun"("status", "createdAt");
CREATE UNIQUE INDEX "WalmartListingIntegrityControlRun_single_active_key"
  ON "WalmartListingIntegrityControlRun"("status")
  WHERE "status"='ACTIVE';

CREATE TABLE "WalmartListingIntegrityControlItem" (
  "itemControlId" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "listingKey" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "storeIndex" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'QUEUED',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "stateBodySha256" TEXT NOT NULL,
  "previousStateSha256" TEXT,
  "evidenceSha256" TEXT NOT NULL,
  "executionPackageSha256" TEXT,
  "ownerPermitSha256" TEXT,
  "feedId" TEXT,
  "marketplaceWriteCalls" INTEGER NOT NULL DEFAULT 0,
  "automaticRetryAllowed" BOOLEAN NOT NULL DEFAULT false,
  "automaticReplayAllowed" BOOLEAN NOT NULL DEFAULT false,
  "transitionedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalmartListingIntegrityControlItem_run_fkey"
    FOREIGN KEY ("runId") REFERENCES "WalmartListingIntegrityControlRun"("runId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "WalmartListingIntegrityControlItem_state_check"
    CHECK ("state" IN (
      'QUEUED','DIAGNOSING','AUDITED_PASS','ISSUE_PROVEN',
      'QUARANTINED_SOURCE_REQUIRED','REPAIR_PLANNED','AWAITING_OWNER',
      'OWNER_APPROVED','APPLY_REQUESTING','APPLIED','PROPAGATING',
      'LIVE_REREAD','QUALIFIED_PASS','QUARANTINED_UNRESOLVED','MANUAL_REVIEW'
    )),
  CONSTRAINT "WalmartListingIntegrityControlItem_identity_check"
    CHECK ("ordinal" >= 1 AND "storeIndex" >= 1 AND length("listingKey") >= 1
      AND length("sku") >= 1 AND length("itemId") >= 1),
  CONSTRAINT "WalmartListingIntegrityControlItem_hashes_check"
    CHECK (
      length("stateBodySha256") = 64 AND "stateBodySha256" NOT GLOB '*[^0-9a-f]*'
      AND length("evidenceSha256") = 64 AND "evidenceSha256" NOT GLOB '*[^0-9a-f]*'
      AND ("previousStateSha256" IS NULL OR
        (length("previousStateSha256") = 64 AND "previousStateSha256" NOT GLOB '*[^0-9a-f]*'))
      AND ("executionPackageSha256" IS NULL OR
        (length("executionPackageSha256") = 64 AND "executionPackageSha256" NOT GLOB '*[^0-9a-f]*'))
      AND ("ownerPermitSha256" IS NULL OR
        (length("ownerPermitSha256") = 64 AND "ownerPermitSha256" NOT GLOB '*[^0-9a-f]*'))
    ),
  CONSTRAINT "WalmartListingIntegrityControlItem_policy_check"
    CHECK (
      "revision" >= 1
      AND "marketplaceWriteCalls" IN (0,1)
      AND "automaticRetryAllowed" = false
      AND "automaticReplayAllowed" = false
      AND ("marketplaceWriteCalls" = 0 OR "ownerPermitSha256" IS NOT NULL)
    ),
  CONSTRAINT "WalmartListingIntegrityControlItem_apply_binding_check"
    CHECK (
      "state" NOT IN ('APPLY_REQUESTING','APPLIED','PROPAGATING','LIVE_REREAD')
      OR ("executionPackageSha256" IS NOT NULL AND "ownerPermitSha256" IS NOT NULL)
    ),
  CONSTRAINT "WalmartListingIntegrityControlItem_post_apply_check"
    CHECK (
      "state" NOT IN ('APPLIED','PROPAGATING','LIVE_REREAD','QUALIFIED_PASS')
      OR ("feedId" IS NOT NULL AND "marketplaceWriteCalls" = 1)
    )
);

CREATE UNIQUE INDEX "WalmartListingIntegrityControlItem_run_ordinal_key"
  ON "WalmartListingIntegrityControlItem"("runId", "ordinal");
CREATE UNIQUE INDEX "WalmartListingIntegrityControlItem_run_listing_key"
  ON "WalmartListingIntegrityControlItem"("runId", "listingKey");
CREATE INDEX "WalmartListingIntegrityControlItem_claim_idx"
  ON "WalmartListingIntegrityControlItem"("runId", "state", "ordinal");

CREATE TRIGGER "WalmartListingIntegrityControlRun_identity_immutable"
BEFORE UPDATE ON "WalmartListingIntegrityControlRun"
WHEN NEW."runId" IS NOT OLD."runId"
  OR NEW."schemaVersion" IS NOT OLD."schemaVersion"
  OR NEW."poolBodySha256" IS NOT OLD."poolBodySha256"
  OR NEW."releaseIdSha256" IS NOT OLD."releaseIdSha256"
  OR NEW."manifestSha256" IS NOT OLD."manifestSha256"
  OR NEW."runtimeStage" IS NOT OLD."runtimeStage"
  OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity run identity is immutable');
END;

CREATE TRIGGER "WalmartListingIntegrityControlRun_delete_guard"
BEFORE DELETE ON "WalmartListingIntegrityControlRun"
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity run cannot be deleted');
END;

CREATE TRIGGER "WalmartListingIntegrityControlItem_identity_immutable"
BEFORE UPDATE ON "WalmartListingIntegrityControlItem"
WHEN NEW."itemControlId" IS NOT OLD."itemControlId"
  OR NEW."runId" IS NOT OLD."runId"
  OR NEW."ordinal" IS NOT OLD."ordinal"
  OR NEW."listingKey" IS NOT OLD."listingKey"
  OR NEW."sku" IS NOT OLD."sku"
  OR NEW."itemId" IS NOT OLD."itemId"
  OR NEW."storeIndex" IS NOT OLD."storeIndex"
  OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity item identity is immutable');
END;

CREATE TRIGGER "WalmartListingIntegrityControlItem_terminal_guard"
BEFORE UPDATE ON "WalmartListingIntegrityControlItem"
WHEN OLD."state" IN (
  'AUDITED_PASS','QUALIFIED_PASS','QUARANTINED_SOURCE_REQUIRED',
  'QUARANTINED_UNRESOLVED','MANUAL_REVIEW'
)
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity terminal item is immutable');
END;

CREATE TRIGGER "WalmartListingIntegrityControlItem_transition_guard"
BEFORE UPDATE OF "state" ON "WalmartListingIntegrityControlItem"
WHEN NEW."state" IS NOT OLD."state" AND NOT (
  (OLD."state"='QUEUED' AND NEW."state"='DIAGNOSING')
  OR (OLD."state"='DIAGNOSING' AND NEW."state" IN
    ('AUDITED_PASS','ISSUE_PROVEN','QUARANTINED_SOURCE_REQUIRED','MANUAL_REVIEW'))
  OR (OLD."state"='ISSUE_PROVEN' AND NEW."state" IN
    ('REPAIR_PLANNED','QUARANTINED_UNRESOLVED','MANUAL_REVIEW'))
  OR (OLD."state"='REPAIR_PLANNED' AND NEW."state" IN
    ('AWAITING_OWNER','MANUAL_REVIEW'))
  OR (OLD."state"='AWAITING_OWNER' AND NEW."state" IN
    ('OWNER_APPROVED','QUARANTINED_UNRESOLVED','MANUAL_REVIEW'))
  OR (OLD."state"='OWNER_APPROVED' AND NEW."state" IN
    ('APPLY_REQUESTING','MANUAL_REVIEW'))
  OR (OLD."state"='APPLY_REQUESTING' AND NEW."state" IN
    ('APPLIED','MANUAL_REVIEW'))
  OR (OLD."state"='APPLIED' AND NEW."state" IN
    ('PROPAGATING','LIVE_REREAD','QUARANTINED_UNRESOLVED','MANUAL_REVIEW'))
  OR (OLD."state"='PROPAGATING' AND NEW."state" IN
    ('LIVE_REREAD','QUARANTINED_UNRESOLVED','MANUAL_REVIEW'))
  OR (OLD."state"='LIVE_REREAD' AND NEW."state" IN
    ('QUALIFIED_PASS','QUARANTINED_UNRESOLVED','MANUAL_REVIEW'))
)
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity transition is not permitted');
END;

CREATE TRIGGER "WalmartListingIntegrityControlItem_revision_guard"
BEFORE UPDATE ON "WalmartListingIntegrityControlItem"
WHEN NEW."revision" != OLD."revision" + 1
  OR NEW."previousStateSha256" IS NOT OLD."stateBodySha256"
  OR NEW."transitionedAt" < OLD."transitionedAt"
  OR NEW."stateBodySha256" IS OLD."stateBodySha256"
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity revision chain is invalid');
END;

CREATE TRIGGER "WalmartListingIntegrityControlItem_strict_sequence_guard"
BEFORE UPDATE OF "state" ON "WalmartListingIntegrityControlItem"
WHEN NEW."state" IS NOT OLD."state" AND NEW."state" != 'QUEUED'
  AND EXISTS (
    SELECT 1 FROM "WalmartListingIntegrityControlItem" prior
    WHERE prior."runId" = OLD."runId" AND prior."ordinal" < OLD."ordinal"
      AND prior."state" NOT IN (
        'AUDITED_PASS','QUALIFIED_PASS','QUARANTINED_SOURCE_REQUIRED',
        'QUARANTINED_UNRESOLVED'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity predecessor is not terminal');
END;

CREATE TRIGGER "WalmartListingIntegrityControlItem_single_apply_insert_guard"
BEFORE INSERT ON "WalmartListingIntegrityControlItem"
WHEN NEW."state" IN ('APPLY_REQUESTING','APPLIED','PROPAGATING','LIVE_REREAD')
  AND EXISTS (
    SELECT 1 FROM "WalmartListingIntegrityControlItem" active
    WHERE active."state" IN ('APPLY_REQUESTING','APPLIED','PROPAGATING','LIVE_REREAD')
  )
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity allows one live apply globally');
END;

CREATE TRIGGER "WalmartListingIntegrityControlItem_single_apply_update_guard"
BEFORE UPDATE OF "state" ON "WalmartListingIntegrityControlItem"
WHEN NEW."state" IN ('APPLY_REQUESTING','APPLIED','PROPAGATING','LIVE_REREAD')
  AND OLD."state" NOT IN ('APPLY_REQUESTING','APPLIED','PROPAGATING','LIVE_REREAD')
  AND EXISTS (
    SELECT 1 FROM "WalmartListingIntegrityControlItem" active
    WHERE active."itemControlId" != OLD."itemControlId"
      AND active."state" IN ('APPLY_REQUESTING','APPLIED','PROPAGATING','LIVE_REREAD')
  )
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity allows one live apply globally');
END;

CREATE TRIGGER "WalmartListingIntegrityControlItem_delete_guard"
BEFORE DELETE ON "WalmartListingIntegrityControlItem"
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity item cannot be deleted');
END;

CREATE TABLE "WalmartListingIntegrityControlEvent" (
  "eventId" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "itemControlId" TEXT,
  "sequence" INTEGER NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "occurredAt" DATETIME NOT NULL,
  "payload" BLOB NOT NULL,
  "payloadSha256" TEXT NOT NULL,
  "previousEventHash" TEXT NOT NULL,
  "eventHash" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalmartListingIntegrityControlEvent_run_fkey"
    FOREIGN KEY ("runId") REFERENCES "WalmartListingIntegrityControlRun"("runId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "WalmartListingIntegrityControlEvent_item_fkey"
    FOREIGN KEY ("itemControlId") REFERENCES "WalmartListingIntegrityControlItem"("itemControlId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "WalmartListingIntegrityControlEvent_schema_check"
    CHECK ("schemaVersion"='walmart-listing-integrity-control-event/v1'),
  CONSTRAINT "WalmartListingIntegrityControlEvent_hashes_check"
    CHECK (
      length("payloadSha256")=64 AND "payloadSha256" NOT GLOB '*[^0-9a-f]*'
      AND length("previousEventHash")=64 AND "previousEventHash" NOT GLOB '*[^0-9a-f]*'
      AND length("eventHash")=64 AND "eventHash" NOT GLOB '*[^0-9a-f]*'
      AND "sequence" >= 1
    )
);

CREATE UNIQUE INDEX "WalmartListingIntegrityControlEvent_eventHash_key"
  ON "WalmartListingIntegrityControlEvent"("eventHash");
CREATE UNIQUE INDEX "WalmartListingIntegrityControlEvent_run_sequence_key"
  ON "WalmartListingIntegrityControlEvent"("runId", "sequence");
CREATE INDEX "WalmartListingIntegrityControlEvent_run_occurred_idx"
  ON "WalmartListingIntegrityControlEvent"("runId", "occurredAt");

CREATE TRIGGER "WalmartListingIntegrityControlEvent_chain_guard"
BEFORE INSERT ON "WalmartListingIntegrityControlEvent"
WHEN
  (NEW."sequence" = 1 AND NEW."previousEventHash" != printf('%064d',0))
  OR (NEW."sequence" > 1 AND NOT EXISTS (
    SELECT 1 FROM "WalmartListingIntegrityControlEvent" prior
    WHERE prior."runId"=NEW."runId" AND prior."sequence"=NEW."sequence"-1
      AND prior."eventHash"=NEW."previousEventHash"
  ))
  OR EXISTS (
    SELECT 1 FROM "WalmartListingIntegrityControlEvent" gap
    WHERE gap."runId"=NEW."runId" AND gap."sequence">=NEW."sequence"
  )
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity event chain is invalid');
END;

CREATE TRIGGER "WalmartListingIntegrityControlEvent_update_guard"
BEFORE UPDATE ON "WalmartListingIntegrityControlEvent"
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity events are append-only');
END;
CREATE TRIGGER "WalmartListingIntegrityControlEvent_delete_guard"
BEFORE DELETE ON "WalmartListingIntegrityControlEvent"
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity events are append-only');
END;

CREATE TABLE "WalmartListingIntegrityControlArtifact" (
  "artifactId" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "itemControlId" TEXT,
  "role" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "locator" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL,
  "createdByPrincipal" TEXT NOT NULL,
  CONSTRAINT "WalmartListingIntegrityControlArtifact_run_fkey"
    FOREIGN KEY ("runId") REFERENCES "WalmartListingIntegrityControlRun"("runId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "WalmartListingIntegrityControlArtifact_item_fkey"
    FOREIGN KEY ("itemControlId") REFERENCES "WalmartListingIntegrityControlItem"("itemControlId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "WalmartListingIntegrityControlArtifact_bounds_check"
    CHECK ("byteSize">=1 AND length("sha256")=64 AND "sha256" NOT GLOB '*[^0-9a-f]*')
);

CREATE UNIQUE INDEX "WalmartListingIntegrityControlArtifact_locator_key"
  ON "WalmartListingIntegrityControlArtifact"("locator");
CREATE UNIQUE INDEX "WalmartListingIntegrityControlArtifact_run_role_sha_key"
  ON "WalmartListingIntegrityControlArtifact"("runId", "role", "sha256");
CREATE INDEX "WalmartListingIntegrityControlArtifact_run_created_idx"
  ON "WalmartListingIntegrityControlArtifact"("runId", "createdAt");

CREATE TRIGGER "WalmartListingIntegrityControlArtifact_update_guard"
BEFORE UPDATE ON "WalmartListingIntegrityControlArtifact"
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity artifacts are append-only');
END;
CREATE TRIGGER "WalmartListingIntegrityControlArtifact_delete_guard"
BEFORE DELETE ON "WalmartListingIntegrityControlArtifact"
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity artifacts are append-only');
END;
