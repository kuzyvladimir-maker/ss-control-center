-- Product Truth listing recipes are an independent, append-only identity axis.
-- They must survive missing/estimated/unsourceable prices and incomplete
-- content. This migration performs no legacy inference and no backfill.

CREATE TABLE "ProductTruthListingRecipe" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "recipeKey" TEXT NOT NULL UNIQUE CHECK (
    length("recipeKey") = 64 AND "recipeKey" NOT GLOB '*[^0-9a-f]*'
  ),
  "listingKey" TEXT NOT NULL,
  "recipeVersion" TEXT NOT NULL CHECK (
    "recipeVersion" = 'product-truth-listing-recipe/1.0.0'
  ),
  "recipeHash" TEXT NOT NULL CHECK (
    length("recipeHash") = 64 AND "recipeHash" NOT GLOB '*[^0-9a-f]*'
  ),
  "componentCount" INTEGER NOT NULL CHECK (
    typeof("componentCount") = 'integer' AND "componentCount" >= 1
  ),
  "sourceKind" TEXT NOT NULL CHECK (
    "sourceKind" IN (
      'TARGETED_WALMART_EVIDENCE',
      'LEGACY_BRIDGE',
      'CANONICAL_COST_GRAPH'
    )
  ),
  "sourceArtifactSha256" TEXT NOT NULL CHECK (
    length("sourceArtifactSha256") = 64
    AND "sourceArtifactSha256" NOT GLOB '*[^0-9a-f]*'
  ),
  "manifestSha256" TEXT NOT NULL CHECK (
    length("manifestSha256") = 64
    AND "manifestSha256" NOT GLOB '*[^0-9a-f]*'
  ),
  "evidenceHash" TEXT NOT NULL CHECK (
    length("evidenceHash") = 64 AND "evidenceHash" NOT GLOB '*[^0-9a-f]*'
  ),
  "evidenceJson" TEXT NOT NULL CHECK (
    json_valid("evidenceJson") AND json_type("evidenceJson") = 'object'
  ),
  "effectiveAt" DATETIME NOT NULL,
  "runId" TEXT,
  "approvalId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductTruthListingRecipe_listing_fkey"
    FOREIGN KEY ("listingKey") REFERENCES "ProductTruthListingScope"("listingKey")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "ProductTruthListingRecipeComponent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "componentKey" TEXT NOT NULL UNIQUE CHECK (
    length("componentKey") = 64 AND "componentKey" NOT GLOB '*[^0-9a-f]*'
  ),
  "listingRecipeId" TEXT NOT NULL,
  "componentIndex" INTEGER NOT NULL CHECK (
    typeof("componentIndex") = 'integer' AND "componentIndex" >= 0
  ),
  "quantity" INTEGER NOT NULL CHECK (
    typeof("quantity") = 'integer' AND "quantity" >= 1
  ),
  "product" TEXT NOT NULL CHECK (length(trim("product")) > 0),
  "flavor" TEXT,
  "size" TEXT,
  "targetCanonicalVariantId" TEXT NOT NULL,
  "donorProductId" TEXT NOT NULL,
  "variantDecisionId" TEXT NOT NULL,
  "sourceComponentId" TEXT,
  "evidenceHash" TEXT NOT NULL CHECK (
    length("evidenceHash") = 64 AND "evidenceHash" NOT GLOB '*[^0-9a-f]*'
  ),
  "evidenceJson" TEXT NOT NULL CHECK (
    json_valid("evidenceJson") AND json_type("evidenceJson") = 'object'
  ),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductTruthListingRecipeComponent_recipe_fkey"
    FOREIGN KEY ("listingRecipeId") REFERENCES "ProductTruthListingRecipe"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ProductTruthListingRecipeComponent_variant_fkey"
    FOREIGN KEY ("targetCanonicalVariantId") REFERENCES "CanonicalProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProductTruthListingRecipeComponent_donor_fkey"
    FOREIGN KEY ("donorProductId") REFERENCES "DonorProduct"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProductTruthListingRecipeComponent_decision_fkey"
    FOREIGN KEY ("variantDecisionId") REFERENCES "DonorProductVariantDecision"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ProductTruthListingRecipeComponent_recipe_index_key"
  ON "ProductTruthListingRecipeComponent"("listingRecipeId", "componentIndex");
