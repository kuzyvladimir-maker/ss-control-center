import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";
import {
  applyProductTruthCanonicalRecipeReconciliation,
  planProductTruthCanonicalRecipeReconciliation,
  preflightProductTruthCanonicalRecipeReconciliation,
  renderProductTruthCanonicalRecipeReconcilePlan,
  renderProductTruthCanonicalRecipeReconcilePreflight,
} from "../product-truth-canonical-recipe-reconcile";
import {
  buildProductTruthListingRecipeMaterialization,
  materializeProductTruthListingRecipe,
  productTruthListingRecipeStructuralHash,
  type ProductTruthListingRecipeCandidate,
} from "../product-truth-listing-recipe";
import {
  renderProductTruthLegacyBridgeStandingPolicy,
  type ProductTruthLegacyBridgeStandingPolicy,
} from "../product-truth-legacy-bridge-apply";
import {
  assertProductTruthListingScopeSchema,
} from "../product-truth-schema-gate";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const LISTING_KEY = "walmart:1:RECIPE-SKU";
const VARIANT_ID = `cpv1:${HASH_A}`;
const DONOR_ID = "recipe-donor";
const DECISION_ID = "recipe-decision";

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createBaseSchema(db: Client): Promise<void> {
  await db.executeMultiple(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE DonorProduct (
      id TEXT PRIMARY KEY,
      identityKey TEXT,
      brand TEXT,
      productLine TEXT,
      flavor TEXT,
      containerType TEXT,
      size TEXT
    );
    CREATE TABLE DonorOffer (
      id TEXT PRIMARY KEY,
      donorProductId TEXT NOT NULL,
      retailer TEXT NOT NULL,
      retailerProductId TEXT NOT NULL,
      via TEXT NOT NULL DEFAULT 'direct'
    );
    CREATE UNIQUE INDEX donor_offer_dedup
      ON DonorOffer(retailer, retailerProductId);
    CREATE TABLE SkuComponent (
      id TEXT PRIMARY KEY,
      donorProductId TEXT
    );
    CREATE TABLE SkuCost (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      asin TEXT,
      effectiveDate TEXT,
      productCost REAL,
      packagingCost REAL,
      iceCost REAL,
      totalCost REAL,
      costPerUnit REAL,
      packSize INTEGER,
      includesPackaging INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      source TEXT NOT NULL,
      confidence REAL,
      needsReview INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX SkuCost_sku_source_effectiveDate_key
      ON SkuCost(sku, source, effectiveDate);
    CREATE TABLE ProductTruthMigrationReceipt (
      migrationId TEXT PRIMARY KEY,
      migrationSha256 TEXT NOT NULL,
      targetFingerprint TEXT NOT NULL,
      action TEXT NOT NULL,
      appliedAt DATETIME NOT NULL
    );
  `);
  for (const relative of [
    "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
    "../../../../prisma/migrations/20260719002000_product_truth_listing_scope/migration.sql",
    "../../../../prisma/migrations/20260729010000_product_truth_listing_recipe/migration.sql",
  ]) {
    await db.executeMultiple(await readFile(new URL(relative, import.meta.url), "utf8"));
  }
}

async function seedExactIdentity(db: Client): Promise<void> {
  await db.execute({
    sql: `INSERT INTO ProductTruthListingScope (
      listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
      manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
      sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      LISTING_KEY, "product-truth-listing-key/1.0.0", "walmart", 1,
      "RECIPE-SKU", "AUTHORITATIVE_PHASE1_MANIFEST",
      "phase1-authoritative-scope-manifest/v3", HASH_B,
      "2026-07-29T00:00:00.000Z", "owner-scope-decision",
      "scope-report", HASH_C, "2026-07-29T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
    ],
  });
  await db.execute({
    sql: `INSERT INTO CanonicalProductVariant (
      id,variantKey,identityHash,keyVersion,normalizedBrand,
      normalizedProductLine,normalizedFlavor,normalizedModifiersJson,
      normalizedForm,sizeDimension,sizeBaseAmount,sizeBaseUnit,
      outerPackCount,identityJson,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      VARIANT_ID, VARIANT_ID, HASH_A, "canonical-product-variant-key/1.0.0",
      "acme", "orange soda", "orange", "[]", "bottle", "VOLUME", 2000,
      "ml", 1, JSON.stringify({ brand: "acme", productLine: "orange soda" }),
      "2026-07-29T00:01:00.000Z",
    ],
  });
  await db.execute({
    sql: `INSERT INTO DonorProduct (
      id,identityKey,brand,productLine,flavor,containerType,size,identityStatus
    ) VALUES (?,?,?,?,?,?,?,'candidate')`,
    args: [
      DONOR_ID, "acme|orange-soda|2-l", "Acme", "Orange Soda", "Orange",
      "bottle", "2 L",
    ],
  });
  const decisionEvidence = JSON.stringify({
    verdict: "EXACT_IDENTITY",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  });
  await db.execute({
    sql: `INSERT INTO DonorProductVariantDecision (
      id,decisionKey,donorProductId,canonicalVariantId,decisionStatus,
      matcherVersion,matcherImplementationSha256,matcherReleaseSha256,
      evidenceHash,evidenceJson,decidedAt,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      DECISION_ID, `decision:${DECISION_ID}`, DONOR_ID, VARIANT_ID,
      "exact_confirmed", CANONICAL_PRODUCT_MATCHER_VERSION,
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256, sha(decisionEvidence),
      decisionEvidence, "2026-07-29T00:02:00.000Z",
      "2026-07-29T00:02:00.000Z",
    ],
  });
  await db.execute({
    sql: `UPDATE DonorProduct SET
      identityStatus='exact_confirmed',
      identityMatcherVersion=?,
      identityMatcherImplementationSha256=?,
      identityMatcherReleaseSha256=?,
      identityEvidenceJson=?,
      identityConfirmedAt='2026-07-29T00:02:00.000Z'
      WHERE id=?`,
    args: [
      CANONICAL_PRODUCT_MATCHER_VERSION,
      CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
      decisionEvidence,
      DONOR_ID,
    ],
  });
}

