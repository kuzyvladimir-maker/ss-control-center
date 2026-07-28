-- Schema-only safety contract for the owner-gated Walmart publish pilot.
-- This migration does not submit, poll, publish, retry, or backfill anything.

-- A draft must never acquire two UPC reservations when two stage processes
-- race. Deployment deliberately fails on pre-existing duplicates so they are
-- reviewed instead of silently discarded.
CREATE UNIQUE INDEX "UPCPool_reserved_for_id_key"
  ON "UPCPool"("reserved_for_id");

CREATE TABLE "MarketplaceSubmissionAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel_sku_id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "active_key" TEXT,
    "pilot_permit_sha256" TEXT NOT NULL CHECK (length("pilot_permit_sha256") = 64),
    "pilot_permit_id" TEXT NOT NULL,
    "owner_key_id" TEXT NOT NULL,
    "owner_signature_sha256" TEXT NOT NULL CHECK (length("owner_signature_sha256") = 64),
    "pilot_slot" INTEGER NOT NULL CHECK ("pilot_slot" IN (1, 2)),
    "pilot_approval_sha256" TEXT NOT NULL CHECK (length("pilot_approval_sha256") = 64),
    "certification_sha256" TEXT NOT NULL CHECK (length("certification_sha256") = 64),
    "seller_account_fingerprint_sha256" TEXT NOT NULL CHECK (length("seller_account_fingerprint_sha256") = 64),
    "payload_hash" TEXT NOT NULL,
    "claim_token" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "recovery_count" INTEGER NOT NULL DEFAULT 0,
    "marketplace_submission_id" TEXT,
    "marketplace_disposition" TEXT,
    "error_json" TEXT,
    "claimed_at" DATETIME NOT NULL,
    "requested_at" DATETIME,
    "accepted_at" DATETIME,
    "terminal_at" DATETIME,
    "retry_after" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "MarketplaceSubmissionAttempt_channel_sku_id_fkey"
      FOREIGN KEY ("channel_sku_id") REFERENCES "ChannelSKU" ("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "MarketplaceSubmissionAttempt_state_check" CHECK (
      "state" IN (
        'CLAIMED','REQUESTING','ACCEPTED','UNKNOWN','PENDING_REVIEW',
        'BUYER_VERIFIED','REJECTED','RETRYABLE'
      )
    )
);

CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_idempotency_key_key"
  ON "MarketplaceSubmissionAttempt"("idempotency_key");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_active_key_key"
  ON "MarketplaceSubmissionAttempt"("active_key");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_claim_token_key"
  ON "MarketplaceSubmissionAttempt"("claim_token");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_pilot_permit_sha256_key"
  ON "MarketplaceSubmissionAttempt"("pilot_permit_sha256");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_pilot_permit_id_key"
  ON "MarketplaceSubmissionAttempt"("pilot_permit_id");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_owner_signature_sha256_key"
  ON "MarketplaceSubmissionAttempt"("owner_signature_sha256");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_pilot_slot_key"
  ON "MarketplaceSubmissionAttempt"("pilot_slot");
CREATE INDEX "MarketplaceSubmissionAttempt_channel_sku_id_state_idx"
  ON "MarketplaceSubmissionAttempt"("channel_sku_id", "state");
CREATE INDEX "MarketplaceSubmissionAttempt_state_retry_after_idx"
  ON "MarketplaceSubmissionAttempt"("state", "retry_after");
CREATE INDEX "MarketplaceSubmissionAttempt_marketplace_submission_id_idx"
  ON "MarketplaceSubmissionAttempt"("marketplace_submission_id");

CREATE TABLE "WalmartBuyerPublicationEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel_sku_id" TEXT NOT NULL,
    "submission_attempt_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "walmart_item_id" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "captured_at" DATETIME NOT NULL,
    "exact_sku_match" BOOLEAN NOT NULL,
    "exact_item_id_match" BOOLEAN NOT NULL,
    "published" BOOLEAN NOT NULL,
    "buyable" BOOLEAN NOT NULL,
    "evidence_hash" TEXT NOT NULL,
    "raw_evidence" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalmartBuyerPublicationEvidence_channel_sku_id_fkey"
      FOREIGN KEY ("channel_sku_id") REFERENCES "ChannelSKU" ("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "WalmartBuyerPublicationEvidence_submission_attempt_id_fkey"
      FOREIGN KEY ("submission_attempt_id") REFERENCES "MarketplaceSubmissionAttempt" ("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "WalmartBuyerPublicationEvidence_truth_check" CHECK (
      "exact_sku_match" = 1 AND
      "exact_item_id_match" = 1 AND
      "published" = 1 AND
      "buyable" = 1
    )
);

