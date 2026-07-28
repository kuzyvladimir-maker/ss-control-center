-- Canonical marketplace listing scope for Product Truth cost evidence.
--
-- This migration is intentionally schema-only. It does not infer account scope
-- from a raw SKU, mutable channel mirrors, SkuShippingData, SkuComponent, or
-- historical SkuCost rows. Registry rows must be imported from a checksummed,
-- authoritative Phase 1 manifest; pre-migration costs remain unscoped legacy.

CREATE TABLE "ProductTruthListingScope" (
  "listingKey" TEXT NOT NULL PRIMARY KEY,
  "keyVersion" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "storeIndex" INTEGER NOT NULL,
  "sku" TEXT NOT NULL,
  "registrationKind" TEXT NOT NULL,
  "manifestSchemaVersion" TEXT NOT NULL,
  "manifestSha256" TEXT NOT NULL,
  "manifestAsOf" DATETIME NOT NULL,
  "ownerDecisionId" TEXT NOT NULL,
  "sourceReportId" TEXT NOT NULL,
  "sourceContentSha256" TEXT NOT NULL,
  "sourceCapturedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductTruthListingScope_key_version" CHECK (
    "keyVersion" = 'product-truth-listing-key/1.0.0'
  ),
  CONSTRAINT "ProductTruthListingScope_channel_canonical" CHECK (
    "channel" IN ('amazon', 'walmart')
  ),
  CONSTRAINT "ProductTruthListingScope_store_index_positive" CHECK (
    typeof("storeIndex") = 'integer' AND "storeIndex" > 0
  ),
  CONSTRAINT "ProductTruthListingScope_raw_sku_exact" CHECK (
    length("sku") > 0 AND "sku" = trim("sku")
  ),
  CONSTRAINT "ProductTruthListingScope_deterministic_key" CHECK (
    "listingKey" = "channel" || ':' || CAST("storeIndex" AS TEXT) || ':' || "sku"
  ),
  CONSTRAINT "ProductTruthListingScope_authoritative_manifest_only" CHECK (
    "registrationKind" = 'AUTHORITATIVE_PHASE1_MANIFEST'
    AND "manifestSchemaVersion" = 'phase1-authoritative-scope-manifest/v3'
  ),
  CONSTRAINT "ProductTruthListingScope_manifest_hash" CHECK (
    length("manifestSha256") = 64
    AND "manifestSha256" = lower("manifestSha256")
    AND "manifestSha256" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT "ProductTruthListingScope_source_hash" CHECK (
    length("sourceContentSha256") = 64
    AND "sourceContentSha256" = lower("sourceContentSha256")
    AND "sourceContentSha256" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT "ProductTruthListingScope_provenance_required" CHECK (
    length(trim("ownerDecisionId")) > 0
    AND length(trim("sourceReportId")) > 0
    AND julianday("sourceCapturedAt") IS NOT NULL
    AND julianday("manifestAsOf") IS NOT NULL
    AND julianday("createdAt") IS NOT NULL
    AND julianday("sourceCapturedAt") <= julianday("manifestAsOf")
    AND julianday("manifestAsOf") <= julianday("createdAt")
  )
);

CREATE UNIQUE INDEX "ProductTruthListingScope_channel_store_sku_key"
  ON "ProductTruthListingScope"("channel", "storeIndex", "sku");
CREATE INDEX "ProductTruthListingScope_manifest_idx"
  ON "ProductTruthListingScope"("manifestSha256", "listingKey");

-- INSERT OR REPLACE must not be able to erase immutable registry history even
-- when SQLite recursive_triggers is disabled.
CREATE TRIGGER "ProductTruthListingScope_duplicate_insert_guard"
BEFORE INSERT ON "ProductTruthListingScope"
WHEN EXISTS (
  SELECT 1 FROM "ProductTruthListingScope" existing
  WHERE existing."listingKey" = NEW."listingKey"
     OR (
       existing."channel" = NEW."channel"
       AND existing."storeIndex" = NEW."storeIndex"
       AND existing."sku" = NEW."sku"
     )
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_SCOPE_ALREADY_EXISTS');
END;

CREATE TRIGGER "ProductTruthListingScope_update_guard"
BEFORE UPDATE ON "ProductTruthListingScope"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_SCOPE_IMMUTABLE');
END;

CREATE TRIGGER "ProductTruthListingScope_delete_guard"
BEFORE DELETE ON "ProductTruthListingScope"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_SCOPE_IMMUTABLE');
END;

-- One immutable cost observation belongs to exactly one canonical listing.
-- The SkuCost FK is deferred so the writer can insert this child before the
-- append-only SkuCost parent; the parent trigger below seals the atomic graph.
CREATE TABLE "SkuCostListingScopeLink" (
  "skuCostId" TEXT NOT NULL PRIMARY KEY,
  "listingKey" TEXT NOT NULL,
  "linkVersion" TEXT NOT NULL CHECK (
    "linkVersion" = 'sku-cost-listing-scope-link/1.0.0'
  ),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    CHECK (julianday("createdAt") IS NOT NULL),
  CONSTRAINT "SkuCostListingScopeLink_cost_fk"
    FOREIGN KEY ("skuCostId") REFERENCES "SkuCost"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "SkuCostListingScopeLink_scope_fk"
    FOREIGN KEY ("listingKey") REFERENCES "ProductTruthListingScope"("listingKey")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "SkuCostListingScopeLink_listing_cost_idx"
  ON "SkuCostListingScopeLink"("listingKey", "skuCostId");

CREATE TRIGGER "SkuCostListingScopeLink_duplicate_insert_guard"
BEFORE INSERT ON "SkuCostListingScopeLink"
WHEN EXISTS (
  SELECT 1 FROM "SkuCostListingScopeLink" existing
  WHERE existing."skuCostId" = NEW."skuCostId"
)
BEGIN
  SELECT RAISE(ABORT, 'SKU_COST_LISTING_SCOPE_LINK_ALREADY_EXISTS');
END;

CREATE TRIGGER "SkuCostListingScopeLink_contract_insert"
BEFORE INSERT ON "SkuCostListingScopeLink"
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "ProductTruthListingScope" scope
    WHERE scope."listingKey" = NEW."listingKey"
  ) THEN RAISE(ABORT, 'SKU_COST_LISTING_SCOPE_NOT_REGISTERED') END;

  -- If a parent already exists, it must be the same exact canonical retail
  -- scope. Child-first writes are validated when their parent is inserted.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM "SkuCost" cost
    JOIN "ProductTruthListingScope" scope
      ON scope."listingKey" = NEW."listingKey"
    WHERE cost."id" = NEW."skuCostId"
      AND (
        cost."source" IS NOT 'retail:batch'
        OR cost."sku" IS NOT scope."sku"
        OR json_extract(cost."evidenceJson", '$.channel') IS NOT scope."channel"
        OR json_extract(cost."evidenceJson", '$.storeIndex') IS NOT scope."storeIndex"
        OR json_extract(cost."evidenceJson", '$.listingKey') IS NOT scope."listingKey"
      )
  ) THEN RAISE(ABORT, 'SKU_COST_LISTING_SCOPE_PARENT_MISMATCH') END;
END;

CREATE TRIGGER "SkuCostListingScopeLink_update_guard"
BEFORE UPDATE ON "SkuCostListingScopeLink"
BEGIN
  SELECT RAISE(ABORT, 'SKU_COST_LISTING_SCOPE_LINK_IMMUTABLE');
END;

CREATE TRIGGER "SkuCostListingScopeLink_delete_guard"
BEFORE DELETE ON "SkuCostListingScopeLink"
BEGIN
  SELECT RAISE(ABORT, 'SKU_COST_LISTING_SCOPE_LINK_IMMUTABLE');
END;

-- New canonical retail costs must declare their exact scope in evidence and
-- arrive with a pre-created link. There is deliberately no legacy fallback.
CREATE TRIGGER "SkuCost_listing_scope_contract_insert"
BEFORE INSERT ON "SkuCost"
WHEN NEW."source" = 'retail:batch'
BEGIN
  SELECT CASE WHEN (
    NEW."evidenceJson" IS NULL
    OR NOT json_valid(NEW."evidenceJson")
    OR json_type(NEW."evidenceJson", '$.channel') IS NOT 'text'
    OR length(trim(json_extract(NEW."evidenceJson", '$.channel'))) = 0
    OR json_extract(NEW."evidenceJson", '$.channel')
       IS NOT lower(trim(json_extract(NEW."evidenceJson", '$.channel')))
    OR json_type(NEW."evidenceJson", '$.storeIndex') IS NOT 'integer'
    OR CAST(json_extract(NEW."evidenceJson", '$.storeIndex') AS INTEGER) <= 0
    OR json_type(NEW."evidenceJson", '$.listingKey') IS NOT 'text'
    OR json_extract(NEW."evidenceJson", '$.listingKey') IS NOT
       json_extract(NEW."evidenceJson", '$.channel') || ':' ||
       CAST(json_extract(NEW."evidenceJson", '$.storeIndex') AS TEXT) || ':' || NEW."sku"
    OR json_extract(NEW."evidenceJson", '$.listingKeyVersion')
       IS NOT 'product-truth-listing-key/1.0.0'
  ) THEN RAISE(ABORT, 'SKU_COST_LISTING_SCOPE_EVIDENCE_INVALID') END;
END;

CREATE TRIGGER "SkuCost_listing_scope_link_guard"
AFTER INSERT ON "SkuCost"
WHEN NEW."source" = 'retail:batch'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM "SkuCostListingScopeLink" link
    JOIN "ProductTruthListingScope" scope
      ON scope."listingKey" = link."listingKey"
    WHERE link."skuCostId" = NEW."id"
      AND scope."sku" = NEW."sku"
      AND scope."channel" = json_extract(NEW."evidenceJson", '$.channel')
      AND scope."storeIndex" = json_extract(NEW."evidenceJson", '$.storeIndex')
      AND scope."listingKey" = json_extract(NEW."evidenceJson", '$.listingKey')
      AND scope."keyVersion" = json_extract(NEW."evidenceJson", '$.listingKeyVersion')
      AND julianday(scope."createdAt") <= julianday(NEW."createdAt")
      AND julianday(link."createdAt") <= julianday(NEW."createdAt")
  ) THEN RAISE(ABORT, 'SKU_COST_LISTING_SCOPE_LINK_REQUIRED') END;
END;

CREATE TRIGGER "SkuCost_nonretail_listing_scope_guard"
AFTER INSERT ON "SkuCost"
WHEN NEW."source" <> 'retail:batch'
  AND EXISTS (
    SELECT 1 FROM "SkuCostListingScopeLink" link
    WHERE link."skuCostId" = NEW."id"
  )
BEGIN
  SELECT RAISE(ABORT, 'SKU_COST_LISTING_SCOPE_RETAIL_BATCH_ONLY');
END;