function candidate(
  sourceEvidence: unknown = { sealedPlanSha256: HASH_A },
): ProductTruthListingRecipeCandidate {
  return {
    listingKey: LISTING_KEY,
    manifestSha256: HASH_B,
    sourceKind: "TARGETED_WALMART_EVIDENCE",
    sourceArtifactSha256: HASH_C,
    effectiveAt: "2026-07-29T00:03:00.000Z",
    createdAt: "2026-07-29T00:04:00.000Z",
    runId: "recipe-run",
    approvalId: "recipe-approval",
    components: [{
      componentIndex: 0,
      quantity: 6,
      product: "Acme Orange Soda",
      flavor: "Orange",
      size: "2 L",
      targetCanonicalVariantId: VARIANT_ID,
      donorProductId: DONOR_ID,
      variantDecisionId: DECISION_ID,
      sourceComponentId: "legacy-component-0",
      sourceEvidence,
    }],
  };
}

async function seedCanonicalCostGraph(db: Client): Promise<void> {
  await db.execute({
    sql: `INSERT INTO ProductTruthMigrationReceipt (
      migrationId,migrationSha256,targetFingerprint,action,appliedAt
    ) VALUES (?,?,?,?,?)`,
    args: [
      "20260729010000_product_truth_listing_recipe",
      "1800ecf61715e1c61dbb9113c5e688dce2544002b3e564ea6f11f6f569b2acba",
      HASH_A,
      "applied",
      "2026-07-29T00:04:00.000Z",
    ],
  });
  const costId = "recipe-cost";
  const recipeHash = productTruthListingRecipeStructuralHash({
    listingKey: LISTING_KEY,
    components: [{
      componentIndex: 0,
      quantity: 6,
      targetCanonicalVariantId: VARIANT_ID,
    }],
  });
  const legacyCostRecipeHash = HASH_B;
  assert.notEqual(recipeHash, legacyCostRecipeHash);
  const componentEvidence = {
    schemaVersion: "product-truth-sku-component-evidence/1.0.0",
    evidenceStatus: "REJECT",
    targetCanonicalVariantId: VARIANT_ID,
    contentCanonicalVariantId: null,
    priceCanonicalVariantId: null,
    contentObservationId: null,
    priceObservationId: null,
    matchTier: "EXACT_IDENTITY",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: "price-evidence-eligibility/1.0.0",
    product: "Acme Orange Soda",
    flavor: "Orange",
    size: "2 L",
    qty: 6,
    perUnit: null,
    method: "no-fresh-first-party-price",
    targetComparableUnitPrice: null,
  };
  const costComponent = {
    idx: 0,
    targetCanonicalVariantId: VARIANT_ID,
    contentCanonicalVariantId: null,
    priceCanonicalVariantId: null,
    contentObservationId: null,
    priceEvidenceObservationId: null,
    contentDonorProductId: null,
    priceEvidenceDonorProductId: null,
    priceEvidenceOfferId: null,
    priceVariantDecisionId: null,
    priceEvidenceStatus: "REJECT",
    matchTier: "EXACT_IDENTITY",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    pricePolicyVersion: "price-evidence-eligibility/1.0.0",
    product: "Acme Orange Soda",
    flavor: "Orange",
    size: "2 L",
    qty: 6,
    perUnit: null,
    method: "no-fresh-first-party-price",
  };
  const costEvidence = {
    schemaVersion: "product-truth-cogs-evidence/1.0.0",
    channel: "walmart",
    storeIndex: 1,
    listingKey: LISTING_KEY,
    listingKeyVersion: "product-truth-listing-key/1.0.0",
    outcome: "UNSOURCEABLE",
    recipeHash: legacyCostRecipeHash,
    evaluatedAt: "2026-07-29T00:03:00.000Z",
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    matcherImplementationSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    matcherReleaseSha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    components: [costComponent],
  };
  const componentJson = JSON.stringify(componentEvidence);
  const costJson = JSON.stringify(costEvidence);
  await db.batch([
    {
      sql: `INSERT INTO SkuComponentEvidence (
        id,evidenceKey,skuCostId,componentIndex,evidenceStatus,
        targetCanonicalVariantId,contentCanonicalVariantId,
        priceCanonicalVariantId,contentObservationId,priceObservationId,
        matchTier,matcherVersion,matcherImplementationSha256,
        matcherReleaseSha256,pricePolicyVersion,evidenceHash,evidenceJson,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "recipe-component-evidence", HASH_C, costId, 0, "REJECT",
        VARIANT_ID, null, null, null, null, "EXACT_IDENTITY",
        CANONICAL_PRODUCT_MATCHER_VERSION,
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
        "price-evidence-eligibility/1.0.0", sha(componentJson), componentJson,
        "2026-07-29T00:03:00.000Z",
      ],
    },
    {
      sql: `INSERT INTO SkuCostListingScopeLink (
        skuCostId,listingKey,linkVersion,createdAt
      ) VALUES (?,?,?,?)`,
      args: [
        costId,
        LISTING_KEY,
        "sku-cost-listing-scope-link/1.0.0",
        "2026-07-29T00:03:00.000Z",
      ],
    },
    {
      sql: `INSERT INTO SkuCost (
        id,sku,effectiveDate,productCost,packagingCost,iceCost,totalCost,
        costPerUnit,packSize,includesPackaging,currency,source,confidence,
        needsReview,notes,createdAt,updatedAt,observationKey,recipeHash,
        evidenceJson,evidenceOutcome,matcherVersion,
        matcherImplementationSha256,matcherReleaseSha256,pricePolicyVersion,
        runId,approvalId
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        costId, "RECIPE-SKU", "2026-07-29T00:03:00.000Z",
        null, null, null, null, null, null, 0, "USD",
        "retail:batch", null, 1, "fixture",
        "2026-07-29T00:03:00.000Z", "2026-07-29T00:03:00.000Z",
        HASH_A, legacyCostRecipeHash, costJson, "UNSOURCEABLE",
        CANONICAL_PRODUCT_MATCHER_VERSION,
        CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
        CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
        "price-evidence-eligibility/1.0.0", null, null,
      ],
    },
  ], "write");
}

