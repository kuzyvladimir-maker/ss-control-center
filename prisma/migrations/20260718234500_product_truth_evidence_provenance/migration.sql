-- Product Truth canonical identity, immutable content/price observations, and
-- append-only SKU cost evidence.
--
-- This is intentionally a schema-only migration. It does not run sourcing,
-- rewrite legacy rows, or promote any legacy identity/cost/link to truth.

ALTER TABLE "DonorOffer" ADD COLUMN "localityEvidence" TEXT;

ALTER TABLE "DonorProduct" ADD COLUMN "identityStatus" TEXT NOT NULL DEFAULT 'legacy_unverified';
ALTER TABLE "DonorProduct" ADD COLUMN "identityMatcherVersion" TEXT;
ALTER TABLE "DonorProduct" ADD COLUMN "identityMatcherImplementationSha256" TEXT;
ALTER TABLE "DonorProduct" ADD COLUMN "identityMatcherReleaseSha256" TEXT;
ALTER TABLE "DonorProduct" ADD COLUMN "identityEvidenceJson" TEXT;
ALTER TABLE "DonorProduct" ADD COLUMN "identityConfirmedAt" DATETIME;
CREATE INDEX "DonorProduct_identityStatus_idx" ON "DonorProduct"("identityStatus");

-- One channel-independent sellable package/variant. Retailer-specific rows are
-- DonorProduct source records and can all alias this same immutable identity.
CREATE TABLE "CanonicalProductVariant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "variantKey" TEXT NOT NULL UNIQUE
    CHECK (
      length("variantKey") = 69
      AND substr("variantKey", 1, 5) = 'cpv1:'
      AND substr("variantKey", 6) = "identityHash"
    ),
  "identityHash" TEXT NOT NULL UNIQUE CHECK (
    length("identityHash") = 64 AND "identityHash" NOT GLOB '*[^0-9a-f]*'
  ),
  "keyVersion" TEXT NOT NULL CHECK ("keyVersion" = 'canonical-product-variant-key/1.0.0'),
  "normalizedBrand" TEXT NOT NULL CHECK (length(trim("normalizedBrand")) > 0),
  "normalizedProductLine" TEXT,
  "normalizedFlavor" TEXT,
  "normalizedModifiersJson" TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid("normalizedModifiersJson") AND json_type("normalizedModifiersJson") = 'array'),
  "normalizedForm" TEXT,
  "sizeDimension" TEXT NOT NULL CHECK ("sizeDimension" IN ('MASS','VOLUME','COUNT')),
  "sizeBaseAmount" REAL NOT NULL CHECK ("sizeBaseAmount" > 0),
  "sizeBaseUnit" TEXT NOT NULL CHECK (
    ("sizeDimension" = 'MASS' AND "sizeBaseUnit" = 'g')
    OR ("sizeDimension" = 'VOLUME' AND "sizeBaseUnit" = 'ml')
    OR ("sizeDimension" = 'COUNT' AND "sizeBaseUnit" = 'count')
  ),
  "outerPackCount" INTEGER NOT NULL DEFAULT 1 CHECK ("outerPackCount" BETWEEN 1 AND 999),
  "identityJson" TEXT NOT NULL
    CHECK (json_valid("identityJson") AND json_type("identityJson") = 'object'),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CanonicalProductVariant_id_is_key" CHECK (
    "id" = "variantKey" AND substr("variantKey", 6) = "identityHash"
  ),
  CONSTRAINT "CanonicalProductVariant_discriminator_required" CHECK (
    length(trim(COALESCE("normalizedProductLine", ''))) > 0
    OR length(trim(COALESCE("normalizedFlavor", ''))) > 0
    OR length(trim(COALESCE("normalizedForm", ''))) > 0
  )
);

CREATE INDEX "CanonicalProductVariant_brand_line_idx"
  ON "CanonicalProductVariant"("normalizedBrand", "normalizedProductLine");

-- Application idempotency is a read + full-row comparison followed by a plain
-- INSERT only when absent. Conflict clauses and INSERT OR REPLACE are forbidden:
-- SQLite REPLACE can bypass delete guards when recursive_triggers is disabled.
CREATE TRIGGER "CanonicalProductVariant_insert_collision_guard"
BEFORE INSERT ON "CanonicalProductVariant"
WHEN EXISTS (
  SELECT 1 FROM "CanonicalProductVariant" existing
  WHERE (
    existing."id" = NEW."id"
    OR existing."variantKey" = NEW."variantKey"
    OR existing."identityHash" = NEW."identityHash"
  ) AND NOT (
    existing."id" IS NEW."id"
    AND existing."variantKey" IS NEW."variantKey"
    AND existing."identityHash" IS NEW."identityHash"
    AND existing."keyVersion" IS NEW."keyVersion"
    AND existing."normalizedBrand" IS NEW."normalizedBrand"
    AND existing."normalizedProductLine" IS NEW."normalizedProductLine"
    AND existing."normalizedFlavor" IS NEW."normalizedFlavor"
    AND existing."normalizedModifiersJson" IS NEW."normalizedModifiersJson"
    AND existing."normalizedForm" IS NEW."normalizedForm"
    AND existing."sizeDimension" IS NEW."sizeDimension"
    AND existing."sizeBaseAmount" IS NEW."sizeBaseAmount"
    AND existing."sizeBaseUnit" IS NEW."sizeBaseUnit"
    AND existing."outerPackCount" IS NEW."outerPackCount"
    AND existing."identityJson" IS NEW."identityJson"
  )
)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_PRODUCT_VARIANT_KEY_COLLISION');
END;

CREATE TRIGGER "CanonicalProductVariant_duplicate_insert_guard"
BEFORE INSERT ON "CanonicalProductVariant"
WHEN EXISTS (
  SELECT 1 FROM "CanonicalProductVariant" existing
  WHERE existing."id" = NEW."id"
     OR existing."variantKey" = NEW."variantKey"
     OR existing."identityHash" = NEW."identityHash"
)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_PRODUCT_VARIANT_ALREADY_EXISTS');
END;

CREATE TRIGGER "CanonicalProductVariant_update_guard"
BEFORE UPDATE ON "CanonicalProductVariant"
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_PRODUCT_VARIANT_IMMUTABLE');
END;

CREATE TRIGGER "CanonicalProductVariant_delete_guard"
BEFORE DELETE ON "CanonicalProductVariant"
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_PRODUCT_VARIANT_IMMUTABLE');
END;

-- Append-only exact/reject decisions. A donor source record may have many
-- rejected candidates, but at most one exact canonical alias for all time.
-- A bad exact decision is quarantined by creating a new DonorProduct source
-- record; historical evidence is never rewritten in place.
CREATE TABLE "DonorProductVariantDecision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "decisionKey" TEXT NOT NULL UNIQUE CHECK (length(trim("decisionKey")) > 0),
  "donorProductId" TEXT NOT NULL,
  "canonicalVariantId" TEXT,
  "decisionStatus" TEXT NOT NULL CHECK ("decisionStatus" IN ('exact_confirmed','rejected')),
  "matcherVersion" TEXT NOT NULL CHECK (
    "matcherVersion" = 'canonical-product-match/1.2.1'
  ),
  "matcherImplementationSha256" TEXT NOT NULL CHECK (
    "matcherImplementationSha256" = '2108b5af839ca1182191305f99196a3a3f1516211e0363691d36f30fae4ac8bb'
  ),
  "matcherReleaseSha256" TEXT NOT NULL CHECK (
    "matcherReleaseSha256" = '027b3a089e6100f9f6ecb212e67e7f6931093f7c30be6aa73c6a0d3dbf6563c2'
  ),
  "evidenceHash" TEXT NOT NULL CHECK (
    length("evidenceHash") = 64 AND "evidenceHash" NOT GLOB '*[^0-9a-f]*'
  ),
  "evidenceJson" TEXT NOT NULL
    CHECK (json_valid("evidenceJson") AND json_type("evidenceJson") = 'object'),
  "decidedAt" DATETIME NOT NULL,
  "runId" TEXT,
  "approvalId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DonorProductVariantDecision_product_fkey"
    FOREIGN KEY ("donorProductId") REFERENCES "DonorProduct"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "DonorProductVariantDecision_variant_fkey"
    FOREIGN KEY ("canonicalVariantId") REFERENCES "CanonicalProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "DonorProductVariantDecision_exact_variant_required" CHECK (
    "decisionStatus" <> 'exact_confirmed' OR "canonicalVariantId" IS NOT NULL
  ),
  CONSTRAINT "DonorProductVariantDecision_run_approval_pair" CHECK (
    ("runId" IS NULL AND "approvalId" IS NULL)
    OR (
      length(trim(COALESCE("runId", ''))) > 0
      AND length(trim(COALESCE("approvalId", ''))) > 0
    )
  ),
  CONSTRAINT "DonorProductVariantDecision_matcher_provenance" CHECK (
    json_extract("evidenceJson", '$.matcherVersion') IS "matcherVersion"
    AND json_extract("evidenceJson", '$.matcherImplementationSha256')
      IS "matcherImplementationSha256"
    AND json_extract("evidenceJson", '$.matcherReleaseSha256')
      IS "matcherReleaseSha256"
  )
);

