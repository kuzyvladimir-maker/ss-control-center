import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createClient, type Client } from "@libsql/client";

import {
  buildCanonicalProductVariantKey,
} from "../canonical-product-variant";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION,
  renderProductTruthLegacyBridgeStandingPolicy,
  type ProductTruthLegacyBridgeStandingPolicy,
} from "../product-truth-legacy-bridge-apply";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionTarget,
} from "../product-truth-component-acquisition-scope";
import {
  ProductTruthComponentResolutionMaterializationError,
  applyProductTruthComponentResolutionMaterialization,
  compileProductTruthComponentResolutionMaterializationPlan,
  preflightProductTruthComponentResolutionMaterialization,
  renderProductTruthComponentResolutionPreflightReport,
  renderProductTruthComponentResolutionMaterializationPlan,
  type ProductTruthComponentResolutionMaterializationSources,
} from "../product-truth-component-resolution-materialization";

const CAPTURED_AT = "2026-07-30T01:00:00.000Z";
const CREATED_AT = "2026-07-30T02:00:00.000Z";
const EXPIRES_AT = "2026-07-30T02:05:00.000Z";
const FINGERPRINT = "a".repeat(64);
const MANIFEST_SHA = "b".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const identity = {
  brand: "Acme",
  productLine: "Crunch",
  flavor: "Barbecue",
  form: "bag",
  size: "8 oz",
  outerPackCount: 1,
};
const variant = buildCanonicalProductVariantKey(identity);

function donor(title = "Acme Crunch Barbecue 8 oz bag"):
ProductTruthLegacyBridgeDonorRow {
  return {
    id: "donor-acme-barbecue",
    brand: "Acme",
    productLine: null,
    flavor: null,
    containerType: "bag",
    size: "8 oz",
    category: "snacks",
    upc: "012345678905",
    gtin: null,
    title,
    description: "Acme barbecue crunch snack.",
    bullets: JSON.stringify(["Barbecue flavor"]),
    attributes: JSON.stringify({ form: "bag" }),
    nutritionFacts: JSON.stringify({ calories: 100 }),
    ingredients: "Potatoes, oil, seasoning",
    mainImageUrl: "https://example.test/acme-main.jpg",
    imageUrls: JSON.stringify([
      "https://example.test/acme-main.jpg",
      "https://example.test/acme-back.jpg",
    ]),
    identityKey: "legacy:donor-acme-barbecue",
    identityStatus: "legacy_unverified",
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
  };
}

function offer(): ProductTruthLegacyBridgeOfferRow {
  return {
    id: "do:walmart:acme-barbecue",
    donorProductId: "donor-acme-barbecue",
    retailer: "walmart",
    retailerProductId: "acme-barbecue",
    via: "direct",
    price: 3.99,
    packSizeSeen: 1,
    pricePerUnit: 3.99,
    currency: "USD",
    zip: "33765",
    localityEvidence: "zip_scoped",
    inStock: true,
    productUrl: "https://www.walmart.com/ip/acme-barbecue/1",
    isFirstParty: true,
    sourceApi: "fixture",
    fetchedAt: CAPTURED_AT,
  };
}

function acquisitionTarget(
  overrides: Partial<ProductTruthComponentAcquisitionTarget> = {},
): ProductTruthComponentAcquisitionTarget {
  return {
    ordinal: 0,
    acquisitionPriority: 1,
    canonicalVariantId: variant.canonicalVariantId,
    canonicalIdentityHash: variant.identityHash,
    canonicalIdentityJson: variant.identityJson,
    targetIdentity: identity,
    identityQuality: {
      status: "ACQUISITION_READY",
      blockerCodes: [],
    },
    acquisitionLane: "EXISTING_CATALOG_EXACT_CANDIDATE",
    exactCatalogCandidates: [{
      donorProductId: "donor-acme-barbecue",
      title: "Acme Crunch Barbecue 8 oz bag",
      brand: "Acme",
      size: "8 oz",
      upc: "012345678905",
      gtin: null,
      ordinaryFirstPartyOffers: [{
        offerId: "do:walmart:acme-barbecue",
        retailer: "walmart",
        retailerProductId: "acme-barbecue",
        productUrl: "https://www.walmart.com/ip/acme-barbecue/1",
      }],
      canonicalBindings: [],
    }],
    impact: {
      componentUses: 1,
      dependentListings: 1,
      immediateClosableListings: 1,
      amazonListings: 0,
      walmartListings: 1,
      knownGmv30d: 10,
      knownOrders30d: 1,
      knownUnits30d: 1,
    },
    dependencies: [{
      listingKey: "walmart:1:ACME-1",
      channel: "walmart",
      storeIndex: 1,
      sku: "ACME-1",
      componentIndex: 0,
      quantity: 2,
      repairLane: "RETAILER_IDENTITY_RESEARCH",
      legacyComponentId: "component-acme-1",
      legacyDonorProductId: "donor-acme-barbecue",
      historicalEvidence: null,
      priority: {
        gmv30d: 10,
        orders30d: 1,
        units30d: 1,
        repairPriority: 1,
      },
    }],
    ...overrides,
  };
}

