-- Submission attempts stop being a two-row pilot ledger.
--
-- `pilot_slot INTEGER NOT NULL UNIQUE`, with the claim accepting only 1 and 2,
-- capped the ENTIRE table at two submissions ever. That is why a third Walmart
-- listing could never be published.
--
-- Pilot permit evidence becomes nullable and every row records how it was
-- authorized: OWNER_SIGNED_PERMIT (the frozen pilot's Ed25519 permit, one SKU
-- per signature) or STUDIO_SEALED_APPROVAL (the sealed distribution approval on
-- the SKU). The one-POST fences are untouched: `idempotency_key` stays UNIQUE
-- per (SKU, payload) and `active_key` stays UNIQUE per SKU. SQLite treats NULLs
-- as distinct, so pilot evidence keeps its uniqueness while any number of
-- studio rows coexist.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

ALTER TABLE "MarketplaceSubmissionAttempt" RENAME TO "MarketplaceSubmissionAttempt_old";

CREATE TABLE "MarketplaceSubmissionAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel_sku_id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "active_key" TEXT,
    "authorization_basis" TEXT NOT NULL DEFAULT 'OWNER_SIGNED_PERMIT',
    "authorization_sha256" TEXT,
    "pilot_permit_sha256" TEXT,
    "pilot_permit_id" TEXT,
    "owner_key_id" TEXT,
    "owner_signature_sha256" TEXT,
    "pilot_slot" INTEGER,
    "pilot_approval_sha256" TEXT,
    "certification_sha256" TEXT,
    "seller_account_fingerprint_sha256" TEXT NOT NULL,
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
        ON DELETE RESTRICT ON UPDATE RESTRICT
);

INSERT INTO "MarketplaceSubmissionAttempt" (
    "id","channel_sku_id","marketplace","idempotency_key","active_key",
    "authorization_basis","authorization_sha256",
    "pilot_permit_sha256","pilot_permit_id","owner_key_id",
    "owner_signature_sha256","pilot_slot","pilot_approval_sha256",
    "certification_sha256","seller_account_fingerprint_sha256",
    "payload_hash","claim_token","state","request_count","recovery_count",
    "marketplace_submission_id","marketplace_disposition","error_json",
    "claimed_at","requested_at","accepted_at","terminal_at","retry_after",
    "created_at","updated_at"
)
SELECT
    "id","channel_sku_id","marketplace","idempotency_key","active_key",
    'OWNER_SIGNED_PERMIT',"pilot_permit_sha256",
    "pilot_permit_sha256","pilot_permit_id","owner_key_id",
    "owner_signature_sha256","pilot_slot","pilot_approval_sha256",
    "certification_sha256","seller_account_fingerprint_sha256",
    "payload_hash","claim_token","state","request_count","recovery_count",
    "marketplace_submission_id","marketplace_disposition","error_json",
    "claimed_at","requested_at","accepted_at","terminal_at","retry_after",
    "created_at","updated_at"
FROM "MarketplaceSubmissionAttempt_old";

DROP TABLE "MarketplaceSubmissionAttempt_old";

CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_idempotency_key_key" ON "MarketplaceSubmissionAttempt" ("idempotency_key");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_active_key_key" ON "MarketplaceSubmissionAttempt" ("active_key");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_claim_token_key" ON "MarketplaceSubmissionAttempt" ("claim_token");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_pilot_permit_sha256_key" ON "MarketplaceSubmissionAttempt" ("pilot_permit_sha256");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_pilot_permit_id_key" ON "MarketplaceSubmissionAttempt" ("pilot_permit_id");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_owner_signature_sha256_key" ON "MarketplaceSubmissionAttempt" ("owner_signature_sha256");
CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_pilot_slot_key" ON "MarketplaceSubmissionAttempt" ("pilot_slot");
CREATE INDEX "MarketplaceSubmissionAttempt_channel_sku_id_state_idx" ON "MarketplaceSubmissionAttempt" ("channel_sku_id","state");
CREATE INDEX "MarketplaceSubmissionAttempt_state_retry_after_idx" ON "MarketplaceSubmissionAttempt" ("state","retry_after");
CREATE INDEX "MarketplaceSubmissionAttempt_marketplace_submission_id_idx" ON "MarketplaceSubmissionAttempt" ("marketplace_submission_id");

PRAGMA foreign_keys=ON;