CREATE UNIQUE INDEX "DonorProductVariantDecision_one_exact_per_donor"
  ON "DonorProductVariantDecision"("donorProductId")
  WHERE "decisionStatus" = 'exact_confirmed';
CREATE INDEX "DonorProductVariantDecision_variant_status_idx"
  ON "DonorProductVariantDecision"("canonicalVariantId", "decisionStatus");
CREATE INDEX "DonorProductVariantDecision_donor_decided_idx"
  ON "DonorProductVariantDecision"("donorProductId", "decidedAt");

CREATE TRIGGER "DonorProductVariantDecision_duplicate_insert_guard"
BEFORE INSERT ON "DonorProductVariantDecision"
WHEN EXISTS (
  SELECT 1 FROM "DonorProductVariantDecision" existing
  WHERE existing."id" = NEW."id"
     OR existing."decisionKey" = NEW."decisionKey"
     OR (
       NEW."decisionStatus" = 'exact_confirmed'
       AND existing."decisionStatus" = 'exact_confirmed'
       AND existing."donorProductId" = NEW."donorProductId"
     )
)
BEGIN
  SELECT RAISE(ABORT, 'DONOR_PRODUCT_VARIANT_DECISION_ALREADY_EXISTS');
END;

CREATE TRIGGER "DonorProductVariantDecision_update_guard"
BEFORE UPDATE ON "DonorProductVariantDecision"
BEGIN
  SELECT RAISE(ABORT, 'DONOR_PRODUCT_VARIANT_DECISION_IMMUTABLE');
END;

CREATE TRIGGER "DonorProductVariantDecision_delete_guard"
BEFORE DELETE ON "DonorProductVariantDecision"
BEGIN
  SELECT RAISE(ABORT, 'DONOR_PRODUCT_VARIANT_DECISION_IMMUTABLE');
END;

-- DonorProduct.identityStatus is a transitional materialized projection. New
-- exact rows must be staged as candidate/legacy, receive an immutable exact
-- decision, and only then transition to exact_confirmed.
CREATE TRIGGER "DonorProduct_identity_status_insert"
BEFORE INSERT ON "DonorProduct"
BEGIN
  SELECT CASE
    WHEN NEW."identityStatus" NOT IN ('candidate','exact_confirmed','legacy_unverified','rejected')
    THEN RAISE(ABORT, 'DONOR_PRODUCT_IDENTITY_STATUS_INVALID')
  END;
  SELECT CASE
    WHEN NEW."identityStatus" = 'exact_confirmed'
    THEN RAISE(ABORT, 'DONOR_PRODUCT_EXACT_DECISION_REQUIRED')
  END;
END;

CREATE TRIGGER "DonorProduct_duplicate_insert_guard"
BEFORE INSERT ON "DonorProduct"
WHEN EXISTS (
  SELECT 1 FROM "DonorProduct" existing
  WHERE existing."id" = NEW."id" OR existing."identityKey" = NEW."identityKey"
)
BEGIN
  SELECT RAISE(ABORT, 'DONOR_PRODUCT_ALREADY_EXISTS');
END;

CREATE TRIGGER "DonorProduct_identity_contract_update"
BEFORE UPDATE OF
  "identityStatus", "identityMatcherVersion", "identityMatcherImplementationSha256",
  "identityMatcherReleaseSha256", "identityEvidenceJson", "identityConfirmedAt",
  "identityKey", "brand", "productLine", "flavor", "containerType", "size"
ON "DonorProduct"
BEGIN
  SELECT CASE
    WHEN NEW."identityStatus" NOT IN ('candidate','exact_confirmed','legacy_unverified','rejected')
    THEN RAISE(ABORT, 'DONOR_PRODUCT_IDENTITY_STATUS_INVALID')
  END;
  SELECT CASE
    WHEN NEW."identityStatus" = 'exact_confirmed' AND (
      length(trim(COALESCE(NEW."identityKey", ''))) = 0
      OR length(trim(COALESCE(NEW."brand", ''))) = 0
      OR length(trim(COALESCE(NEW."size", ''))) = 0
      OR (
        length(trim(COALESCE(NEW."productLine", ''))) = 0
        AND length(trim(COALESCE(NEW."flavor", ''))) = 0
        AND length(trim(COALESCE(NEW."containerType", ''))) = 0
      )
      OR NEW."identityMatcherVersion" <> 'canonical-product-match/1.2.1'
      OR NEW."identityMatcherImplementationSha256"
        <> '2108b5af839ca1182191305f99196a3a3f1516211e0363691d36f30fae4ac8bb'
      OR NEW."identityMatcherReleaseSha256"
        <> '027b3a089e6100f9f6ecb212e67e7f6931093f7c30be6aa73c6a0d3dbf6563c2'
      OR NEW."identityEvidenceJson" IS NULL
      OR NOT json_valid(NEW."identityEvidenceJson")
      OR json_type(NEW."identityEvidenceJson") <> 'object'
      OR json_extract(NEW."identityEvidenceJson", '$.matcherVersion')
        IS NOT NEW."identityMatcherVersion"
      OR json_extract(NEW."identityEvidenceJson", '$.matcherImplementationSha256')
        IS NOT NEW."identityMatcherImplementationSha256"
      OR json_extract(NEW."identityEvidenceJson", '$.matcherReleaseSha256')
        IS NOT NEW."identityMatcherReleaseSha256"
      OR NEW."identityConfirmedAt" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "DonorProductVariantDecision" decision
        WHERE decision."donorProductId" = NEW."id"
          AND decision."decisionStatus" = 'exact_confirmed'
          AND decision."matcherVersion" = NEW."identityMatcherVersion"
          AND decision."matcherImplementationSha256"
            = NEW."identityMatcherImplementationSha256"
          AND decision."matcherReleaseSha256" = NEW."identityMatcherReleaseSha256"
      )
    ) THEN RAISE(ABORT, 'DONOR_PRODUCT_EXACT_CONTRACT_INVALID')
  END;
  SELECT CASE
    WHEN OLD."identityStatus"='exact_confirmed' AND (
      NEW."identityStatus" IS NOT OLD."identityStatus"
      OR NEW."identityMatcherVersion" IS NOT OLD."identityMatcherVersion"
      OR NEW."identityMatcherImplementationSha256"
        IS NOT OLD."identityMatcherImplementationSha256"
      OR NEW."identityMatcherReleaseSha256" IS NOT OLD."identityMatcherReleaseSha256"
      OR NEW."identityEvidenceJson" IS NOT OLD."identityEvidenceJson"
      OR NEW."identityConfirmedAt" IS NOT OLD."identityConfirmedAt"
      OR NEW."identityKey" IS NOT OLD."identityKey"
      OR NEW."brand" IS NOT OLD."brand"
      OR NEW."productLine" IS NOT OLD."productLine"
      OR NEW."flavor" IS NOT OLD."flavor"
      OR NEW."containerType" IS NOT OLD."containerType"
      OR NEW."size" IS NOT OLD."size"
    ) THEN RAISE(ABORT, 'DONOR_PRODUCT_CONFIRMED_IDENTITY_IMMUTABLE')
  END;
END;

CREATE TRIGGER "DonorProduct_delete_guard"
BEFORE DELETE ON "DonorProduct"
BEGIN
  SELECT RAISE(ABORT, 'DONOR_PRODUCT_HISTORY_IMMUTABLE');
END;

ALTER TABLE "SkuComponent" ADD COLUMN "contentDonorProductId" TEXT;
ALTER TABLE "SkuComponent" ADD COLUMN "priceEvidenceDonorProductId" TEXT;
ALTER TABLE "SkuComponent" ADD COLUMN "priceEvidenceOfferId" TEXT;
ALTER TABLE "SkuComponent" ADD COLUMN "priceEvidenceObservationId" TEXT;
ALTER TABLE "SkuComponent" ADD COLUMN "matchTier" TEXT;
ALTER TABLE "SkuComponent" ADD COLUMN "matcherVersion" TEXT;
ALTER TABLE "SkuComponent" ADD COLUMN "priceEvidenceStatus" TEXT;
ALTER TABLE "SkuComponent" ADD COLUMN "pricePolicyVersion" TEXT;
ALTER TABLE "SkuComponent" ADD COLUMN "priceEvidenceJson" TEXT;

CREATE INDEX "SkuComponent_contentDonorProductId_idx"
  ON "SkuComponent"("contentDonorProductId");