CREATE INDEX "ProductTruthListingRecipe_current_idx"
  ON "ProductTruthListingRecipe"("listingKey", "effectiveAt", "createdAt");
CREATE INDEX "ProductTruthListingRecipe_hash_idx"
  ON "ProductTruthListingRecipe"("listingKey", "recipeHash");
CREATE INDEX "ProductTruthListingRecipeComponent_variant_donor_idx"
  ON "ProductTruthListingRecipeComponent"(
    "targetCanonicalVariantId", "donorProductId"
  );
CREATE INDEX "ProductTruthListingRecipeComponent_decision_idx"
  ON "ProductTruthListingRecipeComponent"("variantDecisionId");

CREATE TRIGGER "ProductTruthListingRecipeComponent_duplicate_insert_guard"
BEFORE INSERT ON "ProductTruthListingRecipeComponent"
WHEN EXISTS (
  SELECT 1 FROM "ProductTruthListingRecipeComponent" existing
  WHERE existing."id" = NEW."id"
     OR existing."componentKey" = NEW."componentKey"
     OR (
       existing."listingRecipeId" = NEW."listingRecipeId"
       AND existing."componentIndex" = NEW."componentIndex"
     )
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_COMPONENT_ALREADY_EXISTS');
END;

-- Components are inserted child-first inside one deferred-FK transaction.
-- Once the recipe header exists the component set is sealed forever.
CREATE TRIGGER "ProductTruthListingRecipeComponent_sealed_recipe_guard"
BEFORE INSERT ON "ProductTruthListingRecipeComponent"
WHEN EXISTS (
  SELECT 1 FROM "ProductTruthListingRecipe" recipe
  WHERE recipe."id" = NEW."listingRecipeId"
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_COMPONENTS_SEALED');
END;

CREATE TRIGGER "ProductTruthListingRecipeComponent_contract_insert"
BEFORE INSERT ON "ProductTruthListingRecipeComponent"
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM "DonorProductVariantDecision" decision
    JOIN "DonorProduct" donor ON donor."id" = decision."donorProductId"
    JOIN "CanonicalProductVariant" variant
      ON variant."id" = decision."canonicalVariantId"
    WHERE decision."id" = NEW."variantDecisionId"
      AND decision."decisionStatus" = 'exact_confirmed'
      AND decision."donorProductId" = NEW."donorProductId"
      AND decision."canonicalVariantId" = NEW."targetCanonicalVariantId"
      AND donor."identityStatus" = 'exact_confirmed'
      AND variant."id" = NEW."targetCanonicalVariantId"
  ) THEN RAISE(
    ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_EXACT_IDENTITY_REQUIRED'
  ) END;
  SELECT CASE WHEN
    json_extract(NEW."evidenceJson", '$.componentIndex') IS NOT NEW."componentIndex"
    OR json_extract(NEW."evidenceJson", '$.quantity') IS NOT NEW."quantity"
    OR json_extract(NEW."evidenceJson", '$.product') IS NOT NEW."product"
    OR json_extract(NEW."evidenceJson", '$.targetCanonicalVariantId')
      IS NOT NEW."targetCanonicalVariantId"
    OR json_extract(NEW."evidenceJson", '$.donorProductId')
      IS NOT NEW."donorProductId"
    OR json_extract(NEW."evidenceJson", '$.variantDecisionId')
      IS NOT NEW."variantDecisionId"
  THEN RAISE(
    ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_COMPONENT_EVIDENCE_INVALID'
  ) END;
END;

CREATE TRIGGER "ProductTruthListingRecipe_duplicate_insert_guard"
BEFORE INSERT ON "ProductTruthListingRecipe"
WHEN EXISTS (
  SELECT 1 FROM "ProductTruthListingRecipe" existing
  WHERE existing."id" = NEW."id" OR existing."recipeKey" = NEW."recipeKey"
)
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_ALREADY_EXISTS');
END;

CREATE TRIGGER "ProductTruthListingRecipe_contract_insert"
BEFORE INSERT ON "ProductTruthListingRecipe"
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "ProductTruthListingScope" scope
    WHERE scope."listingKey" = NEW."listingKey"
      AND scope."manifestSha256" = NEW."manifestSha256"
      AND scope."registrationKind" = 'AUTHORITATIVE_PHASE1_MANIFEST'
  ) THEN RAISE(
    ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_SCOPE_INVALID'
  ) END;
  SELECT CASE WHEN
    julianday(NEW."effectiveAt") IS NULL
    OR julianday(NEW."createdAt") IS NULL
    OR julianday(NEW."effectiveAt") > julianday(NEW."createdAt")
    OR json_extract(NEW."evidenceJson", '$.schemaVersion')
      IS NOT NEW."recipeVersion"
    OR json_extract(NEW."evidenceJson", '$.listingKey') IS NOT NEW."listingKey"
    OR json_extract(NEW."evidenceJson", '$.recipeHash') IS NOT NEW."recipeHash"
    OR json_extract(NEW."evidenceJson", '$.manifestSha256')
      IS NOT NEW."manifestSha256"
    OR json_extract(NEW."evidenceJson", '$.sourceKind') IS NOT NEW."sourceKind"
    OR json_extract(NEW."evidenceJson", '$.sourceArtifactSha256')
      IS NOT NEW."sourceArtifactSha256"
    OR json_extract(NEW."evidenceJson", '$.effectiveAt') IS NOT NEW."effectiveAt"
    OR json_type(NEW."evidenceJson", '$.components') IS NOT 'array'
    OR json_array_length(NEW."evidenceJson", '$.components')
      IS NOT NEW."componentCount"
  THEN RAISE(
    ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_EVIDENCE_INVALID'
  ) END;