function fixture(input: {
  donorTitle?: string;
  targets?: ProductTruthComponentAcquisitionTarget[];
} = {}): ProductTruthComponentResolutionMaterializationSources {
  const snapshot = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: CAPTURED_AT,
    targetFingerprint: FINGERPRINT,
    manifest: {
      schemaVersion: "phase1-authoritative-scope-manifest/v3",
      sha256: MANIFEST_SHA,
      asOf: CAPTURED_AT,
      listingCount: 1,
    },
    listings: [],
    components: [],
    donors: [donor(input.donorTitle)],
    offers: [offer()],
    canonicalDonorBindings: [],
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
    authoritativeWalmartItemReportEvidence: [],
    bundleFactoryRecipeEvidence: [],
  } satisfies ProductTruthLegacyBridgeSnapshot;
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
  const snapshotSha256 = sha256(snapshotJson);
  const targets = input.targets ?? [acquisitionTarget()];
  const scope = {
    schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
    generatedAt: CAPTURED_AT,
    source: {
      recipeRepairScope: {
        schemaVersion: "product-truth-recipe-repair-scope/1.0.0",
        sha256: "c".repeat(64),
        generatedAt: CAPTURED_AT,
        missingListings: 1,
      },
      bridgeSnapshot: {
        schemaVersion: snapshot.schemaVersion,
        sha256: snapshotSha256,
        capturedAt: snapshot.capturedAt,
        targetFingerprint: snapshot.targetFingerprint,
        donorCount: 1,
        offerCount: 1,
        canonicalBindingCount: 0,
      },
    },
    matcher: {
      version: "canonical-product-match/1.2.1",
      implementationSha256:
        "2108b5af839ca1182191305f99196a3a3f1516211e0363691d36f30fae4ac8bb",
      releaseSha256:
        "027b3a089e6100f9f6ecb212e67e7f6931093f7c30be6aa73c6a0d3dbf6563c2",
    },
    selectionPolicy: {
      unitOfWork: "UNIQUE_CANONICAL_COMPONENT_VARIANT",
      catalogSearch:
        "ALL_EXISTING_DONORS_SAME_EXACT_NORMALIZED_BRAND_STRICT_TITLE_AND_EXACT_CONTENT_PACKAGE_MATCH",
      contentIdentityPolicyVersion:
        "exact-content-identity-policy/1.0.0",
      identityQuality:
        "REJECT_EXPLICIT_UNCERTAINTY_AMBIGUOUS_SIZE_AND_INDIVIDUAL_VARIETY_PLACEHOLDERS",
      ordinaryRetailersOnly: true,
      clubsExcluded: true,
      bjsExcluded: true,
      ranking: [
        "IDENTITY_QUALITY_READY_FIRST",
        "IMMEDIATE_CLOSABLE_LISTINGS_DESC",
        "KNOWN_GMV_30D_DESC",
        "DEPENDENT_LISTINGS_DESC",
        "KNOWN_ORDERS_30D_DESC",
        "KNOWN_UNITS_30D_DESC",
        "EXISTING_EVIDENCE_LANE_ASC",
        "CANONICAL_VARIANT_ID_ASC",
      ],
    },
    counts: {
      denominatorListings: 1,
      missingListings: 1,
      missingListingsWithoutComponents: 0,
      missingListingsWithInvalidComponentGraph: 0,
      missingListingsWithAllCanonicalTargets: 1,
      componentUses: targets.length,
      canonicalComponentUses: targets.length,
      invalidComponentUses: 0,
      uniqueCanonicalTargets: targets.length,
      acquisitionReadyTargets: targets.length,
      identityRecoveryTargets: 0,
      acquisitionLaneCounts: [
        { lane: "EXISTING_CANONICAL_BINDING", count: 0 },
        {
          lane: "EXISTING_CATALOG_EXACT_CANDIDATE",
          count: targets.length,
        },
        { lane: "PROVIDER_IDENTITY_ACQUISITION", count: 0 },
        { lane: "EXISTING_CATALOG_AMBIGUOUS", count: 0 },
        { lane: "CANONICAL_DONOR_CONFLICT", count: 0 },
        { lane: "TARGET_IDENTITY_RECOVERY_REQUIRED", count: 0 },
      ],
    },
    projectedClosures: [{
      topTargets: targets.length,
      fullyCoveredListings: 1,
    }],
    targets,
    invalidComponentDependencies: [],
    claims: {
      readOnlySources: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      createsAdditionalCatalog: false,
      existingCatalogScannedGlobally: true,
      legacyDonorLinkIsNotIdentityProof: true,
      oneResolvedComponentMayServeManyListings: true,
    },
  } satisfies ProductTruthComponentAcquisitionScope;
  const scopeJson = renderProductTruthComponentAcquisitionScope(scope);
  const policy = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_STANDING_POLICY_VERSION,
    policyId: "standing-free-materialization",
    approvedBy: "owner",
    issuedAt: CAPTURED_AT,
    expiresAt: null,
    databaseTargetFingerprint: FINGERPRINT,
    manifestSha256: MANIFEST_SHA,
    maximumDatabaseRowsPerWave: 100,
    maximumPreflightAgeMs: 300_000,
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
    ownerStatement: "Bounded no-paid exact canonical materialization.",
  } satisfies ProductTruthLegacyBridgeStandingPolicy;
  const policyJson = renderProductTruthLegacyBridgeStandingPolicy(policy);
  return {
    componentScope: scope,
    componentScopeJson: scopeJson,
    componentScopeSha256: sha256(scopeJson),
    bridgeSnapshot: snapshot,
    bridgeSnapshotJson: snapshotJson,
    bridgeSnapshotSha256: snapshotSha256,
    standingPolicy: policy,
    standingPolicyJson: policyJson,
    standingPolicySha256: sha256(policyJson),
  };
}