CREATE INDEX "SkuComponent_priceEvidenceDonorProductId_idx"
  ON "SkuComponent"("priceEvidenceDonorProductId");
CREATE INDEX "SkuComponent_priceEvidenceOfferId_idx"
  ON "SkuComponent"("priceEvidenceOfferId");
CREATE INDEX "SkuComponent_priceEvidenceObservationId_idx"
  ON "SkuComponent"("priceEvidenceObservationId");

-- Existing donorProductId and the first-generation split columns are legacy
-- mixed-semantics caches. They are not backfilled, and new authoritative
-- writes must use SkuComponentEvidence below.
CREATE TRIGGER "SkuComponent_evidence_contract_insert"
BEFORE INSERT ON "SkuComponent"
WHEN
  NEW."donorProductId" IS NOT NULL
  OR NEW."contentDonorProductId" IS NOT NULL
  OR NEW."priceEvidenceDonorProductId" IS NOT NULL
  OR NEW."priceEvidenceOfferId" IS NOT NULL
  OR NEW."priceEvidenceObservationId" IS NOT NULL
  OR NEW."matchTier" IS NOT NULL
  OR NEW."matcherVersion" IS NOT NULL
  OR NEW."priceEvidenceStatus" IS NOT NULL
  OR NEW."pricePolicyVersion" IS NOT NULL
  OR NEW."priceEvidenceJson" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'SKU_COMPONENT_LEGACY_EVIDENCE_FORBIDDEN');
END;

CREATE TRIGGER "SkuComponent_evidence_contract_update"
BEFORE UPDATE OF
  "donorProductId", "contentDonorProductId", "priceEvidenceDonorProductId",
  "priceEvidenceOfferId", "priceEvidenceObservationId", "matchTier",
  "matcherVersion", "priceEvidenceStatus", "pricePolicyVersion", "priceEvidenceJson"
ON "SkuComponent"
BEGIN
  SELECT RAISE(ABORT, 'SKU_COMPONENT_LEGACY_EVIDENCE_FORBIDDEN');
END;

CREATE TRIGGER "DonorOffer_delete_guard"
BEFORE DELETE ON "DonorOffer"
BEGIN
  SELECT RAISE(ABORT, 'DONOR_OFFER_HISTORY_IMMUTABLE');
END;

CREATE TRIGGER "DonorOffer_duplicate_insert_guard"
BEFORE INSERT ON "DonorOffer"
WHEN EXISTS (
  SELECT 1 FROM "DonorOffer" existing
  WHERE existing."id" = NEW."id"
     OR (
       existing."retailer" = NEW."retailer"
       AND existing."retailerProductId" = NEW."retailerProductId"
     )
)
BEGIN
  SELECT RAISE(ABORT, 'DONOR_OFFER_ALREADY_EXISTS');
END;

CREATE TRIGGER "DonorOffer_source_identity_update_guard"
BEFORE UPDATE OF "donorProductId", "retailer", "retailerProductId", "via"
ON "DonorOffer"
WHEN NEW."donorProductId" IS NOT OLD."donorProductId"
  OR NEW."retailer" IS NOT OLD."retailer"
  OR NEW."retailerProductId" IS NOT OLD."retailerProductId"
  OR NEW."via" IS NOT OLD."via"
BEGIN
  SELECT RAISE(ABORT, 'DONOR_OFFER_SOURCE_IDENTITY_IMMUTABLE');
END;

ALTER TABLE "SkuCost" ADD COLUMN "observationKey" TEXT;
ALTER TABLE "SkuCost" ADD COLUMN "recipeHash" TEXT;
ALTER TABLE "SkuCost" ADD COLUMN "evidenceJson" TEXT;
ALTER TABLE "SkuCost" ADD COLUMN "evidenceOutcome" TEXT;
ALTER TABLE "SkuCost" ADD COLUMN "matcherVersion" TEXT;
ALTER TABLE "SkuCost" ADD COLUMN "matcherImplementationSha256" TEXT;
ALTER TABLE "SkuCost" ADD COLUMN "matcherReleaseSha256" TEXT;
ALTER TABLE "SkuCost" ADD COLUMN "pricePolicyVersion" TEXT;
ALTER TABLE "SkuCost" ADD COLUMN "runId" TEXT;
ALTER TABLE "SkuCost" ADD COLUMN "approvalId" TEXT;

-- The legacy `(sku, source, effectiveDate)` unique index made a changed
-- observation for the same business period impossible to append, while the new
-- ledger forbids in-place correction. It was created as a standalone index, so
-- drop only that index: rebuilding the table would rewrite dependent views.
DROP INDEX IF EXISTS "SkuCost_sku_source_effectiveDate_key";
CREATE UNIQUE INDEX "SkuCost_observationKey_key" ON "SkuCost"("observationKey");
CREATE INDEX "SkuCost_period_lookup_idx"
  ON "SkuCost"("sku", "source", "effectiveDate");

-- Full content snapshots are separate from mutable DonorProduct materialized
-- fields. Every snapshot is exact-variant-only and carries reproducible hashes
-- plus source/run provenance.
CREATE TABLE "ProductContentObservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "observationKey" TEXT NOT NULL UNIQUE CHECK (
    length("observationKey") = 64 AND "observationKey" NOT GLOB '*[^0-9a-f]*'
  ),
  "donorProductId" TEXT NOT NULL,
  "canonicalVariantId" TEXT NOT NULL,
  "variantDecisionId" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL CHECK (length(trim("sourceUrl")) > 0),
  "sourceApi" TEXT NOT NULL CHECK (length(trim("sourceApi")) > 0),
  "contentHash" TEXT NOT NULL CHECK (
    length("contentHash") = 64 AND "contentHash" NOT GLOB '*[^0-9a-f]*'
  ),
  "fieldHashesJson" TEXT NOT NULL
    CHECK (json_valid("fieldHashesJson") AND json_type("fieldHashesJson") = 'object'),
  "contentJson" TEXT NOT NULL
    CHECK (json_valid("contentJson") AND json_type("contentJson") = 'object'),
  "observedAt" DATETIME NOT NULL,
  "runId" TEXT,
  "approvalId" TEXT,
  "meteredReceiptId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductContentObservation_product_fkey"
    FOREIGN KEY ("donorProductId") REFERENCES "DonorProduct"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProductContentObservation_variant_fkey"
    FOREIGN KEY ("canonicalVariantId") REFERENCES "CanonicalProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProductContentObservation_decision_fkey"
    FOREIGN KEY ("variantDecisionId") REFERENCES "DonorProductVariantDecision"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProductContentObservation_run_approval_pair" CHECK (
    ("runId" IS NULL AND "approvalId" IS NULL)
    OR (
      length(trim(COALESCE("runId", ''))) > 0
      AND length(trim(COALESCE("approvalId", ''))) > 0
    )
  ),
  CONSTRAINT "ProductContentObservation_receipt_requires_run" CHECK (
    "meteredReceiptId" IS NULL OR ("runId" IS NOT NULL AND "approvalId" IS NOT NULL)
  )
);

CREATE INDEX "ProductContentObservation_variant_observed_idx"
  ON "ProductContentObservation"("canonicalVariantId", "observedAt");
CREATE INDEX "ProductContentObservation_product_observed_idx"
  ON "ProductContentObservation"("donorProductId", "observedAt");

CREATE TRIGGER "ProductContentObservation_duplicate_insert_guard"
BEFORE INSERT ON "ProductContentObservation"
WHEN EXISTS (
  SELECT 1 FROM "ProductContentObservation" existing
  WHERE existing."id" = NEW."id" OR existing."observationKey" = NEW."observationKey"
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_CONTENT_OBSERVATION_ALREADY_EXISTS');
END;

CREATE TRIGGER "ProductContentObservation_exact_alias_guard"
BEFORE INSERT ON "ProductContentObservation"
WHEN NOT EXISTS (
  SELECT 1
  FROM "DonorProductVariantDecision" decision
  JOIN "DonorProduct" product ON product."id" = decision."donorProductId"
  WHERE decision."id" = NEW."variantDecisionId"
    AND decision."decisionStatus" = 'exact_confirmed'
    AND decision."donorProductId" = NEW."donorProductId"
    AND decision."canonicalVariantId" = NEW."canonicalVariantId"
    AND product."identityStatus" = 'exact_confirmed'
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_CONTENT_EXACT_ALIAS_REQUIRED');
END;

CREATE TRIGGER "ProductContentObservation_hash_contract_insert"
BEFORE INSERT ON "ProductContentObservation"
WHEN json_type(NEW."fieldHashesJson") IS NOT 'object'
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW."fieldHashesJson"))
  OR EXISTS (
    SELECT 1 FROM json_each(NEW."fieldHashesJson") field
    WHERE field.type <> 'text'
       OR length(CAST(field.value AS TEXT)) <> 64
       OR CAST(field.value AS TEXT) GLOB '*[^0-9a-f]*'
  )
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_CONTENT_FIELD_HASH_CONTRACT_INVALID');
END;