END;

-- The component set is already present when the header is inserted. Validate
-- completeness, contiguous indexes, and byte-bound structural equality.
CREATE TRIGGER "ProductTruthListingRecipe_component_set_guard"
AFTER INSERT ON "ProductTruthListingRecipe"
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM "ProductTruthListingRecipeComponent" component
    WHERE component."listingRecipeId" = NEW."id"
  ) <> NEW."componentCount"
  THEN RAISE(
    ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_COMPONENT_COUNT_MISMATCH'
  ) END;
  SELECT CASE WHEN (
    SELECT MIN(component."componentIndex")
    FROM "ProductTruthListingRecipeComponent" component
    WHERE component."listingRecipeId" = NEW."id"
  ) <> 0 OR (
    SELECT MAX(component."componentIndex")
    FROM "ProductTruthListingRecipeComponent" component
    WHERE component."listingRecipeId" = NEW."id"
  ) <> NEW."componentCount" - 1
  THEN RAISE(
    ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_INDEX_NOT_CONTIGUOUS'
  ) END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW."evidenceJson", '$.components') expected
    WHERE json_type(expected.value, '$.componentIndex') IS NOT 'integer'
       OR NOT EXISTS (
         SELECT 1
         FROM "ProductTruthListingRecipeComponent" component
         WHERE component."listingRecipeId" = NEW."id"
           AND component."componentIndex"
             = CAST(json_extract(expected.value, '$.componentIndex') AS INTEGER)
           AND component."quantity"
             = CAST(json_extract(expected.value, '$.quantity') AS INTEGER)
           AND component."targetCanonicalVariantId"
             = json_extract(expected.value, '$.targetCanonicalVariantId')
           AND component."donorProductId"
             = json_extract(expected.value, '$.donorProductId')
           AND component."variantDecisionId"
             = json_extract(expected.value, '$.variantDecisionId')
       )
  ) THEN RAISE(
    ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_COMPONENT_SET_INVALID'
  ) END;
END;

CREATE TRIGGER "ProductTruthListingRecipe_update_guard"
BEFORE UPDATE ON "ProductTruthListingRecipe"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_IMMUTABLE');
END;

CREATE TRIGGER "ProductTruthListingRecipe_delete_guard"
BEFORE DELETE ON "ProductTruthListingRecipe"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_IMMUTABLE');
END;

CREATE TRIGGER "ProductTruthListingRecipeComponent_update_guard"
BEFORE UPDATE ON "ProductTruthListingRecipeComponent"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_COMPONENT_IMMUTABLE');
END;

CREATE TRIGGER "ProductTruthListingRecipeComponent_delete_guard"
BEFORE DELETE ON "ProductTruthListingRecipeComponent"
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_TRUTH_LISTING_RECIPE_COMPONENT_IMMUTABLE');
END;