test("listing recipe is structural, independent of cost, append-only, and idempotent", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await seedExactIdentity(db);
    await assertProductTruthListingScopeSchema(db);

    const first = buildProductTruthListingRecipeMaterialization(candidate());
    const changedEvidence = buildProductTruthListingRecipeMaterialization(candidate({
      sealedPlanSha256: HASH_A,
      additionalIdentitySource: "same exact variant",
    }));
    assert.equal(first.recipe.recipeHash, changedEvidence.recipe.recipeHash);
    assert.notEqual(first.recipe.recipeKey, changedEvidence.recipe.recipeKey);

    const applied = await materializeProductTruthListingRecipe(db, candidate());
    assert.equal(applied.status, "APPLIED");
    assert.equal(applied.componentCount, 1);
    assert.equal(
      Number((await db.execute("SELECT COUNT(*) AS n FROM SkuCost")).rows[0]?.n),
      0,
      "recipe must exist without manufacturing a cost outcome",
    );
    assert.equal(
      Number((await db.execute(
        "SELECT COUNT(*) AS n FROM ProductTruthListingRecipeComponent",
      )).rows[0]?.n),
      1,
    );

    const repeated = await materializeProductTruthListingRecipe(db, candidate());
    assert.equal(repeated.status, "ALREADY_APPLIED");

    await assert.rejects(
      db.execute({
        sql: "UPDATE ProductTruthListingRecipe SET sourceKind=? WHERE id=?",
        args: ["LEGACY_BRIDGE", applied.recipeId],
      }),
      /PRODUCT_TRUTH_LISTING_RECIPE_IMMUTABLE/,
    );
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO ProductTruthListingRecipeComponent (
          id,componentKey,listingRecipeId,componentIndex,quantity,product,
          targetCanonicalVariantId,donorProductId,variantDecisionId,
          evidenceHash,evidenceJson,createdAt
        ) SELECT ?,?,id,1,1,'Acme Orange Soda',?,?,?, ?,?,
                 '2026-07-29T00:04:00.000Z'
            FROM ProductTruthListingRecipe WHERE id=?`,
        args: [
          "late-component", "d".repeat(64), VARIANT_ID, DONOR_ID, DECISION_ID,
          "e".repeat(64),
          JSON.stringify({
            componentIndex: 1,
            quantity: 1,
            product: "Acme Orange Soda",
            targetCanonicalVariantId: VARIANT_ID,
            donorProductId: DONOR_ID,
            variantDecisionId: DECISION_ID,
          }),
          applied.recipeId,
        ],
      }),
      /PRODUCT_TRUTH_LISTING_RECIPE_COMPONENTS_SEALED/,
    );
  } finally {
    db.close();
  }
});

test("bounded standing-authority reconciliation restores a recipe from an exact canonical cost graph", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-recipe-reconcile-"));
  const db = createClient({ url: `file:${join(directory, "fixture.sqlite")}` });
  try {
    await createBaseSchema(db);
    await seedExactIdentity(db);
    await seedCanonicalCostGraph(db);
    const plan = await planProductTruthCanonicalRecipeReconciliation({
      db,
      databaseTargetFingerprint: HASH_A,
      manifestSha256: HASH_B,
      listingKeys: [LISTING_KEY],
      createdAt: "2026-07-29T00:05:00.000Z",
      expiresAt: "2026-07-29T23:59:00.000Z",
    });
    assert.deepEqual(plan.databaseWrites, {
      maximumRows: 2,
      listingRecipes: 1,
      listingRecipeComponents: 1,
    });
    assert.equal(
      plan.targets[0].sourceBinding.costRecipeHashMode,
      "LEGACY_PRE_LISTING_RECIPE_MIGRATION",
    );
    const planJson = renderProductTruthCanonicalRecipeReconcilePlan(plan);
    const planSha256 = sha(planJson);
    const preflight = await preflightProductTruthCanonicalRecipeReconciliation({
      db,
      databaseTargetFingerprint: HASH_A,
      plan,
      planJson,
      planSha256,
      checkedAt: "2026-07-29T00:06:00.000Z",
    });
    assert.equal(preflight.status, "READY_TO_APPLY");
    const preflightJson =
      renderProductTruthCanonicalRecipeReconcilePreflight(preflight);
    const policy: ProductTruthLegacyBridgeStandingPolicy = {
      schemaVersion: "product-truth-legacy-bridge-standing-policy/1.0.0",
      policyId: "recipe-standing-policy",
      approvedBy: "owner",
      issuedAt: "2026-07-29T00:00:00.000Z",
      expiresAt: null,
      databaseTargetFingerprint: HASH_A,
      manifestSha256: HASH_B,
      maximumDatabaseRowsPerWave: 100,
      maximumPreflightAgeMs: 15 * 60 * 1_000,
      requiresCollisionFree: true,
      requiresFreshReadyToApplyPreflight: true,
      allowCanonicalMaterialization: true,
      allowProviderCalls: false,
      allowPaidCalls: false,
      allowMarketplaceListingWrites: false,
      allowPriceChanges: false,
      allowInventoryChanges: false,
      allowDelisting: false,
      allowConsumerActivation: false,
      allowProcurement: false,
      revocationRequiresOwnerDecision: true,
      ownerStatement: "Fixture bounded canonical materialization.",
    };
    const policyJson = renderProductTruthLegacyBridgeStandingPolicy(policy);
    const applied = await applyProductTruthCanonicalRecipeReconciliation({
      db,
      databaseTargetFingerprint: HASH_A,
      plan,
      planJson,
      planSha256,
      standingPolicy: policy,
      standingPolicyJson: policyJson,
      standingPolicySha256: sha(policyJson),
      preflight,
      preflightJson,
      preflightSha256: sha(preflightJson),
      startedAt: "2026-07-29T00:06:00.000Z",
      completedAt: "2026-07-29T00:06:00.000Z",
    });
    assert.equal(applied.status, "APPLIED");
    assert.equal(applied.counts.insertedRows, 2);
    assert.equal(
      (await db.execute(
        "SELECT sourceKind FROM ProductTruthListingRecipe",
      )).rows[0]?.sourceKind,
      "CANONICAL_COST_GRAPH",
    );
    const postcheck = await preflightProductTruthCanonicalRecipeReconciliation({
      db,
      databaseTargetFingerprint: HASH_A,
      plan,
      planJson,
      planSha256,
      checkedAt: "2026-07-29T00:07:00.000Z",
    });
    assert.equal(postcheck.status, "ALREADY_APPLIED");
    assert.equal(postcheck.counts.exactExistingRows, 2);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("listing recipe rejects a donor decision that is not the target identity", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await createBaseSchema(db);
    await seedExactIdentity(db);
    const invalid = candidate();
    invalid.components = [{
      ...invalid.components[0],
      donorProductId: "other-donor",
    }];
    await assert.rejects(
      materializeProductTruthListingRecipe(db, invalid),
      /LISTING_RECIPE_EXACT_IDENTITY_INVALID/,
    );
    assert.equal(
      Number((await db.execute(
        "SELECT COUNT(*) AS n FROM ProductTruthListingRecipe",
      )).rows[0]?.n),
      0,
    );
  } finally {
    db.close();
  }
});