CREATE TRIGGER "ProductContentObservation_update_guard"
BEFORE UPDATE ON "ProductContentObservation"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_CONTENT_OBSERVATION_IMMUTABLE');
END;

CREATE TRIGGER "ProductContentObservation_delete_guard"
BEFORE DELETE ON "ProductContentObservation"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_CONTENT_OBSERVATION_IMMUTABLE');
END;

CREATE TABLE "DonorOfferObservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "observationKey" TEXT NOT NULL UNIQUE CHECK (
    length("observationKey") = 64 AND "observationKey" NOT GLOB '*[^0-9a-f]*'
  ),
  "donorOfferId" TEXT NOT NULL,
  "donorProductId" TEXT NOT NULL,
  "canonicalVariantId" TEXT,
  "variantDecisionId" TEXT,
  "retailer" TEXT NOT NULL,
  "retailerProductId" TEXT NOT NULL,
  "via" TEXT NOT NULL,
  "title" TEXT,
  "price" REAL,
  "packSizeSeen" INTEGER,
  "pricePerUnit" REAL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "zip" TEXT,
  "localityEvidence" TEXT,
  "inStock" INTEGER,
  "productUrl" TEXT,
  "sellerName" TEXT,
  "isFirstParty" INTEGER NOT NULL,
  "sourceApi" TEXT,
  "observedAt" DATETIME NOT NULL,
  "runId" TEXT,
  "approvalId" TEXT,
  "meteredReceiptId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DonorOfferObservation_offer_fkey"
    FOREIGN KEY ("donorOfferId") REFERENCES "DonorOffer"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "DonorOfferObservation_product_fkey"
    FOREIGN KEY ("donorProductId") REFERENCES "DonorProduct"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "DonorOfferObservation_variant_fkey"
    FOREIGN KEY ("canonicalVariantId") REFERENCES "CanonicalProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "DonorOfferObservation_decision_fkey"
    FOREIGN KEY ("variantDecisionId") REFERENCES "DonorProductVariantDecision"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "DonorOfferObservation_locality_evidence" CHECK (
    "localityEvidence" IS NULL
    OR "localityEvidence" IN ('zip_scoped','store_scoped','national_unscoped')
  ),
  CONSTRAINT "DonorOfferObservation_variant_pair" CHECK (
    ("canonicalVariantId" IS NULL AND "variantDecisionId" IS NULL)
    OR ("canonicalVariantId" IS NOT NULL AND "variantDecisionId" IS NOT NULL)
  ),
  CONSTRAINT "DonorOfferObservation_run_approval_pair" CHECK (
    ("runId" IS NULL AND "approvalId" IS NULL)
    OR (
      length(trim(COALESCE("runId", ''))) > 0
      AND length(trim(COALESCE("approvalId", ''))) > 0
    )
  ),
  CONSTRAINT "DonorOfferObservation_receipt_requires_run" CHECK (
    "meteredReceiptId" IS NULL OR ("runId" IS NOT NULL AND "approvalId" IS NOT NULL)
  )
);

CREATE INDEX "DonorOfferObservation_offer_observed_idx"
  ON "DonorOfferObservation"("donorOfferId", "observedAt");
CREATE INDEX "DonorOfferObservation_product_observed_idx"
  ON "DonorOfferObservation"("donorProductId", "observedAt");
CREATE INDEX "DonorOfferObservation_variant_observed_idx"
  ON "DonorOfferObservation"("canonicalVariantId", "observedAt");
CREATE INDEX "DonorOfferObservation_retailer_item_observed_idx"
  ON "DonorOfferObservation"("retailer", "retailerProductId", "observedAt");

CREATE TRIGGER "DonorOfferObservation_duplicate_insert_guard"
BEFORE INSERT ON "DonorOfferObservation"
WHEN EXISTS (
  SELECT 1 FROM "DonorOfferObservation" existing
  WHERE existing."id" = NEW."id" OR existing."observationKey" = NEW."observationKey"
)
BEGIN
  SELECT RAISE(ABORT, 'DONOR_OFFER_OBSERVATION_ALREADY_EXISTS');
END;

CREATE TRIGGER "DonorOfferObservation_source_identity_guard"
BEFORE INSERT ON "DonorOfferObservation"
WHEN NOT EXISTS (
  SELECT 1 FROM "DonorOffer" offer
  WHERE offer."id" = NEW."donorOfferId"
    AND offer."donorProductId" = NEW."donorProductId"
    AND offer."retailer" = NEW."retailer"
    AND offer."retailerProductId" = NEW."retailerProductId"
    AND offer."via" = NEW."via"
)
BEGIN
  SELECT RAISE(ABORT, 'DONOR_OFFER_OBSERVATION_SOURCE_MISMATCH');
END;

CREATE TRIGGER "DonorOfferObservation_exact_alias_guard"
BEFORE INSERT ON "DonorOfferObservation"
WHEN NEW."canonicalVariantId" IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM "DonorProductVariantDecision" decision
  JOIN "DonorProduct" product ON product."id" = decision."donorProductId"
  WHERE decision."id" = NEW."variantDecisionId"
    AND decision."decisionStatus" = 'exact_confirmed'
    AND decision."donorProductId" = NEW."donorProductId"
    AND decision."canonicalVariantId" = NEW."canonicalVariantId"
    AND product."identityStatus" = 'exact_confirmed'
)
BEGIN
  SELECT RAISE(ABORT, 'DONOR_OFFER_OBSERVATION_EXACT_ALIAS_REQUIRED');
END;

CREATE TRIGGER "DonorOfferObservation_update_guard"
BEFORE UPDATE ON "DonorOfferObservation"
BEGIN
  SELECT RAISE(ABORT, 'DONOR_OFFER_OBSERVATION_IMMUTABLE');
END;

CREATE TRIGGER "DonorOfferObservation_delete_guard"
BEFORE DELETE ON "DonorOfferObservation"
BEGIN
  SELECT RAISE(ABORT, 'DONOR_OFFER_OBSERVATION_IMMUTABLE');
END;

-- One append-only decision per cost/component. Target identity is always a
-- canonical variant. Content and price are independent evidence axes: an
-- optional content pair is exact-target-only for every price status, while
-- FACT/ESTIMATE/REJECT/MANUAL_FACT govern only price/manual acceptance.
CREATE TABLE "SkuComponentEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "evidenceKey" TEXT NOT NULL UNIQUE CHECK (
    length("evidenceKey") = 64 AND "evidenceKey" NOT GLOB '*[^0-9a-f]*'
  ),
  "skuCostId" TEXT NOT NULL,
  "componentIndex" INTEGER NOT NULL CHECK (
    typeof("componentIndex") = 'integer' AND "componentIndex" >= 0
  ),
  "evidenceStatus" TEXT NOT NULL CHECK ("evidenceStatus" IN ('FACT','MANUAL_FACT','ESTIMATE','REJECT')),
  "targetCanonicalVariantId" TEXT NOT NULL,
  "contentCanonicalVariantId" TEXT,
  "priceCanonicalVariantId" TEXT,
  "contentObservationId" TEXT,
  "priceObservationId" TEXT,
  "matchTier" TEXT NOT NULL CHECK (length(trim("matchTier")) > 0),
  "matcherVersion" TEXT NOT NULL CHECK (
    "matcherVersion" = 'canonical-product-match/1.2.1'
  ),
  "matcherImplementationSha256" TEXT NOT NULL CHECK (
    "matcherImplementationSha256" = '2108b5af839ca1182191305f99196a3a3f1516211e0363691d36f30fae4ac8bb'
  ),
  "matcherReleaseSha256" TEXT NOT NULL CHECK (
    "matcherReleaseSha256" = '027b3a089e6100f9f6ecb212e67e7f6931093f7c30be6aa73c6a0d3dbf6563c2'
  ),
  "pricePolicyVersion" TEXT NOT NULL CHECK (length(trim("pricePolicyVersion")) > 0),
  "evidenceHash" TEXT NOT NULL CHECK (
    length("evidenceHash") = 64 AND "evidenceHash" NOT GLOB '*[^0-9a-f]*'
  ),
  "evidenceJson" TEXT NOT NULL
    CHECK (json_valid("evidenceJson") AND json_type("evidenceJson") = 'object'),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SkuComponentEvidence_cost_fkey"
    FOREIGN KEY ("skuCostId") REFERENCES "SkuCost"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "SkuComponentEvidence_target_variant_fkey"
    FOREIGN KEY ("targetCanonicalVariantId") REFERENCES "CanonicalProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SkuComponentEvidence_content_variant_fkey"
    FOREIGN KEY ("contentCanonicalVariantId") REFERENCES "CanonicalProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SkuComponentEvidence_price_variant_fkey"
    FOREIGN KEY ("priceCanonicalVariantId") REFERENCES "CanonicalProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SkuComponentEvidence_content_observation_fkey"
    FOREIGN KEY ("contentObservationId") REFERENCES "ProductContentObservation"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SkuComponentEvidence_price_observation_fkey"
    FOREIGN KEY ("priceObservationId") REFERENCES "DonorOfferObservation"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "SkuComponentEvidence_cost_component_key"
  ON "SkuComponentEvidence"("skuCostId", "componentIndex");