const MIGRATION_IDS = [
  "20260718230000_product_truth_queue_v2",
  "20260718233000_donor_harvest_lifecycle",
  "20260718234500_product_truth_evidence_provenance",
  "20260719000000_metered_budget_ledger",
  "20260719001000_product_truth_metered_evidence_link",
  "20260719002000_product_truth_listing_scope",
  "20260719003000_product_truth_queue_listing_scope",
  "20260719004000_product_truth_operational_run",
  "20260729010000_product_truth_listing_recipe",
] as const;

async function createBaseSchema(db: Client): Promise<void> {
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(`
    CREATE TABLE EnrichmentJob (
      id TEXT PRIMARY KEY, targetType TEXT NOT NULL DEFAULT 'brand',
      target TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL DEFAULT 'manual', priority INTEGER NOT NULL DEFAULT 0,
      requestedBy TEXT, attempts INTEGER NOT NULL DEFAULT 0, result TEXT,
      error TEXT, queuedAt DATETIME, startedAt DATETIME, finishedAt DATETIME,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE DonorProduct (
      id TEXT PRIMARY KEY, brand TEXT, productLine TEXT, flavor TEXT,
      containerType TEXT, size TEXT, unitMeasure TEXT, unitAmount REAL,
      category TEXT, upc TEXT, gtin TEXT, title TEXT, description TEXT,
      bullets TEXT, attributes TEXT, nutritionFacts TEXT, ingredients TEXT,
      mainImageUrl TEXT, imageUrls TEXT, bestPrice REAL, bestRetailer TEXT,
      pricePerMeasure REAL, currency TEXT NOT NULL DEFAULT 'USD',
      identityKey TEXT NOT NULL UNIQUE, confidence REAL,
      needsReview INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE DonorOffer (
      id TEXT PRIMARY KEY, donorProductId TEXT NOT NULL,
      retailer TEXT NOT NULL, retailerProductId TEXT NOT NULL, via TEXT NOT NULL,
      price REAL, packSizeSeen INTEGER, pricePerUnit REAL,
      currency TEXT NOT NULL DEFAULT 'USD', zip TEXT, inStock INTEGER,
      productUrl TEXT, sellerName TEXT, isFirstParty INTEGER NOT NULL DEFAULT 0,
      sourceApi TEXT, fetchedAt TEXT, createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL,
      FOREIGN KEY (donorProductId) REFERENCES DonorProduct(id)
    );
    CREATE UNIQUE INDEX donor_offer_dedup
      ON DonorOffer(retailer, retailerProductId);
    CREATE TABLE SkuComponent (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, channel TEXT, idx INTEGER NOT NULL,
      product TEXT NOT NULL, flavor TEXT, size TEXT, qty INTEGER NOT NULL,
      perUnitCost REAL, lineCost REAL, currency TEXT NOT NULL DEFAULT 'USD',
      retailer TEXT, matchedTitle TEXT, costMethod TEXT, donorProductId TEXT,
      isBundleComponent INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL,
      UNIQUE(sku, idx)
    );
    CREATE TABLE SkuCost (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, asin TEXT, effectiveDate TEXT,
      productCost REAL, packagingCost REAL, iceCost REAL, totalCost REAL,
      costPerUnit REAL, packSize INTEGER,
      includesPackaging INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD', source TEXT NOT NULL,
      confidence REAL, needsReview INTEGER NOT NULL DEFAULT 0, notes TEXT,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE INDEX SkuCost_sku_idx ON SkuCost(sku);
    CREATE TABLE SkuShippingData (
      id TEXT PRIMARY KEY, sku TEXT UNIQUE, marketplace TEXT,
      productIdentity TEXT, upc TEXT, upcSource TEXT,
      unitsInListing INTEGER, baseUnitDesc TEXT, source TEXT,
      createdAt DATETIME, updatedAt DATETIME
    );
    CREATE TABLE WalmartListingQualityItem (
      id TEXT PRIMARY KEY, storeIndex INTEGER NOT NULL, sku TEXT NOT NULL,
      gmv30d REAL, orders30d INTEGER, units30d INTEGER, scoredAt DATETIME,
      UNIQUE(storeIndex, sku)
    );
    CREATE TABLE MasterBundle (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pack_count INTEGER NOT NULL,
      updated_at DATETIME NOT NULL
    );
    CREATE TABLE ChannelSKU (
      id TEXT PRIMARY KEY, master_bundle_id TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE, asin TEXT, title TEXT NOT NULL,
      updated_at DATETIME NOT NULL
    );
    CREATE TABLE BundleComponent (
      id TEXT PRIMARY KEY, master_bundle_id TEXT NOT NULL,
      product_name TEXT NOT NULL, manufacturer_brand TEXT NOT NULL,
      manufacturer_upc TEXT, flavor TEXT, variant TEXT, qty INTEGER NOT NULL,
      unit_weight_oz REAL, unit_weight_lb REAL, source_url TEXT,
      updated_at DATETIME NOT NULL
    );
  `);
}

