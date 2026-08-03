-- Restore the MarketplaceSubmissionAttempt guard triggers, and scope the pilot
-- cap to the pilot lane.
--
-- WHAT WENT WRONG. Migration 20260803120000 lifted the two-row limit by
-- rebuilding the table: RENAME TO _old, CREATE new, DROP _old. In SQLite a
-- table's triggers follow it through the rename and die with the DROP, and that
-- migration never recreated them. All five guards vanished. The runtime doctor
-- (assertWalmartPublishLifecycleSchema) correctly refused to publish anything
-- afterwards — the guards are a precondition for writing, so a table without
-- them is a table nothing may be written through.
--
-- WHY THE PILOT CAP CHANGES SHAPE. MarketplaceSubmissionAttempt_pilot_global_cap
-- capped the WHOLE table at two distinct Walmart SKUs, forever. That, not the
-- pilot_slot column alone, was the real reason a third listing could never be
-- published. The cap is a genuine constraint of the FROZEN PILOT release and is
-- kept exactly as strong for that lane: at most two distinct SKUs may ever
-- acquire an OWNER_SIGNED_PERMIT attempt. Studio-lane rows, authorized by a
-- sealed distribution approval, are not part of the pilot and are governed by
-- the owner's daily publish ceiling instead.
--
-- Idempotent by construction: every trigger is dropped if present, then created.

DROP TRIGGER IF EXISTS "MarketplaceSubmissionAttempt_active_insert_guard";
DROP TRIGGER IF EXISTS "MarketplaceSubmissionAttempt_active_update_guard";
DROP TRIGGER IF EXISTS "MarketplaceSubmissionAttempt_identity_immutable";
DROP TRIGGER IF EXISTS "MarketplaceSubmissionAttempt_no_delete";
DROP TRIGGER IF EXISTS "MarketplaceSubmissionAttempt_pilot_global_cap";

-- An active row must point at its own SKU; a terminal row must release the
-- fence. Unchanged from 20260719003000.
CREATE TRIGGER "MarketplaceSubmissionAttempt_active_insert_guard"
BEFORE INSERT ON "MarketplaceSubmissionAttempt"
FOR EACH ROW
WHEN (
  (NEW."state" IN ('CLAIMED','REQUESTING','ACCEPTED','UNKNOWN','PENDING_REVIEW')
    AND NEW."active_key" IS NOT NEW."channel_sku_id")
  OR
  (NEW."state" IN ('BUYER_VERIFIED','REJECTED','RETRYABLE')
    AND NEW."active_key" IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid marketplace submission active fence');
END;

CREATE TRIGGER "MarketplaceSubmissionAttempt_active_update_guard"
BEFORE UPDATE ON "MarketplaceSubmissionAttempt"
FOR EACH ROW
WHEN (
  (NEW."state" IN ('CLAIMED','REQUESTING','ACCEPTED','UNKNOWN','PENDING_REVIEW')
    AND NEW."active_key" IS NOT NEW."channel_sku_id")
  OR
  (NEW."state" IN ('BUYER_VERIFIED','REJECTED','RETRYABLE')
    AND NEW."active_key" IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid marketplace submission active fence');
END;

-- What a submission IS can never be edited after the fact. authorization_basis
-- and authorization_sha256 join the sealed set: they record which lane and which
-- signature/approval authorized the write, so they are identity, not status.
CREATE TRIGGER "MarketplaceSubmissionAttempt_identity_immutable"
BEFORE UPDATE ON "MarketplaceSubmissionAttempt"
FOR EACH ROW
WHEN (
  NEW."channel_sku_id" IS NOT OLD."channel_sku_id" OR
  NEW."marketplace" IS NOT OLD."marketplace" OR
  NEW."idempotency_key" IS NOT OLD."idempotency_key" OR
  NEW."authorization_basis" IS NOT OLD."authorization_basis" OR
  NEW."authorization_sha256" IS NOT OLD."authorization_sha256" OR
  NEW."pilot_permit_sha256" IS NOT OLD."pilot_permit_sha256" OR
  NEW."pilot_permit_id" IS NOT OLD."pilot_permit_id" OR
  NEW."owner_key_id" IS NOT OLD."owner_key_id" OR
  NEW."owner_signature_sha256" IS NOT OLD."owner_signature_sha256" OR
  NEW."pilot_slot" IS NOT OLD."pilot_slot" OR
  NEW."pilot_approval_sha256" IS NOT OLD."pilot_approval_sha256" OR
  NEW."certification_sha256" IS NOT OLD."certification_sha256" OR
  NEW."seller_account_fingerprint_sha256" IS NOT OLD."seller_account_fingerprint_sha256" OR
  NEW."payload_hash" IS NOT OLD."payload_hash" OR
  NEW."created_at" IS NOT OLD."created_at"
)
BEGIN
  SELECT RAISE(ABORT, 'marketplace submission identity is immutable');
END;

-- The submission ledger is the only record that a POST ever left. It is never
-- deleted; that is what makes "resolve by reading, never by resending" possible.
CREATE TRIGGER "MarketplaceSubmissionAttempt_no_delete"
BEFORE DELETE ON "MarketplaceSubmissionAttempt"
BEGIN
  SELECT RAISE(ABORT, 'MarketplaceSubmissionAttempt is append-retained');
END;

-- Frozen pilot fence, now lane-scoped: at most two distinct Walmart SKUs may
-- ever acquire an owner-permit attempt. A new plan or wave and concurrent
-- processes still cannot reset or race it. Studio-lane rows are excluded from
-- both the count and the check.
CREATE TRIGGER "MarketplaceSubmissionAttempt_pilot_global_cap"
BEFORE INSERT ON "MarketplaceSubmissionAttempt"
FOR EACH ROW
WHEN (
  NEW."marketplace" = 'WALMART'
  AND NEW."authorization_basis" = 'OWNER_SIGNED_PERMIT'
  AND NOT EXISTS (
    SELECT 1 FROM "MarketplaceSubmissionAttempt" prior
    WHERE prior."marketplace" = 'WALMART'
      AND prior."authorization_basis" = 'OWNER_SIGNED_PERMIT'
      AND prior."channel_sku_id" = NEW."channel_sku_id"
  )
  AND (
    SELECT COUNT(DISTINCT prior."channel_sku_id")
    FROM "MarketplaceSubmissionAttempt" prior
    WHERE prior."marketplace" = 'WALMART'
      AND prior."authorization_basis" = 'OWNER_SIGNED_PERMIT'
  ) >= 2
)
BEGIN
  SELECT RAISE(ABORT, 'WALMART_PILOT_GLOBAL_TWO_SKU_CAP_REACHED');
END;