CREATE INDEX "SkuComponentEvidence_target_variant_idx"
  ON "SkuComponentEvidence"("targetCanonicalVariantId", "evidenceStatus");
CREATE INDEX "SkuComponentEvidence_content_observation_idx"
  ON "SkuComponentEvidence"("contentObservationId");
CREATE INDEX "SkuComponentEvidence_price_observation_idx"
  ON "SkuComponentEvidence"("priceObservationId");

CREATE TRIGGER "SkuComponentEvidence_duplicate_insert_guard"
BEFORE INSERT ON "SkuComponentEvidence"
WHEN EXISTS (
  SELECT 1 FROM "SkuComponentEvidence" existing
  WHERE existing."id" = NEW."id"
     OR existing."evidenceKey" = NEW."evidenceKey"
     OR (
       existing."skuCostId" = NEW."skuCostId"
       AND existing."componentIndex" = NEW."componentIndex"
     )
)
BEGIN
  SELECT RAISE(ABORT, 'SKU_COMPONENT_EVIDENCE_ALREADY_EXISTS');
END;

-- The child set is assembled before its deferred SkuCost parent. Once the
-- parent exists, the component set is sealed forever; otherwise a later INSERT
-- could invalidate a roll-up without re-running the parent's completeness gate.
CREATE TRIGGER "SkuComponentEvidence_sealed_cost_guard"
BEFORE INSERT ON "SkuComponentEvidence"
WHEN EXISTS (
  SELECT 1 FROM "SkuCost" cost WHERE cost."id" = NEW."skuCostId"
)
BEGIN
  SELECT RAISE(ABORT, 'SKU_COST_COMPONENT_EVIDENCE_SEALED');
END;