async function applyMigrations(db: Client): Promise<void> {
  for (const migrationId of MIGRATION_IDS) {
    const migration = new URL(
      `../../../../prisma/migrations/${migrationId}/migration.sql`,
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migration, "utf8"));
  }
}

async function seedSources(
  db: Client,
  sources: ProductTruthComponentResolutionMaterializationSources,
): Promise<void> {
  const sourceDonor = sources.bridgeSnapshot.donors[0]!;
  const sourceOffer = sources.bridgeSnapshot.offers[0]!;
  await db.execute({
    sql: `INSERT INTO DonorProduct (
      id,brand,productLine,flavor,containerType,size,category,upc,gtin,title,
      description,bullets,attributes,nutritionFacts,ingredients,mainImageUrl,
      imageUrls,identityKey,identityStatus,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      sourceDonor.id, sourceDonor.brand, sourceDonor.productLine,
      sourceDonor.flavor, sourceDonor.containerType, sourceDonor.size,
      sourceDonor.category, sourceDonor.upc, sourceDonor.gtin,
      sourceDonor.title, sourceDonor.description, sourceDonor.bullets,
      sourceDonor.attributes, sourceDonor.nutritionFacts,
      sourceDonor.ingredients, sourceDonor.mainImageUrl,
      sourceDonor.imageUrls, sourceDonor.identityKey,
      sourceDonor.identityStatus, sourceDonor.createdAt,
      sourceDonor.updatedAt,
    ],
  });
  await db.execute({
    sql: `INSERT INTO DonorOffer (
      id,donorProductId,retailer,retailerProductId,via,price,packSizeSeen,
      pricePerUnit,currency,zip,localityEvidence,inStock,productUrl,
      isFirstParty,sourceApi,fetchedAt,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      sourceOffer.id, sourceOffer.donorProductId, sourceOffer.retailer,
      sourceOffer.retailerProductId, sourceOffer.via, sourceOffer.price,
      sourceOffer.packSizeSeen, sourceOffer.pricePerUnit,
      sourceOffer.currency, sourceOffer.zip, sourceOffer.localityEvidence,
      Number(sourceOffer.inStock), sourceOffer.productUrl,
      Number(sourceOffer.isFirstParty), sourceOffer.sourceApi,
      sourceOffer.fetchedAt, CAPTURED_AT, CAPTURED_AT,
    ],
  });
}

