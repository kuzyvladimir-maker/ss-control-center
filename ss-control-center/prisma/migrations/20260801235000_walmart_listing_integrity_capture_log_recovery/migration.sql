-- Narrow incident-recovery exception for a proven v9 stdout framing defect.
-- The recovery artifact is inserted in the same transaction before the item
-- CAS update. Every unrelated terminal state/transition remains immutable.

DROP TRIGGER "WalmartListingIntegrityControlItem_terminal_guard";
DROP TRIGGER "WalmartListingIntegrityControlItem_transition_guard";

CREATE TRIGGER "WalmartListingIntegrityControlItem_terminal_guard"
BEFORE UPDATE ON "WalmartListingIntegrityControlItem"
WHEN OLD."state" IN (
  'AUDITED_PASS','QUALIFIED_PASS','QUARANTINED_SOURCE_REQUIRED',
  'QUARANTINED_UNRESOLVED','MANUAL_REVIEW'
) AND NOT (
  OLD."state"='QUARANTINED_SOURCE_REQUIRED'
  AND NEW."state"='QUEUED'
  AND OLD."marketplaceWriteCalls"=0
  AND NEW."marketplaceWriteCalls"=0
  AND OLD."executionPackageSha256" IS NULL
  AND NEW."executionPackageSha256" IS NULL
  AND OLD."ownerPermitSha256" IS NULL
  AND NEW."ownerPermitSha256" IS NULL
  AND OLD."feedId" IS NULL
  AND NEW."feedId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "WalmartListingIntegrityControlArtifact" recovery
    WHERE recovery."runId"=OLD."runId"
      AND recovery."itemControlId"=OLD."itemControlId"
      AND recovery."role"='CAPTURE_LOG_FALSE_QUARANTINE_RECOVERY'
      AND recovery."sha256"=NEW."evidenceSha256"
      AND recovery."createdByPrincipal"='codex-owner-recovery'
  )
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
  OR (
    OLD."state" IN ('QUARANTINED_SOURCE_REQUIRED','DIAGNOSING')
    AND NEW."state"='QUEUED'
    AND OLD."marketplaceWriteCalls"=0
    AND NEW."marketplaceWriteCalls"=0
    AND OLD."executionPackageSha256" IS NULL
    AND NEW."executionPackageSha256" IS NULL
    AND OLD."ownerPermitSha256" IS NULL
    AND NEW."ownerPermitSha256" IS NULL
    AND OLD."feedId" IS NULL
    AND NEW."feedId" IS NULL
    AND EXISTS (
      SELECT 1 FROM "WalmartListingIntegrityControlArtifact" recovery
      WHERE recovery."runId"=OLD."runId"
        AND recovery."itemControlId"=OLD."itemControlId"
        AND recovery."role"='CAPTURE_LOG_FALSE_QUARANTINE_RECOVERY'
        AND recovery."sha256"=NEW."evidenceSha256"
        AND recovery."createdByPrincipal"='codex-owner-recovery'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Walmart Listing Integrity transition is not permitted');
END;