CREATE TRIGGER "SkuComponentEvidence_contract_insert"
BEFORE INSERT ON "SkuComponentEvidence"
BEGIN
  SELECT CASE
    WHEN (
      NEW."contentCanonicalVariantId" IS NULL
      AND NEW."contentObservationId" IS NOT NULL
    ) OR (
      NEW."contentCanonicalVariantId" IS NOT NULL
      AND NEW."contentObservationId" IS NULL
    ) THEN RAISE(ABORT, 'SKU_COMPONENT_CONTENT_PAIR_INCOMPLETE')
  END;
  SELECT CASE
    WHEN NEW."contentCanonicalVariantId" IS NOT NULL AND (
      NEW."targetCanonicalVariantId" IS NOT NEW."contentCanonicalVariantId"
      OR NOT EXISTS (
        SELECT 1
        FROM "ProductContentObservation" content
        JOIN "DonorProductVariantDecision" decision
          ON decision."id" = content."variantDecisionId"
         AND decision."donorProductId" = content."donorProductId"
         AND decision."canonicalVariantId" = content."canonicalVariantId"
         AND decision."decisionStatus" = 'exact_confirmed'
         AND decision."matcherVersion" = NEW."matcherVersion"
         AND decision."matcherImplementationSha256"
           = NEW."matcherImplementationSha256"
         AND decision."matcherReleaseSha256" = NEW."matcherReleaseSha256"
        WHERE content."id" = NEW."contentObservationId"
          AND content."canonicalVariantId" = NEW."contentCanonicalVariantId"
      )
    ) THEN RAISE(ABORT, 'SKU_COMPONENT_CONTENT_EXACT_CONTRACT_INVALID')
  END;
  SELECT CASE
    WHEN NEW."evidenceStatus" = 'FACT' AND (
      NEW."priceCanonicalVariantId" IS NULL
      OR NEW."priceObservationId" IS NULL
      OR NEW."targetCanonicalVariantId" IS NOT NEW."priceCanonicalVariantId"
      OR NOT EXISTS (
        SELECT 1 FROM "DonorOfferObservation" price
        WHERE price."id" = NEW."priceObservationId"
          AND price."canonicalVariantId" = NEW."priceCanonicalVariantId"
      )
    ) THEN RAISE(ABORT, 'SKU_COMPONENT_FACT_VARIANT_CONTRACT_INVALID')
  END;
  SELECT CASE
    WHEN NEW."evidenceStatus" = 'FACT' AND (
      NEW."matchTier" <> 'EXACT_IDENTITY'
      OR NEW."matcherVersion" <> 'canonical-product-match/1.2.1'
      OR NEW."matcherImplementationSha256"
        <> '2108b5af839ca1182191305f99196a3a3f1516211e0363691d36f30fae4ac8bb'
      OR NEW."matcherReleaseSha256"
        <> '027b3a089e6100f9f6ecb212e67e7f6931093f7c30be6aa73c6a0d3dbf6563c2'
      OR NEW."pricePolicyVersion" <> 'price-evidence-eligibility/1.0.0'
      OR NOT EXISTS (
        SELECT 1 FROM "DonorOfferObservation" price
        JOIN "DonorProductVariantDecision" decision
          ON decision."id" = price."variantDecisionId"
         AND decision."donorProductId" = price."donorProductId"
         AND decision."canonicalVariantId" = price."canonicalVariantId"
         AND decision."decisionStatus" = 'exact_confirmed'
         AND decision."matcherVersion" = NEW."matcherVersion"
         AND decision."matcherImplementationSha256"
           = NEW."matcherImplementationSha256"
         AND decision."matcherReleaseSha256" = NEW."matcherReleaseSha256"
        WHERE price."id" = NEW."priceObservationId"
          AND price."canonicalVariantId" = NEW."priceCanonicalVariantId"
          AND price."via" = 'direct'
          AND price."pricePerUnit" IS NOT NULL
          AND price."pricePerUnit" > 0
          AND price."isFirstParty" = 1
          AND price."inStock" = 1
          AND length(trim(COALESCE(price."productUrl", ''))) > 0
          AND length(trim(COALESCE(price."sourceApi", ''))) > 0
          AND (
            (
              lower(price."retailer") IN (
                'walmart','target','sams','samsclub','costco','bjs','publix','aldi',
                'winndixie','bravo','restaurantdepot','wholefoods','traderjoes',
                'freshmarket','sprouts'
              )
              AND price."localityEvidence" IN ('zip_scoped','store_scoped')
              AND substr(COALESCE(price."zip", ''), 1, 5) = '33765'
              AND length(COALESCE(price."zip", '')) IN (5,10)
            )
            OR (
              lower(price."retailer") = 'amazon'
              AND price."localityEvidence" = 'national_unscoped'
            )
          )
      )
    ) THEN RAISE(ABORT, 'SKU_COMPONENT_FACT_PRICE_CONTRACT_INVALID')
  END;
  SELECT CASE
    WHEN NEW."evidenceStatus" = 'MANUAL_FACT' AND (
      NEW."priceCanonicalVariantId" IS NOT NULL
      OR NEW."priceObservationId" IS NOT NULL
      OR json_type(NEW."evidenceJson", '$.manualCost.policyVersion') IS NOT 'text'
      OR json_extract(NEW."evidenceJson", '$.manualCost.policyVersion') IS NOT NEW."pricePolicyVersion"
      OR COALESCE(json_type(NEW."evidenceJson", '$.manualCost.amount'), '') NOT IN ('integer','real')
      OR CAST(json_extract(NEW."evidenceJson", '$.manualCost.amount') AS REAL) <= 0
      OR json_type(NEW."evidenceJson", '$.manualCost.currency') IS NOT 'text'
      OR length(trim(json_extract(NEW."evidenceJson", '$.manualCost.currency'))) = 0
      OR json_type(NEW."evidenceJson", '$.manualCost.effectiveAt') IS NOT 'text'
      OR length(trim(json_extract(NEW."evidenceJson", '$.manualCost.effectiveAt'))) = 0
      OR julianday(json_extract(NEW."evidenceJson", '$.manualCost.effectiveAt')) IS NULL
      OR json_type(NEW."evidenceJson", '$.manualCost.source') IS NOT 'text'
      OR length(trim(json_extract(NEW."evidenceJson", '$.manualCost.source'))) = 0
      OR json_type(NEW."evidenceJson", '$.manualCost.actor') IS NOT 'text'
      OR length(trim(json_extract(NEW."evidenceJson", '$.manualCost.actor'))) = 0
      OR json_type(NEW."evidenceJson", '$.manualCost.reason') IS NOT 'text'
      OR length(trim(json_extract(NEW."evidenceJson", '$.manualCost.reason'))) = 0
      OR json_type(NEW."evidenceJson", '$.manualCost.approvalRef') IS NOT 'text'
      OR length(trim(json_extract(NEW."evidenceJson", '$.manualCost.approvalRef'))) = 0
      OR NEW."matchTier" <> 'MANUAL_COST'
    ) THEN RAISE(ABORT, 'SKU_COMPONENT_MANUAL_FACT_CONTRACT_INVALID')
  END;
  SELECT CASE
    WHEN NEW."evidenceStatus" = 'ESTIMATE' AND (
      NEW."priceCanonicalVariantId" IS NULL
      OR NEW."priceObservationId" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "DonorOfferObservation" price
        JOIN "DonorProductVariantDecision" decision
          ON decision."id" = price."variantDecisionId"
         AND decision."donorProductId" = price."donorProductId"
         AND decision."canonicalVariantId" = price."canonicalVariantId"
         AND decision."decisionStatus" = 'exact_confirmed'
         AND decision."matcherVersion" = NEW."matcherVersion"
         AND decision."matcherImplementationSha256"
           = NEW."matcherImplementationSha256"
         AND decision."matcherReleaseSha256" = NEW."matcherReleaseSha256"
        WHERE price."id" = NEW."priceObservationId"
          AND price."canonicalVariantId" = NEW."priceCanonicalVariantId"
      )
    ) THEN RAISE(ABORT, 'SKU_COMPONENT_ESTIMATE_PRICE_LINK_INVALID')
  END;
  SELECT CASE
    WHEN NEW."evidenceStatus" = 'ESTIMATE' AND (
      NEW."matchTier" NOT IN (
        'EXACT_IDENTITY','CROSS_SIZE_ESTIMATE','SIBLING_ESTIMATE','SIZE_UNKNOWN_ESTIMATE'
      )
      OR NEW."matcherVersion" <> 'canonical-product-match/1.2.1'
      OR NEW."matcherImplementationSha256"
        <> '2108b5af839ca1182191305f99196a3a3f1516211e0363691d36f30fae4ac8bb'
      OR NEW."matcherReleaseSha256"
        <> '027b3a089e6100f9f6ecb212e67e7f6931093f7c30be6aa73c6a0d3dbf6563c2'
      OR NEW."pricePolicyVersion" <> 'price-evidence-eligibility/1.0.0'
      OR NOT EXISTS (
        SELECT 1 FROM "DonorOfferObservation" price
        WHERE price."id" = NEW."priceObservationId"
          AND price."canonicalVariantId" = NEW."priceCanonicalVariantId"
          AND price."via" IN ('direct','instacart')
          AND price."pricePerUnit" IS NOT NULL
          AND price."pricePerUnit" > 0
          AND price."isFirstParty" = 1
          AND price."inStock" = 1
          AND length(trim(COALESCE(price."productUrl", ''))) > 0
          AND length(trim(COALESCE(price."sourceApi", ''))) > 0
          AND (
            (
              lower(price."retailer") IN (
                'walmart','target','sams','samsclub','costco','bjs','publix','aldi',
                'winndixie','bravo','restaurantdepot','wholefoods','traderjoes',
                'freshmarket','sprouts'
              )
              AND price."localityEvidence" IN ('zip_scoped','store_scoped')
              AND substr(COALESCE(price."zip", ''), 1, 5) = '33765'
              AND length(COALESCE(price."zip", '')) IN (5,10)
            )
            OR (
              lower(price."retailer") = 'amazon'
              AND price."localityEvidence" = 'national_unscoped'
            )
          )
      )
    ) THEN RAISE(ABORT, 'SKU_COMPONENT_ESTIMATE_PRICE_CONTRACT_INVALID')
  END;
  SELECT CASE
    WHEN NEW."evidenceStatus" = 'REJECT' AND (
      NEW."priceCanonicalVariantId" IS NOT NULL
      OR NEW."priceObservationId" IS NOT NULL
    ) THEN RAISE(ABORT, 'SKU_COMPONENT_REJECT_LINK_FORBIDDEN')
  END;
  SELECT CASE WHEN
    json_extract(NEW."evidenceJson", '$.evidenceStatus') IS NOT NEW."evidenceStatus"
    OR json_extract(NEW."evidenceJson", '$.targetCanonicalVariantId')
       IS NOT NEW."targetCanonicalVariantId"
    OR json_extract(NEW."evidenceJson", '$.contentCanonicalVariantId')
       IS NOT NEW."contentCanonicalVariantId"
    OR json_extract(NEW."evidenceJson", '$.priceCanonicalVariantId')
       IS NOT NEW."priceCanonicalVariantId"
    OR json_extract(NEW."evidenceJson", '$.contentObservationId')
       IS NOT NEW."contentObservationId"
    OR json_extract(NEW."evidenceJson", '$.priceObservationId')
       IS NOT NEW."priceObservationId"
    OR json_extract(NEW."evidenceJson", '$.matchTier') IS NOT NEW."matchTier"
    OR json_extract(NEW."evidenceJson", '$.matcherVersion') IS NOT NEW."matcherVersion"
    OR json_extract(NEW."evidenceJson", '$.matcherImplementationSha256')
       IS NOT NEW."matcherImplementationSha256"
    OR json_extract(NEW."evidenceJson", '$.matcherReleaseSha256')
       IS NOT NEW."matcherReleaseSha256"
    OR json_extract(NEW."evidenceJson", '$.pricePolicyVersion') IS NOT NEW."pricePolicyVersion"
    OR json_type(NEW."evidenceJson", '$.qty') IS NOT 'integer'
    OR CAST(json_extract(NEW."evidenceJson", '$.qty') AS INTEGER) <= 0
    OR json_type(NEW."evidenceJson", '$.product') IS NOT 'text'
    OR length(trim(json_extract(NEW."evidenceJson", '$.product'))) = 0
    OR json_type(NEW."evidenceJson", '$.method') IS NOT 'text'
    OR length(trim(json_extract(NEW."evidenceJson", '$.method'))) = 0
    OR (
      NEW."evidenceStatus" IN ('FACT','MANUAL_FACT','ESTIMATE') AND (
        COALESCE(json_type(NEW."evidenceJson", '$.perUnit'), '') NOT IN ('integer','real')
        OR CAST(json_extract(NEW."evidenceJson", '$.perUnit') AS REAL) <= 0
      )
    )
    OR (
      NEW."evidenceStatus" = 'REJECT'
      AND json_extract(NEW."evidenceJson", '$.perUnit') IS NOT NULL
    )
    OR (
      NEW."evidenceStatus" = 'ESTIMATE' AND (
        COALESCE(json_type(NEW."evidenceJson", '$.targetComparableUnitPrice'), '')
          NOT IN ('integer','real')
        OR CAST(json_extract(NEW."evidenceJson", '$.targetComparableUnitPrice') AS REAL) <= 0
        OR abs(
          CAST(json_extract(NEW."evidenceJson", '$.targetComparableUnitPrice') AS REAL)
          - CAST(json_extract(NEW."evidenceJson", '$.perUnit') AS REAL)
        ) > 0.000001
      )
    )
    OR (
      NEW."evidenceStatus" <> 'ESTIMATE'
      AND json_extract(NEW."evidenceJson", '$.targetComparableUnitPrice') IS NOT NULL
    )
  THEN RAISE(ABORT, 'SKU_COMPONENT_EVIDENCE_METADATA_INVALID') END;
END;