CREATE UNIQUE INDEX "WalmartBuyerPublicationEvidence_evidence_hash_key"
  ON "WalmartBuyerPublicationEvidence"("evidence_hash");
CREATE INDEX "WalmartBuyerPublicationEvidence_channel_sku_id_captured_at_idx"
  ON "WalmartBuyerPublicationEvidence"("channel_sku_id", "captured_at");
CREATE INDEX "WalmartBuyerPublicationEvidence_submission_attempt_id_captured_at_idx"
  ON "WalmartBuyerPublicationEvidence"("submission_attempt_id", "captured_at");
CREATE INDEX "WalmartBuyerPublicationEvidence_sku_item_captured_at_idx"
  ON "WalmartBuyerPublicationEvidence"("sku", "walmart_item_id", "captured_at");

-- Active attempts must retain the per-SKU fence; terminal/retry-safe rows must
-- release it. These triggers protect direct SQL callers as well as Prisma.
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

CREATE TRIGGER "MarketplaceSubmissionAttempt_identity_immutable"
BEFORE UPDATE ON "MarketplaceSubmissionAttempt"
FOR EACH ROW
WHEN (
  NEW."channel_sku_id" IS NOT OLD."channel_sku_id" OR
  NEW."marketplace" IS NOT OLD."marketplace" OR
  NEW."idempotency_key" IS NOT OLD."idempotency_key" OR
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

-- The release-wide pilot cap is historical, not a count of currently active
-- rows. Submission attempts therefore cannot be deleted to recycle a pilot
-- slot or erase an ambiguous/terminal marketplace outcome.
CREATE TRIGGER "MarketplaceSubmissionAttempt_no_delete"
BEFORE DELETE ON "MarketplaceSubmissionAttempt"
BEGIN
  SELECT RAISE(ABORT, 'MarketplaceSubmissionAttempt is append-retained');
END;

-- Pilot release fence: at most two distinct Walmart SKUs may ever acquire a
-- submission attempt while this migration is installed. A new plan/wave and
-- concurrent processes cannot reset or race this cap. Retrying an already
-- attempted SKU remains possible through the lifecycle state machine.
CREATE TRIGGER "MarketplaceSubmissionAttempt_pilot_global_cap"
BEFORE INSERT ON "MarketplaceSubmissionAttempt"
FOR EACH ROW
WHEN (
  NEW."marketplace" = 'WALMART'
  AND NOT EXISTS (
    SELECT 1 FROM "MarketplaceSubmissionAttempt" prior
    WHERE prior."marketplace" = 'WALMART'
      AND prior."channel_sku_id" = NEW."channel_sku_id"
  )
  AND (
    SELECT COUNT(DISTINCT prior."channel_sku_id")
    FROM "MarketplaceSubmissionAttempt" prior
    WHERE prior."marketplace" = 'WALMART'
  ) >= 2
)
BEGIN
  SELECT RAISE(ABORT, 'WALMART_PILOT_GLOBAL_TWO_SKU_CAP_REACHED');
END;

-- Direct SQL callers cannot attach a true buyer proof to an attempt belonging
-- to another ChannelSKU. The application performs the same check before write;
-- this trigger makes the invariant database-authoritative.
CREATE TRIGGER "WalmartBuyerPublicationEvidence_attempt_sku_guard"
BEFORE INSERT ON "WalmartBuyerPublicationEvidence"
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "MarketplaceSubmissionAttempt" attempt
  WHERE attempt."id" = NEW."submission_attempt_id"
    AND attempt."channel_sku_id" = NEW."channel_sku_id"
    AND attempt."marketplace" = 'WALMART'
)
BEGIN
  SELECT RAISE(ABORT, 'WALMART_BUYER_EVIDENCE_ATTEMPT_SKU_MISMATCH');
END;

-- Immutable buyer proof: corrections are appended as a new evidence row.
CREATE TRIGGER "WalmartBuyerPublicationEvidence_no_update"
BEFORE UPDATE ON "WalmartBuyerPublicationEvidence"
BEGIN
  SELECT RAISE(ABORT, 'WalmartBuyerPublicationEvidence is append-only');
END;

CREATE TRIGGER "WalmartBuyerPublicationEvidence_no_delete"
BEFORE DELETE ON "WalmartBuyerPublicationEvidence"
BEGIN
  SELECT RAISE(ABORT, 'WalmartBuyerPublicationEvidence is append-only');
END;
