-- Product Truth queue v3: bind SKU work to the immutable authoritative
-- marketplace listing grain (channel, positive storeIndex, exact raw SKU).
--
-- This migration deliberately does not infer scope from a raw SKU. It aborts
-- unless the worker is quiescent, then terminalizes only pending unscoped SKU
-- jobs so an owner-reviewed producer can enqueue exact scoped work later.

ALTER TABLE "EnrichmentJob" ADD COLUMN "listingKey" TEXT
  REFERENCES "ProductTruthListingScope"("listingKey")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A running provider attempt has an ambiguous external outcome. Never cancel
-- it as a side effect of a schema migration. The forced no-op update fires this
-- guard for every non-empty queue and aborts the whole ordered transaction when
-- any running unscoped SKU exists. The trigger remains as a durable invariant.
CREATE TRIGGER "EnrichmentJob_queue_v3_quiescence_guard"
BEFORE UPDATE OF "listingKey" ON "EnrichmentJob"
WHEN EXISTS (
  SELECT 1 FROM "EnrichmentJob" running
  WHERE running."status" = 'running'
    AND (
      running."targetType" NOT IN ('brand', 'product', 'sku', 'query')
      OR (
        running."targetType" = 'sku'
        AND running."listingKey" IS NULL
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'QUEUE_V3_MIGRATION_REQUIRES_QUIESCENCE');
END;

UPDATE "EnrichmentJob" SET "listingKey" = "listingKey";

UPDATE "EnrichmentJob"
SET "status" = 'cancelled',
    "terminalReason" = 'QUEUE_V3_TARGET_TYPE_INVALID',
    "nextEligibleAt" = NULL,
    "leaseOwner" = NULL,
    "leaseToken" = NULL,
    "leaseExpiresAt" = NULL,
    "finishedAt" = COALESCE("finishedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "targetType" NOT IN ('brand', 'product', 'sku', 'query')
  AND "status" IN ('queued', 'retry_wait');

UPDATE "EnrichmentJob"
SET "status" = 'cancelled',
    "terminalReason" = 'QUEUE_V3_LISTING_SCOPE_REQUIRED',
    "nextEligibleAt" = NULL,
    "leaseOwner" = NULL,
    "leaseToken" = NULL,
    "leaseExpiresAt" = NULL,
    "finishedAt" = COALESCE("finishedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "targetType" = 'sku'
  AND "listingKey" IS NULL
  AND "status" IN ('queued', 'retry_wait');

CREATE INDEX "EnrichmentJob_listing_scope_status_idx"
  ON "EnrichmentJob"("listingKey", "status");

-- Defense in depth for direct SQL/Prisma producers: one active field intent per
-- exact listing scope even if a caller bypasses the canonical hash helper.
CREATE UNIQUE INDEX "EnrichmentJob_one_active_listing_intent"
  ON "EnrichmentJob"("listingKey", "requestedFields")
  WHERE "targetType" = 'sku'
    AND "status" IN ('queued', 'running', 'retry_wait');

-- New SKU work must point to one exact registry row and preserve the raw SKU
-- byte-for-byte in both target and normalizedTarget. Non-SKU campaigns are
-- channel-independent and therefore may not carry a listing scope.
CREATE TRIGGER "EnrichmentJob_listing_scope_contract_insert"
BEFORE INSERT ON "EnrichmentJob"
BEGIN
  SELECT CASE WHEN NEW."targetType" NOT IN ('brand', 'product', 'sku', 'query')
  THEN RAISE(ABORT, 'ENRICHMENT_JOB_TARGET_TYPE_INVALID') END;

  SELECT CASE WHEN NEW."targetType" = 'sku' AND (
    NEW."listingKey" IS NULL
    OR NEW."normalizedTarget" IS NOT NEW."target"
    OR NEW."idempotencyKey" IS NULL
    OR length(NEW."idempotencyKey") <> 64
    OR NEW."idempotencyKey" IS NOT lower(NEW."idempotencyKey")
    OR NEW."idempotencyKey" GLOB '*[^0-9a-f]*'
    OR NOT EXISTS (
      SELECT 1
      FROM "ProductTruthListingScope" scope
      WHERE scope."listingKey" = NEW."listingKey"
        AND scope."sku" = NEW."target"
    )
  ) THEN RAISE(ABORT, 'ENRICHMENT_JOB_SKU_LISTING_SCOPE_INVALID') END;

  SELECT CASE WHEN NEW."targetType" <> 'sku'
    AND NEW."listingKey" IS NOT NULL
  THEN RAISE(ABORT, 'ENRICHMENT_JOB_NON_SKU_SCOPE_FORBIDDEN') END;
END;

-- Queue identity is immutable after admission. Lifecycle fields may advance,
-- but a job cannot be retargeted to another SKU/account/channel in place.
CREATE TRIGGER "EnrichmentJob_listing_scope_identity_immutable"
BEFORE UPDATE ON "EnrichmentJob"
WHEN OLD."targetType" IS NOT NEW."targetType"
  OR OLD."target" IS NOT NEW."target"
  OR OLD."normalizedTarget" IS NOT NEW."normalizedTarget"
  OR OLD."listingKey" IS NOT NEW."listingKey"
BEGIN
  SELECT RAISE(ABORT, 'ENRICHMENT_JOB_LISTING_SCOPE_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER "EnrichmentJob_listing_scope_contract_update"
BEFORE UPDATE ON "EnrichmentJob"
BEGIN
  SELECT CASE WHEN NEW."targetType" NOT IN ('brand', 'product', 'sku', 'query')
  THEN RAISE(ABORT, 'ENRICHMENT_JOB_TARGET_TYPE_INVALID') END;

  SELECT CASE WHEN NEW."targetType" = 'sku' AND (
    NEW."listingKey" IS NULL
    OR NEW."normalizedTarget" IS NOT NEW."target"
    OR NEW."idempotencyKey" IS NULL
    OR length(NEW."idempotencyKey") <> 64
    OR NEW."idempotencyKey" IS NOT lower(NEW."idempotencyKey")
    OR NEW."idempotencyKey" GLOB '*[^0-9a-f]*'
    OR NOT EXISTS (
      SELECT 1
      FROM "ProductTruthListingScope" scope
      WHERE scope."listingKey" = NEW."listingKey"
        AND scope."sku" = NEW."target"
    )
  ) THEN RAISE(ABORT, 'ENRICHMENT_JOB_SKU_LISTING_SCOPE_INVALID') END;

  SELECT CASE WHEN NEW."targetType" <> 'sku'
    AND NEW."listingKey" IS NOT NULL
  THEN RAISE(ABORT, 'ENRICHMENT_JOB_NON_SKU_SCOPE_FORBIDDEN') END;
END;