CREATE TRIGGER "SkuComponentEvidence_update_guard"
BEFORE UPDATE ON "SkuComponentEvidence"
BEGIN
  SELECT RAISE(ABORT, 'SKU_COMPONENT_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER "SkuComponentEvidence_delete_guard"
BEFORE DELETE ON "SkuComponentEvidence"
BEGIN
  SELECT RAISE(ABORT, 'SKU_COMPONENT_EVIDENCE_IMMUTABLE');
END;

-- Every new cost source is accepted only with complete, hash-addressed
-- immutable evidence. Legacy rows remain untouched because triggers do not
-- retroactively validate existing data.
CREATE TRIGGER "SkuCost_duplicate_insert_guard"
BEFORE INSERT ON "SkuCost"
WHEN EXISTS (
  SELECT 1 FROM "SkuCost" existing
  WHERE existing."id" = NEW."id"
     OR (
       NEW."observationKey" IS NOT NULL
       AND existing."observationKey" = NEW."observationKey"
     )
)
BEGIN
  SELECT RAISE(ABORT, 'SKU_COST_ALREADY_EXISTS');
END;

CREATE TRIGGER "SkuCost_evidence_contract_insert"
BEFORE INSERT ON "SkuCost"
BEGIN
  SELECT CASE WHEN
    NEW."evidenceOutcome" IS NULL
    OR NEW."evidenceOutcome" NOT IN ('FACT','ESTIMATE','UNSOURCEABLE')
    OR NEW."observationKey" IS NULL
    OR length(NEW."observationKey") <> 64
    OR NEW."observationKey" GLOB '*[^0-9a-f]*'
    OR NEW."recipeHash" IS NULL
    OR length(NEW."recipeHash") <> 64
    OR NEW."recipeHash" GLOB '*[^0-9a-f]*'
    OR NEW."evidenceJson" IS NULL
    OR NOT json_valid(NEW."evidenceJson")
    OR json_type(NEW."evidenceJson") <> 'object'
    OR json_extract(NEW."evidenceJson", '$.outcome') IS NOT NEW."evidenceOutcome"
    OR json_extract(NEW."evidenceJson", '$.recipeHash') IS NOT NEW."recipeHash"
    OR json_type(NEW."evidenceJson", '$.components') IS NOT 'array'
    OR json_array_length(NEW."evidenceJson", '$.components') < 1
    OR json_type(NEW."evidenceJson", '$.evaluatedAt') IS NOT 'text'
    OR julianday(json_extract(NEW."evidenceJson", '$.evaluatedAt')) IS NULL
    OR NEW."effectiveDate" IS NULL
    OR julianday(NEW."effectiveDate") IS NULL
    OR julianday(NEW."createdAt") IS NULL
    OR julianday(json_extract(NEW."evidenceJson", '$.evaluatedAt')) > julianday(NEW."createdAt")
    OR julianday(NEW."effectiveDate") > julianday(NEW."createdAt")
    OR NEW."matcherVersion" <> 'canonical-product-match/1.2.1'
    OR NEW."matcherImplementationSha256"
      <> '2108b5af839ca1182191305f99196a3a3f1516211e0363691d36f30fae4ac8bb'
    OR NEW."matcherReleaseSha256"
      <> '027b3a089e6100f9f6ecb212e67e7f6931093f7c30be6aa73c6a0d3dbf6563c2'
    OR json_extract(NEW."evidenceJson", '$.matcherVersion') IS NOT NEW."matcherVersion"
    OR json_extract(NEW."evidenceJson", '$.matcherImplementationSha256')
      IS NOT NEW."matcherImplementationSha256"
    OR json_extract(NEW."evidenceJson", '$.matcherReleaseSha256')
      IS NOT NEW."matcherReleaseSha256"
    OR length(trim(COALESCE(NEW."pricePolicyVersion", ''))) = 0
    OR NOT (
      (NEW."runId" IS NULL AND NEW."approvalId" IS NULL)
      OR (
        length(trim(COALESCE(NEW."runId", ''))) > 0
        AND length(trim(COALESCE(NEW."approvalId", ''))) > 0
      )
    )
    OR (
      NEW."evidenceOutcome" IN ('FACT','ESTIMATE') AND (
        NEW."totalCost" IS NULL OR NEW."totalCost" <= 0
        OR NEW."productCost" IS NULL OR NEW."productCost" <= 0
        OR NEW."costPerUnit" IS NULL OR NEW."costPerUnit" <= 0
        OR NEW."packSize" IS NULL
        OR typeof(NEW."packSize") <> 'integer'
        OR NEW."packSize" < 1
        OR (NEW."packagingCost" IS NOT NULL AND NEW."packagingCost" < 0)
        OR (NEW."iceCost" IS NOT NULL AND NEW."iceCost" < 0)
        OR abs(
          NEW."totalCost" - (
            NEW."productCost"
            + COALESCE(NEW."packagingCost", 0)
            + COALESCE(NEW."iceCost", 0)
          )
        ) > 0.005
        OR abs(NEW."costPerUnit" - (NEW."totalCost" / NEW."packSize")) > 0.005
        OR COALESCE(json_type(NEW."evidenceJson", '$.total'), '') NOT IN ('integer','real')
        OR abs(CAST(json_extract(NEW."evidenceJson", '$.total') AS REAL) - NEW."totalCost") > 0.005
        OR COALESCE(json_type(NEW."evidenceJson", '$.costPerUnit'), '') NOT IN ('integer','real')
        OR abs(CAST(json_extract(NEW."evidenceJson", '$.costPerUnit') AS REAL) - NEW."costPerUnit") > 0.005
        OR json_type(NEW."evidenceJson", '$.packSize') IS NOT 'integer'
        OR CAST(json_extract(NEW."evidenceJson", '$.packSize') AS INTEGER) <> NEW."packSize"
      )
    )
    OR (
      NEW."evidenceOutcome" = 'UNSOURCEABLE' AND (
        NEW."totalCost" IS NOT NULL
        OR NEW."productCost" IS NOT NULL
        OR NEW."costPerUnit" IS NOT NULL
        OR NEW."packagingCost" IS NOT NULL
        OR NEW."iceCost" IS NOT NULL
      )
    )
  THEN RAISE(ABORT, 'SKU_COST_EVIDENCE_REQUIRED') END;
END;

CREATE TRIGGER "SkuCost_component_evidence_guard"
AFTER INSERT ON "SkuCost"
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "SkuComponentEvidence" evidence
    WHERE evidence."skuCostId" = NEW."id"
  ) THEN RAISE(ABORT, 'SKU_COST_COMPONENT_EVIDENCE_REQUIRED') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM "SkuComponentEvidence" evidence
    WHERE evidence."skuCostId" = NEW."id"
      AND (
        evidence."matcherVersion" IS NOT NEW."matcherVersion"
        OR evidence."matcherImplementationSha256"
          IS NOT NEW."matcherImplementationSha256"
        OR evidence."matcherReleaseSha256" IS NOT NEW."matcherReleaseSha256"
      )
  ) THEN RAISE(ABORT, 'SKU_COST_MATCHER_PROVENANCE_MISMATCH') END;
  SELECT CASE WHEN NEW."evidenceOutcome" = 'FACT' AND EXISTS (
    SELECT 1 FROM "SkuComponentEvidence" evidence
    WHERE evidence."skuCostId" = NEW."id"
      AND evidence."evidenceStatus" NOT IN ('FACT','MANUAL_FACT')
  ) THEN RAISE(ABORT, 'SKU_COST_FACT_COMPONENT_STATUS_INVALID') END;
  SELECT CASE WHEN NEW."evidenceOutcome" = 'ESTIMATE' AND (
    NOT EXISTS (
      SELECT 1 FROM "SkuComponentEvidence" evidence
      WHERE evidence."skuCostId" = NEW."id" AND evidence."evidenceStatus" = 'ESTIMATE'
    )
    OR EXISTS (
      SELECT 1 FROM "SkuComponentEvidence" evidence
      WHERE evidence."skuCostId" = NEW."id" AND evidence."evidenceStatus" = 'REJECT'
    )
  ) THEN RAISE(ABORT, 'SKU_COST_ESTIMATE_COMPONENT_STATUS_INVALID') END;
  SELECT CASE WHEN NEW."evidenceOutcome" = 'UNSOURCEABLE' AND NOT EXISTS (
    SELECT 1 FROM "SkuComponentEvidence" evidence
    WHERE evidence."skuCostId" = NEW."id" AND evidence."evidenceStatus" = 'REJECT'
  ) THEN RAISE(ABORT, 'SKU_COST_UNSOURCEABLE_REJECT_REQUIRED') END;

  SELECT CASE WHEN (
    SELECT COUNT(*) FROM "SkuComponentEvidence" evidence
    WHERE evidence."skuCostId" = NEW."id"
  ) <> json_array_length(NEW."evidenceJson", '$.components')
  THEN RAISE(ABORT, 'SKU_COST_COMPONENT_COUNT_MISMATCH') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW."evidenceJson", '$.components') component
    WHERE COALESCE(json_type(component.value, '$.idx'), '') <> 'integer'
       OR CAST(json_extract(component.value, '$.idx') AS INTEGER) < 0
       OR NOT EXISTS (
         SELECT 1 FROM "SkuComponentEvidence" evidence
         WHERE evidence."skuCostId" = NEW."id"
           AND evidence."componentIndex" = CAST(json_extract(component.value, '$.idx') AS INTEGER)
           AND evidence."evidenceStatus" = json_extract(component.value, '$.priceEvidenceStatus')
       )
  ) THEN RAISE(ABORT, 'SKU_COST_COMPONENT_RECIPE_MISMATCH') END;

  SELECT CASE WHEN (
    SELECT COUNT(DISTINCT CAST(json_extract(component.value, '$.idx') AS INTEGER))
    FROM json_each(NEW."evidenceJson", '$.components') component
  ) <> json_array_length(NEW."evidenceJson", '$.components')
  THEN RAISE(ABORT, 'SKU_COST_COMPONENT_INDEX_DUPLICATE') END;

  SELECT CASE WHEN (
    SELECT MIN(CAST(json_extract(component.value, '$.idx') AS INTEGER))
    FROM json_each(NEW."evidenceJson", '$.components') component
  ) <> 0 OR (
    SELECT MAX(CAST(json_extract(component.value, '$.idx') AS INTEGER))
    FROM json_each(NEW."evidenceJson", '$.components') component
  ) <> json_array_length(NEW."evidenceJson", '$.components') - 1
  THEN RAISE(ABORT, 'SKU_COST_COMPONENT_INDEX_NOT_CONTIGUOUS') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM "SkuComponentEvidence" evidence
    JOIN json_each(NEW."evidenceJson", '$.components') component
      ON CAST(json_extract(component.value, '$.idx') AS INTEGER) = evidence."componentIndex"
    LEFT JOIN "ProductContentObservation" content
      ON content."id" = evidence."contentObservationId"
    LEFT JOIN "DonorOfferObservation" price
      ON price."id" = evidence."priceObservationId"
    WHERE evidence."skuCostId" = NEW."id"
      AND (
        evidence."targetCanonicalVariantId"
          IS NOT json_extract(component.value, '$.targetCanonicalVariantId')
        OR evidence."contentCanonicalVariantId"
          IS NOT json_extract(component.value, '$.contentCanonicalVariantId')
        OR evidence."priceCanonicalVariantId"
          IS NOT json_extract(component.value, '$.priceCanonicalVariantId')
        OR evidence."contentObservationId"
          IS NOT json_extract(component.value, '$.contentObservationId')
        OR evidence."priceObservationId"
          IS NOT json_extract(component.value, '$.priceEvidenceObservationId')
        OR content."donorProductId"
          IS NOT json_extract(component.value, '$.contentDonorProductId')
        OR price."donorProductId"
          IS NOT json_extract(component.value, '$.priceEvidenceDonorProductId')
        OR price."donorOfferId"
          IS NOT json_extract(component.value, '$.priceEvidenceOfferId')
        OR price."variantDecisionId"
          IS NOT json_extract(component.value, '$.priceVariantDecisionId')
        OR json_extract(evidence."evidenceJson", '$.evidenceStatus')
          IS NOT json_extract(component.value, '$.priceEvidenceStatus')
        OR json_extract(evidence."evidenceJson", '$.matchTier')
          IS NOT json_extract(component.value, '$.matchTier')
        OR json_extract(evidence."evidenceJson", '$.matcherVersion')
          IS NOT json_extract(component.value, '$.matcherVersion')
        OR json_extract(evidence."evidenceJson", '$.matcherImplementationSha256')
          IS NOT json_extract(component.value, '$.matcherImplementationSha256')
        OR json_extract(evidence."evidenceJson", '$.matcherReleaseSha256')
          IS NOT json_extract(component.value, '$.matcherReleaseSha256')
        OR json_extract(evidence."evidenceJson", '$.pricePolicyVersion')
          IS NOT json_extract(component.value, '$.pricePolicyVersion')
        OR json_extract(evidence."evidenceJson", '$.product')
          IS NOT json_extract(component.value, '$.product')
        OR json_extract(evidence."evidenceJson", '$.flavor')
          IS NOT json_extract(component.value, '$.flavor')
        OR json_extract(evidence."evidenceJson", '$.size')
          IS NOT json_extract(component.value, '$.size')
        OR json_extract(evidence."evidenceJson", '$.qty')
          IS NOT json_extract(component.value, '$.qty')
        OR json_extract(evidence."evidenceJson", '$.perUnit')
          IS NOT json_extract(component.value, '$.perUnit')
        OR json_extract(evidence."evidenceJson", '$.method')
          IS NOT json_extract(component.value, '$.method')
        OR (
          evidence."evidenceStatus" = 'ESTIMATE'
          AND json_extract(evidence."evidenceJson", '$.targetComparableUnitPrice')
            IS NOT json_extract(component.value, '$.perUnit')
        )
      )
  ) THEN RAISE(ABORT, 'SKU_COST_COMPONENT_METADATA_MISMATCH') END;

  SELECT CASE WHEN NEW."evidenceOutcome" IN ('FACT','ESTIMATE') AND (
    EXISTS (
      SELECT 1 FROM json_each(NEW."evidenceJson", '$.components') component
      WHERE COALESCE(json_type(component.value, '$.perUnit'), '') NOT IN ('integer','real')
         OR COALESCE(json_type(component.value, '$.qty'), '') <> 'integer'
         OR CAST(json_extract(component.value, '$.perUnit') AS REAL) <= 0
         OR CAST(json_extract(component.value, '$.qty') AS INTEGER) <= 0
    )
    OR abs((
      SELECT SUM(
        CAST(json_extract(component.value, '$.perUnit') AS REAL)
        * CAST(json_extract(component.value, '$.qty') AS REAL)
      )
      FROM json_each(NEW."evidenceJson", '$.components') component
    ) - NEW."productCost") > 0.005
  ) THEN RAISE(ABORT, 'SKU_COST_COMPONENT_ROLLUP_MISMATCH') END;

  SELECT CASE WHEN NEW."evidenceOutcome" IN ('FACT','ESTIMATE') AND (
    SELECT SUM(CAST(json_extract(component.value, '$.qty') AS INTEGER))
    FROM json_each(NEW."evidenceJson", '$.components') component
  ) <> NEW."packSize"
  THEN RAISE(ABORT, 'SKU_COST_PACK_SIZE_MISMATCH') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM "SkuComponentEvidence" evidence
    JOIN json_each(NEW."evidenceJson", '$.components') component
      ON CAST(json_extract(component.value, '$.idx') AS INTEGER) = evidence."componentIndex"
    WHERE evidence."skuCostId" = NEW."id"
      AND evidence."evidenceStatus" = 'MANUAL_FACT'
      AND abs(
        CAST(json_extract(evidence."evidenceJson", '$.manualCost.amount') AS REAL)
        - CAST(json_extract(component.value, '$.perUnit') AS REAL)
      ) > 0.000001
  ) THEN RAISE(ABORT, 'SKU_COST_MANUAL_AMOUNT_MISMATCH') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM "SkuComponentEvidence" evidence
    WHERE evidence."skuCostId" = NEW."id"
      AND evidence."evidenceStatus" = 'MANUAL_FACT'
      AND (
        json_extract(evidence."evidenceJson", '$.manualCost.currency') IS NOT NEW."currency"
        OR julianday(json_extract(evidence."evidenceJson", '$.manualCost.effectiveAt')) IS NULL
        OR julianday(json_extract(evidence."evidenceJson", '$.manualCost.effectiveAt'))
           > julianday(json_extract(NEW."evidenceJson", '$.evaluatedAt'))
      )
  ) THEN RAISE(ABORT, 'SKU_COST_MANUAL_PROVENANCE_MISMATCH') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM "SkuComponentEvidence" evidence
    JOIN "DonorOfferObservation" price ON price."id" = evidence."priceObservationId"
    WHERE evidence."skuCostId" = NEW."id"
      AND evidence."evidenceStatus" IN ('FACT','ESTIMATE')
      AND (
        julianday(price."observedAt") IS NULL
        OR julianday(json_extract(NEW."evidenceJson", '$.evaluatedAt')) IS NULL
        OR julianday(price."observedAt") > julianday(json_extract(NEW."evidenceJson", '$.evaluatedAt'))
        OR julianday(json_extract(NEW."evidenceJson", '$.evaluatedAt')) - julianday(price."observedAt") > 2.0
      )
  ) THEN RAISE(ABORT, 'SKU_COST_PRICE_OBSERVATION_NOT_FRESH') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM "SkuComponentEvidence" evidence
    JOIN "ProductContentObservation" content ON content."id" = evidence."contentObservationId"
    WHERE evidence."skuCostId" = NEW."id"
      AND (
        julianday(content."observedAt") IS NULL
        OR julianday(content."observedAt")
           > julianday(json_extract(NEW."evidenceJson", '$.evaluatedAt'))
      )
  ) THEN RAISE(ABORT, 'SKU_COST_CONTENT_OBSERVATION_FROM_FUTURE') END;
END;

-- SkuCost is an append-only cost-period ledger. Recalculation inserts a new
-- observationKey; it never rewrites or deletes historical evidence.
CREATE TRIGGER "SkuCost_update_guard"
BEFORE UPDATE ON "SkuCost"
BEGIN
  SELECT RAISE(ABORT, 'SKU_COST_HISTORY_IMMUTABLE');
END;

CREATE TRIGGER "SkuCost_delete_guard"
BEFORE DELETE ON "SkuCost"
BEGIN
  SELECT RAISE(ABORT, 'SKU_COST_HISTORY_IMMUTABLE');
END;