test("component resolution plan materializes only canonical identity/content rows", () => {
  const plan = compileProductTruthComponentResolutionMaterializationPlan({
    sources: fixture(),
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.databaseWrites.maximumRows, 4);
  assert.equal(plan.databaseWrites.listingRecipes, 0);
  assert.equal(plan.databaseWrites.skuCosts, 0);
  assert.equal(plan.targets[0]?.variant.id, variant.canonicalVariantId);
  assert.equal(plan.targets[0]?.decision.decisionStatus, "exact_confirmed");
  assert.equal(plan.targets[0]?.content.sourceUrl, offer().productUrl);
  assert.equal(plan.claims.providerCalls, 0);
  assert.equal(plan.claims.paidCalls, 0);
  assert.equal(
    renderProductTruthComponentResolutionMaterializationPlan(plan),
    renderProductTruthComponentResolutionMaterializationPlan(plan),
  );
});

test("component resolution independently rejects same-unit package drift", () => {
  assert.throws(
    () =>
      compileProductTruthComponentResolutionMaterializationPlan({
        sources: fixture({
          donorTitle: "Acme Crunch Barbecue 8.05 oz bag",
        }),
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
      }),
    (error: unknown) =>
      error instanceof ProductTruthComponentResolutionMaterializationError
      && error.code === "COMPONENT_RESOLUTION_CONTENT_IDENTITY_REJECTED",
  );
});

test("component resolution rejects a repeated donor across target variants", () => {
  const aliasIdentity = {
    ...identity,
    productLine: "Crunch Barbecue",
  };
  const alias = buildCanonicalProductVariantKey(aliasIdentity);
  const second = acquisitionTarget({
    ordinal: 1,
    acquisitionPriority: 2,
    canonicalVariantId: alias.canonicalVariantId,
    canonicalIdentityHash: alias.identityHash,
    canonicalIdentityJson: alias.identityJson,
    targetIdentity: aliasIdentity,
  });
  assert.throws(
    () =>
      compileProductTruthComponentResolutionMaterializationPlan({
        sources: fixture({
          targets: [acquisitionTarget(), second],
        }),
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
      }),
    (error: unknown) =>
      error instanceof ProductTruthComponentResolutionMaterializationError
      && error.code
        === "COMPONENT_RESOLUTION_TARGET_SET_NOT_COLLISION_FREE",
  );
});

test("component resolution applies atomically and becomes idempotent", async (t) => {
  const sources = fixture();
  const plan = compileProductTruthComponentResolutionMaterializationPlan({
    sources,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  });
  const planJson =
    renderProductTruthComponentResolutionMaterializationPlan(plan);
  const planSha256 = sha256(planJson);
  const directory = await mkdtemp(join(tmpdir(), "pt-component-resolution-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = createClient({
    url: `file:${join(directory, "fixture.sqlite")}`,
    concurrency: 1,
  });
  try {
    await createBaseSchema(db);
    await applyMigrations(db);
    await seedSources(db, sources);
    const preflight =
      await preflightProductTruthComponentResolutionMaterialization({
        db,
        databaseTargetFingerprint: plan.databaseTargetFingerprint,
        plan,
        planJson,
        planSha256,
        sources,
        checkedAt: "2026-07-30T02:01:00.000Z",
      });
    assert.equal(preflight.status, "READY_TO_APPLY");
    assert.equal(preflight.counts.absentRows, 4);
    const preflightJson =
      renderProductTruthComponentResolutionPreflightReport(preflight);
    const report =
      await applyProductTruthComponentResolutionMaterialization({
        db,
        databaseTargetFingerprint: plan.databaseTargetFingerprint,
        plan,
        planJson,
        planSha256,
        sources,
        preflightReport: preflight,
        preflightReportJson: preflightJson,
        preflightReportSha256: sha256(preflightJson),
        startedAt: "2026-07-30T02:02:00.000Z",
      });
    assert.equal(report.status, "APPLIED");
    assert.equal(report.counts.insertedRows, 4);
    assert.equal(report.counts.donorIdentityTransitions, 1);
    assert.equal(report.verification.exactTargets, 1);
    assert.equal(report.verification.listingRecipesMaterialized, 0);
    assert.equal(report.verification.skuCostsMaterialized, 0);
    const post =
      await preflightProductTruthComponentResolutionMaterialization({
        db,
        databaseTargetFingerprint: plan.databaseTargetFingerprint,
        plan,
        planJson,
        planSha256,
        sources,
        checkedAt: "2026-07-30T02:03:00.000Z",
      });
    assert.equal(post.status, "ALREADY_APPLIED");
    assert.equal(post.counts.exactExistingRows, 4);
  } finally {
    db.close();
  }
});
