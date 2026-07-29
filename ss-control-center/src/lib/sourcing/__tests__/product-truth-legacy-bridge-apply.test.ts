import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createClient, type Client } from "@libsql/client";

import { buildCanonicalProductVariantKey } from "../canonical-product-variant";
import {
  applyProductTruthLegacyBridgeWave,
  expectedProductTruthLegacyBridgeConfirmation,
  planProductTruthLegacyBridgeApply,
  preflightProductTruthLegacyBridgeWave,
  renderProductTruthLegacyBridgeApplyPlan,
  renderProductTruthLegacyBridgeApproval,
  renderProductTruthLegacyBridgePreflightReport,
  renderProductTruthLegacyBridgeStandingPolicy,
  PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE,
  type ProductTruthLegacyBridgeApproval,
  type ProductTruthLegacyBridgeStandingPolicy,
} from "../product-truth-legacy-bridge-apply";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  compileProductTruthLegacyBridgePlan,
  productTruthLegacyBridgeBytesSha256,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthDirectTargetContentEvidence,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import { renderProductTruthOperationalJson } from "../product-truth-operational-run-contract";
import { readProductTruthSnapshot } from "../product-truth-read-contract";

const CAPTURED_AT = "2026-07-26T10:00:00.000Z";
const PLAN_CREATED_AT = "2026-07-26T12:00:00.000Z";
const PLAN_EXPIRES_AT = "2026-07-27T12:00:00.000Z";
const APPLY_AT = "2026-07-26T13:00:00.000Z";
const TARGET_FINGERPRINT = "b".repeat(64);
const MANIFEST_SHA256 = "a".repeat(64);
const VALID_UPC = "036000291452";
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

function sourceFixture(): {
  snapshot: ProductTruthLegacyBridgeSnapshot;
  snapshotJson: string;
  snapshotSha256: string;
  bridgePlanJson: string;
  bridgePlanSha256: string;
  bridgePlan: ReturnType<typeof compileProductTruthLegacyBridgePlan>;
  listingKeys: string[];
} {
  const listings = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    return {
      listingKey: `walmart:1:SKU-${number}`,
      channel: "walmart" as const,
      storeIndex: 1,
      sku: `SKU-${number}`,
      listingUpc: null,
      listingUpcSource: null,
      priorityGmv30d: 0,
      priorityOrders30d: 0,
      priorityUnits30d: 0,
      priorityObservedAt: "2026-07-26T09:00:00.000Z",
      productIdentityJson: JSON.stringify({
        brand: `Acme Brand ${number}`,
        product_line: "Crunch Chips",
        flavor: "Original",
        size: "8 oz",
        container_type: "bag",
        units_in_listing: number,
        is_bundle: false,
        components: [],
      }),
      productIdentityUpdatedAt: "2026-07-25T09:00:00.000Z",
    };
  });
  const components = listings.map((listing, index) => ({
    id: `legacy-component-${index + 1}`,
    sku: listing.sku,
    idx: 0,
    product: "Crunch Chips",
    flavor: "Original",
    size: "8 oz",
    qty: index + 1,
    costMethod: "exact",
    retailer: "walmart",
    matchedTitle: `Acme Brand ${index + 1} Crunch Chips Original, 8 oz Bag`,
    perUnitCost: 2.99,
    lineCost: 2.99 * (index + 1),
    donorProductId: `donor-${index + 1}`,
    contentDonorProductId: null,
    priceEvidenceDonorProductId: null,
    priceEvidenceOfferId: null,
  }));
  const donors = listings.map((listing, index) => {
    const number = index + 1;
    const main = `https://images.example.test/${number}/main.jpg`;
    return {
      id: `donor-${number}`,
      brand: `Acme Brand ${number}`,
      productLine: "Crunch Chips",
      flavor: "Original",
      containerType: "bag",
      size: "8 oz",
      category: "Dry",
      upc: VALID_UPC,
      gtin: null,
      title: `Acme Brand ${number} Crunch Chips Original, 8 oz Bag`,
      description: `Complete exact description ${number}`,
      bullets: JSON.stringify(["One", "Two"]),
      attributes: JSON.stringify([
        { name: "Food condition", value: "Shelf-Stable" },
      ]),
      nutritionFacts: JSON.stringify({
        calories: 120,
        allergens: ["milk"],
      }),
      ingredients: "Corn, oil. Contains: Milk.",
      mainImageUrl: main,
      imageUrls: JSON.stringify([
        main,
        `https://images.example.test/${number}/ingredients.jpg`,
        `https://images.example.test/${number}/nutrition.jpg`,
      ]),
      identityKey: `legacy-identity-${number}`,
      identityStatus: "legacy_unverified",
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:05:00.000Z",
    };
  });
  const offers = donors.map((donor, index) => {
    const number = index + 1;
    return {
      id: `offer-${number}`,
      donorProductId: donor.id,
      retailer: "walmart",
      retailerProductId: `item-${number}`,
      via: "direct",
      price: 2.99,
      packSizeSeen: 1,
      pricePerUnit: 2.99,
      currency: "USD",
      zip: "33765",
      localityEvidence: "zip_scoped",
      inStock: true,
      productUrl: `https://www.walmart.com/ip/item-${number}/${number}`,
      isFirstParty: true,
      sourceApi: "oxylabs",
      fetchedAt: "2026-07-01T10:00:00.000Z",
    };
  });
  const snapshot: ProductTruthLegacyBridgeSnapshot = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: CAPTURED_AT,
    targetFingerprint: TARGET_FINGERPRINT,
    manifest: {
      schemaVersion: "phase1-authoritative-scope-manifest/v3",
      sha256: MANIFEST_SHA256,
      asOf: "2026-07-26T09:30:00.000Z",
      listingCount: listings.length,
    },
    listings,
    components,
    donors,
    offers,
    canonicalDonorBindings: [],
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
  };
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
  const snapshotSha256 = productTruthLegacyBridgeBytesSha256(snapshotJson);
  const bridgePlan = compileProductTruthLegacyBridgePlan({
    snapshot,
    snapshotJson,
    snapshotSha256,
    generatedAt: CAPTURED_AT,
  });
  assert.equal(bridgePlan.counts.contentOnlyCanonicalizationCandidates, 5);
  const bridgePlanJson = renderProductTruthLegacyBridgePlan(bridgePlan);
  return {
    snapshot,
    snapshotJson,
    snapshotSha256,
    bridgePlan,
    bridgePlanJson,
    bridgePlanSha256: productTruthLegacyBridgeBytesSha256(bridgePlanJson),
    listingKeys: listings.map((listing) => listing.listingKey),
  };
}

function rebuildFixture(
  snapshot: ProductTruthLegacyBridgeSnapshot,
  expected: {
    contentOnly?: number;
    identityOnly?: number;
  } = {},
): ReturnType<typeof sourceFixture> {
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
  const snapshotSha256 = productTruthLegacyBridgeBytesSha256(snapshotJson);
  const bridgePlan = compileProductTruthLegacyBridgePlan({
    snapshot,
    snapshotJson,
    snapshotSha256,
    generatedAt: CAPTURED_AT,
  });
  assert.equal(
    bridgePlan.counts.contentOnlyCanonicalizationCandidates,
    expected.contentOnly ?? 5,
  );
  assert.equal(
    bridgePlan.counts.identityOnlyCanonicalizationCandidates,
    expected.identityOnly ?? 0,
  );
  const bridgePlanJson = renderProductTruthLegacyBridgePlan(bridgePlan);
  return {
    snapshot,
    snapshotJson,
    snapshotSha256,
    bridgePlan,
    bridgePlanJson,
    bridgePlanSha256: productTruthLegacyBridgeBytesSha256(bridgePlanJson),
    listingKeys: snapshot.listings.map((listing) => listing.listingKey),
  };
}

function identityOnlyFixture(): ReturnType<typeof sourceFixture> {
  const snapshot = structuredClone(sourceFixture().snapshot);
  for (const donor of snapshot.donors) {
    donor.description = null;
    donor.upc = null;
    donor.mainImageUrl = null;
    donor.imageUrls = null;
  }
  return rebuildFixture(snapshot, { contentOnly: 0, identityOnly: 5 });
}

function liveBarcodeFixture(): ReturnType<typeof sourceFixture> {
  const snapshot = structuredClone(sourceFixture().snapshot);
  const listing = snapshot.listings[0];
  const component = snapshot.components[0];
  const donor = snapshot.donors[0];
  const offer = snapshot.offers[0];
  assert.ok(listing);
  assert.ok(component);
  assert.ok(donor);
  assert.ok(offer);

  listing.productIdentityJson = JSON.stringify({
    brand: "Pepperidge Farm",
    product_line: "Hot Dog Buns",
    flavor: "White",
    size: "8 count",
    container_type: "Bag",
    units_in_listing: 2,
    is_bundle: false,
    components: [],
  });
  component.product = "Hot Dog Buns";
  component.flavor = "White";
  component.size = "8 count";
  component.qty = 2;
  component.matchedTitle =
    "Pepperidge Farm Bakery Classics Top Sliced White Hot Dog Buns - 14oz/8ct";
  component.retailer = "target";
  donor.brand = "Pepperidge Farm";
  donor.productLine = "Hot Dog Buns";
  donor.flavor = "White";
  donor.containerType = "Bag";
  donor.size = "8 count";
  donor.category = "Bakery";
  donor.upc = "014100070931";
  donor.title =
    "Pepperidge Farm Bakery Classics Top Sliced White Hot Dog Buns - 14oz/8ct";
  donor.description = null;
  donor.attributes = null;
  donor.nutritionFacts = null;
  donor.ingredients = null;
  offer.retailer = "target";
  offer.retailerProductId = "17189284";
  offer.productUrl =
    "https://www.target.com/p/pepperidge-farm-bakery-classics-top-sliced-white-hot-dog-buns-14oz-8ct/-/A-17189284";
  offer.sourceApi = "unwrangle";

  snapshot.componentBarcodeEvidence = [{
    schemaVersion: "product-truth-live-image-barcode-evidence/1.0.0",
    evidenceArtifactSha256: "1".repeat(64),
    listingKey: listing.listingKey,
    componentIndex: 0,
    capturedAt: "2026-07-26T09:30:00.000Z",
    sourceImageFile: "barcode-source.jpeg",
    image: {
      imageId: "image-1",
      slot: "gallery-2",
      sourceAssetSha256: "2".repeat(64),
      modelAssetSha256: "3".repeat(64),
    },
    barcode: {
      decoder: "APPLE_VISION_VNDETECTBARCODESREQUEST",
      symbology: "VNBarcodeSymbologyEAN13",
      payload: "0014100070931",
      normalizedGtin14: "00014100070931",
      confidence: 0.99,
    },
    visualObservation: {
      brandText: "PEPPERIDGE FARM",
      productText: "TOP SLICED SOFT WHITE HOT DOG BUNS",
      readableIdentity: "clear",
      multipleDistinctProducts: "no",
      gridCellKind: "single_sellable_package",
      externalPackageCount: 1,
      identityModifiers: ["top sliced"],
    },
    buyerPdp: {
      title: "Pepperidge Farm White Hot Dog Buns, Top Sliced, (Pack of 2)",
      brand: "Pepperidge Farm",
      productType: "Hot Dog Buns",
      productLine: "Bakery Classics",
      flavor: "White",
      count: 8,
      multipackQuantity: 2,
      containerType: "Bag",
      netContent: "14 Ounces",
      foodCondition: "Shelf-Stable",
    },
    retailerContent: {
      retailer: "target",
      retailerProductId: "17189284",
      productUrl: offer.productUrl,
      finalUrl: offer.productUrl,
      httpStatus: 200,
      fetchedAt: "2026-07-26T09:30:00.000Z",
      htmlFile: "retailer-content.html",
      htmlSha256: "c".repeat(64),
      normalizedGtin14: "00014100070931",
      title: donor.title,
      description: "Exact Target description.",
      bullets: ["8 BUNS: 8-count bag"],
      attributes: ["State of Readiness: Ready to Eat"],
      nutritionFacts: { servings_per_container: "8" },
      ingredients: "Wheat flour, water.",
      allergens: "Contains: Wheat, Milk, Sesame Seeds.",
    },
    sourceHashes: {
      intakeIndexFileSha256: "4".repeat(64),
      intakeIndexBodySha256: "5".repeat(64),
      buyerPdpFileSha256: "6".repeat(64),
      observerPlanFileSha256: "7".repeat(64),
      observerPlanBodySha256: "8".repeat(64),
      observationsFileSha256: "9".repeat(64),
      executionIndexFileSha256: "a".repeat(64),
      executionIndexBodySha256: "b".repeat(64),
    },
    safety: {
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerReads: 1,
      databaseWrites: 0,
      walmartWrites: 0,
    },
  }];
  return rebuildFixture(snapshot);
}

function directTargetContentFixture(): ReturnType<typeof sourceFixture> {
  const snapshot = structuredClone(sourceFixture().snapshot);
  const donor = snapshot.donors[0];
  const offer = snapshot.offers[0];
  assert.ok(donor);
  assert.ok(offer);
  donor.attributes = JSON.stringify([
    { label: "State of Readiness", value: "Ready to Eat" },
  ]);
  donor.nutritionFacts = JSON.stringify({ calories: 120 });
  donor.ingredients = "Corn, oil.";
  offer.retailer = "target";
  offer.retailerProductId = "12973001";
  offer.productUrl =
    "https://www.target.com/p/acme-brand-1-crunch-chips/-/A-12973001";
  offer.sourceApi = "unwrangle";
  const evidence: ProductTruthDirectTargetContentEvidence = {
    schemaVersion: "product-truth-direct-target-content-evidence/1.0.0",
    donorProductId: donor.id,
    offerId: offer.id,
    capturedAt: "2026-07-26T09:30:00.000Z",
    retailerContent: {
      retailer: "target",
      retailerProductId: offer.retailerProductId,
      productUrl: offer.productUrl,
      finalUrl: offer.productUrl,
      httpStatus: 200,
      fetchedAt: "2026-07-26T09:30:00.000Z",
      htmlFile: "retailer-content.html",
      htmlSha256: "d".repeat(64),
      normalizedGtin14: "00036000291452",
      title: donor.title!,
      description: "Exact direct Target description.",
      bullets: ["One exact bag"],
      attributes: ["State of Readiness: Ready to Eat"],
      nutritionFacts: { calories: 120 },
      ingredients: "Corn, oil.",
      allergens: "Contains: Milk.",
    },
    safety: {
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerReads: 1,
      databaseWrites: 0,
      walmartWrites: 0,
    },
  };
  snapshot.directTargetContentEvidence = [{
    ...evidence,
    evidenceArtifactSha256: productTruthLegacyBridgeBytesSha256(
      renderProductTruthOperationalJson(evidence),
    ),
  }];
  return rebuildFixture(snapshot);
}

function sharedGraphFixture(): ReturnType<typeof sourceFixture> {
  const snapshot = structuredClone(sourceFixture().snapshot);
  const sharedDonor = snapshot.donors[0];
  const sharedOffer = snapshot.offers[0];
  assert.ok(sharedDonor);
  assert.ok(sharedOffer);
  for (let index = 0; index < 3; index += 1) {
    const listing = snapshot.listings[index];
    const component = snapshot.components[index];
    assert.ok(listing);
    assert.ok(component);
    listing.productIdentityJson = JSON.stringify({
      brand: sharedDonor.brand,
      product_line: sharedDonor.productLine,
      flavor: sharedDonor.flavor,
      size: sharedDonor.size,
      container_type: sharedDonor.containerType,
      units_in_listing: index + 1,
      is_bundle: false,
      components: [],
    });
    component.donorProductId = sharedDonor.id;
    component.product = sharedDonor.productLine;
    component.flavor = sharedDonor.flavor;
    component.size = sharedDonor.size;
    component.matchedTitle = sharedDonor.title;
    component.retailer = sharedOffer.retailer;
  }
  snapshot.donors = snapshot.donors.filter(
    (donor) => donor.id !== "donor-2" && donor.id !== "donor-3",
  );
  snapshot.offers = snapshot.offers.filter(
    (offer) => offer.donorProductId !== "donor-2" && offer.donorProductId !== "donor-3",
  );
  return rebuildFixture(snapshot);
}

function donorVariantCollisionFixture(): ReturnType<typeof sourceFixture> {
  const fixture = sharedGraphFixture();
  const bridgePlan = structuredClone(fixture.bridgePlan);
  const componentPlan = bridgePlan.scopes[1]?.components[0];
  assert.ok(componentPlan?.targetIdentity);
  const targetIdentity = {
    ...componentPlan.targetIdentity,
    flavor: null,
  };
  const variant = buildCanonicalProductVariantKey(targetIdentity);
  componentPlan.targetIdentity = targetIdentity;
  componentPlan.targetVariant = {
    canonicalVariantId: variant.canonicalVariantId,
    variantKey: variant.variantKey,
    identityHash: variant.identityHash,
    keyVersion: variant.keyVersion,
    identityJson: variant.identityJson,
  };
  const bridgePlanJson = renderProductTruthLegacyBridgePlan(bridgePlan);
  return {
    ...fixture,
    bridgePlan,
    bridgePlanJson,
    bridgePlanSha256: productTruthLegacyBridgeBytesSha256(bridgePlanJson),
  };
}

function applyPlan(fixture = sourceFixture()) {
  const plan = planProductTruthLegacyBridgeApply({
    ...fixture,
    createdAt: PLAN_CREATED_AT,
    expiresAt: PLAN_EXPIRES_AT,
  });
  const planJson = renderProductTruthLegacyBridgeApplyPlan(plan);
  const planSha256 = productTruthLegacyBridgeBytesSha256(planJson);
  return { fixture, plan, planJson, planSha256 };
}

function approval(input: ReturnType<typeof applyPlan>) {
  const value: ProductTruthLegacyBridgeApproval = {
    schemaVersion: "product-truth-legacy-bridge-approval/2.0.0",
    decision: "APPROVE_NO_PAID_LEGACY_BRIDGE_WAVE",
    approvedBy: "owner",
    approvalId: input.plan.expectedApprovalId,
    planId: input.plan.planId,
    planSha256: input.planSha256,
    databaseTargetFingerprint: input.plan.databaseTargetFingerprint,
    sourceSnapshotSha256: input.plan.source.snapshotSha256,
    bridgePlanSha256: input.plan.source.bridgePlanSha256,
    targetsSha256: input.plan.targetsSha256,
    listingKeys: input.plan.targets.map((target) => target.listingKey),
    maximumDatabaseRows: input.plan.databaseWrites.maximumRows,
    allowCanonicalMaterialization: true,
    allowProviderCalls: false,
    allowPaidCalls: false,
    allowMarketplaceMutations: false,
    allowProcurementMutations: false,
    allowConsumerCutover: false,
    issuedAt: PLAN_CREATED_AT,
    expiresAt: PLAN_EXPIRES_AT,
  };
  const json = renderProductTruthLegacyBridgeApproval(value);
  return {
    value,
    json,
    sha256: productTruthLegacyBridgeBytesSha256(json),
  };
}

function standingPolicy(
  overrides: Partial<ProductTruthLegacyBridgeStandingPolicy> = {},
) {
  const value: ProductTruthLegacyBridgeStandingPolicy = {
    schemaVersion: "product-truth-legacy-bridge-standing-policy/1.0.0",
    policyId: "fixture-standing-policy",
    approvedBy: "owner",
    issuedAt: "2026-07-26T11:00:00.000Z",
    expiresAt: null,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    manifestSha256: MANIFEST_SHA256,
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
    ownerStatement: "Fixture owner authorizes bounded no-paid collision-free waves.",
    ...overrides,
  };
  const json = renderProductTruthLegacyBridgeStandingPolicy(value);
  return {
    value,
    json,
    sha256: productTruthLegacyBridgeBytesSha256(json),
  };
}

async function createSchema(db: Client): Promise<void> {
  await db.execute("PRAGMA foreign_keys=ON");
  await db.executeMultiple(`
    CREATE TABLE EnrichmentJob (
      id TEXT PRIMARY KEY,
      targetType TEXT NOT NULL DEFAULT 'brand',
      target TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL DEFAULT 'manual',
      priority INTEGER NOT NULL DEFAULT 0,
      requestedBy TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      queuedAt DATETIME,
      startedAt DATETIME,
      finishedAt DATETIME,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE DonorProduct (
      id TEXT PRIMARY KEY,
      brand TEXT, productLine TEXT, flavor TEXT, containerType TEXT, size TEXT,
      unitMeasure TEXT, unitAmount REAL, category TEXT, upc TEXT, gtin TEXT,
      title TEXT, description TEXT, bullets TEXT, attributes TEXT,
      nutritionFacts TEXT, ingredients TEXT, mainImageUrl TEXT, imageUrls TEXT,
      bestPrice REAL, bestRetailer TEXT, pricePerMeasure REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      identityKey TEXT NOT NULL UNIQUE,
      confidence REAL, needsReview INTEGER NOT NULL DEFAULT 0,
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
  `);
  for (const migrationId of MIGRATION_IDS) {
    const migration = new URL(
      `../../../../prisma/migrations/${migrationId}/migration.sql`,
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migration, "utf8"));
  }
}

async function seededDatabase(
  t: TestContext,
  fixture = sourceFixture(),
): Promise<Client> {
  const directory = await mkdtemp(join(tmpdir(), "legacy-bridge-apply-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = createClient({
    url: `file:${join(directory, "fixture.sqlite")}`,
    concurrency: 1,
  });
  await createSchema(db);
  for (const listing of fixture.snapshot.listings) {
    await db.execute({
      sql: `INSERT INTO ProductTruthListingScope (
        listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
        manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
        sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        listing.listingKey, "product-truth-listing-key/1.0.0",
        listing.channel, listing.storeIndex, listing.sku,
        "AUTHORITATIVE_PHASE1_MANIFEST",
        "phase1-authoritative-scope-manifest/v3", MANIFEST_SHA256,
        "2026-07-26T09:30:00.000Z", "owner-fixture", "report-fixture",
        "c".repeat(64), "2026-07-26T09:00:00.000Z",
        "2026-07-26T09:30:00.000Z",
      ],
    });
    await db.execute({
      sql: `INSERT INTO SkuShippingData (
        id,sku,marketplace,productIdentity,upc,upcSource,unitsInListing,
        baseUnitDesc,source,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        `shipping-${listing.sku}`, listing.sku, "Walmart",
        listing.productIdentityJson, listing.listingUpc, listing.listingUpcSource,
        1, "bag", "fixture", "2026-07-25T09:00:00.000Z",
        listing.productIdentityUpdatedAt,
      ],
    });
    await db.execute({
      sql: `INSERT INTO WalmartListingQualityItem (
        id,storeIndex,sku,gmv30d,orders30d,units30d,scoredAt
      ) VALUES (?,?,?,?,?,?,?)`,
      args: [
        `quality-${listing.sku}`, listing.storeIndex, listing.sku,
        listing.priorityGmv30d, listing.priorityOrders30d,
        listing.priorityUnits30d, listing.priorityObservedAt,
      ],
    });
  }
  for (const donor of fixture.snapshot.donors) {
    await db.execute({
      sql: `INSERT INTO DonorProduct (
        id,brand,productLine,flavor,containerType,size,category,upc,gtin,
        title,description,bullets,attributes,nutritionFacts,ingredients,
        mainImageUrl,imageUrls,identityKey,identityStatus,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        donor.id, donor.brand, donor.productLine, donor.flavor,
        donor.containerType, donor.size, donor.category, donor.upc, donor.gtin,
        donor.title, donor.description, donor.bullets, donor.attributes,
        donor.nutritionFacts, donor.ingredients, donor.mainImageUrl,
        donor.imageUrls, donor.identityKey, donor.identityStatus,
        donor.createdAt, donor.updatedAt,
      ],
    });
  }
  for (const offer of fixture.snapshot.offers) {
    await db.execute({
      sql: `INSERT INTO DonorOffer (
        id,donorProductId,retailer,retailerProductId,via,price,packSizeSeen,
        pricePerUnit,currency,zip,localityEvidence,inStock,productUrl,
        isFirstParty,sourceApi,fetchedAt,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        offer.id, offer.donorProductId, offer.retailer, offer.retailerProductId,
        offer.via, offer.price, offer.packSizeSeen, offer.pricePerUnit,
        offer.currency, offer.zip, offer.localityEvidence, offer.inStock,
        offer.productUrl, offer.isFirstParty, offer.sourceApi, offer.fetchedAt,
        offer.fetchedAt, offer.fetchedAt,
      ],
    });
  }
  // The fixture represents rows that existed before the evidence migration.
  // Temporarily remove only the two legacy-write guards while recreating that
  // pre-migration state, then restore their exact migration definitions.
  await db.execute("DROP TRIGGER SkuComponent_evidence_contract_insert");
  await db.execute("DROP TRIGGER SkuComponent_evidence_contract_update");
  for (const component of fixture.snapshot.components) {
    await db.execute({
      sql: `INSERT INTO SkuComponent (
        id,sku,channel,idx,product,flavor,size,qty,perUnitCost,lineCost,
        currency,retailer,matchedTitle,costMethod,donorProductId,isBundleComponent,
        createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        component.id, component.sku, "walmart", component.idx,
        component.product, component.flavor, component.size, component.qty,
        component.perUnitCost, component.lineCost, "USD", component.retailer,
        component.matchedTitle, component.costMethod, component.donorProductId, 0,
        "2026-07-01T10:00:00.000Z", "2026-07-01T10:00:00.000Z",
      ],
    });
  }
  const migration = new URL(
    "../../../../prisma/migrations/20260718234500_product_truth_evidence_provenance/migration.sql",
    import.meta.url,
  );
  const migrationSql = await readFile(migration, "utf8");
  const triggerSql = migrationSql.slice(
    migrationSql.indexOf('CREATE TRIGGER "SkuComponent_evidence_contract_insert"'),
    migrationSql.indexOf('CREATE TRIGGER "DonorOffer_delete_guard"'),
  );
  await db.executeMultiple(triggerSql);
  return db;
}

async function executeApproved(
  db: Client,
  input: ReturnType<typeof applyPlan>,
  confirmation = expectedProductTruthLegacyBridgeConfirmation(input.plan, input.planSha256),
) {
  const permit = approval(input);
  return applyProductTruthLegacyBridgeWave({
    db,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    plan: input.plan,
    planJson: input.planJson,
    planSha256: input.planSha256,
    approval: permit.value,
    approvalJson: permit.json,
    approvalSha256: permit.sha256,
    confirmation,
    startedAt: APPLY_AT,
    completedAt: APPLY_AT,
  });
}

test("legacy bridge wave plan is byte-deterministic for explicitly selected catalog graphs", () => {
  const first = applyPlan();
  const second = applyPlan(first.fixture);
  assert.equal(first.planJson, second.planJson);
  assert.equal(first.planSha256, second.planSha256);
  assert.equal(first.plan.targets.length, 5);
  assert.equal(first.plan.databaseWrites.maximumRows, 45);
  assert.equal(first.plan.claims.createsAdditionalCatalog, false);
  assert.equal(first.plan.claims.paidCalls, 0);
  assert.equal(first.plan.claims.marketplaceMutations, 0);
});

test("graph-aware wave materializes one shared donor/content graph for several listings", async (t) => {
  const input = applyPlan(sharedGraphFixture());
  assert.equal(input.plan.targets.length, 5);
  assert.deepEqual(input.plan.databaseWrites, {
    maximumRows: 37,
    canonicalProductVariants: 3,
    donorVariantDecisions: 3,
    donorIdentityTransitions: 3,
    productContentObservations: 3,
    productTruthListingRecipes: 5,
    productTruthListingRecipeComponents: 5,
    skuCostListingScopeLinks: 5,
    skuComponentEvidence: 5,
    skuCosts: 5,
  });
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  const first = await executeApproved(db, input);
  assert.equal(first.status, "APPLIED");
  assert.equal(first.counts.insertedRows, 37);
  assert.equal(first.counts.donorIdentityTransitions, 3);
  assert.equal(first.verification.bundleFactoryReady, 5);
  assert.equal(first.verification.listingImprovementReady, 5);
  assert.equal(first.verification.unitEconomicsUnsourceable, 5);
  assert.equal(first.verification.procurementReady, 0);
  const counts = await Promise.all([
    db.execute("SELECT COUNT(*) AS count FROM CanonicalProductVariant"),
    db.execute("SELECT COUNT(*) AS count FROM DonorProductVariantDecision"),
    db.execute("SELECT COUNT(*) AS count FROM ProductContentObservation"),
    db.execute("SELECT COUNT(*) AS count FROM ProductTruthListingRecipe"),
    db.execute("SELECT COUNT(*) AS count FROM ProductTruthListingRecipeComponent"),
    db.execute("SELECT COUNT(*) AS count FROM SkuCost"),
  ]);
  assert.deepEqual(
    counts.map((result) => Number(result.rows[0]?.count)),
    [3, 3, 3, 5, 5, 5],
  );
  const second = await executeApproved(db, input);
  assert.equal(second.status, "ALREADY_APPLIED");
  assert.equal(second.counts.exactExistingRows, 37);
});

test("exact identity-only legacy evidence materializes partial content, recipe, and typed UNSOURCEABLE COGS", async (t) => {
  const input = applyPlan(identityOnlyFixture());
  assert.equal(input.plan.targets.length, 5);
  assert.equal(input.plan.databaseWrites.maximumRows, 45);
  for (const target of input.plan.targets) {
    const content = JSON.parse(target.content.contentJson) as {
      description: unknown;
      normalizedGtin14: unknown;
      mainImageUrl: unknown;
      imageUrls: unknown[];
    };
    assert.equal(content.description, null);
    assert.equal(content.normalizedGtin14, null);
    assert.equal(content.mainImageUrl, null);
    assert.deepEqual(content.imageUrls, []);
  }

  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  const result = await executeApproved(db, input);
  assert.equal(result.status, "APPLIED");
  assert.equal(result.counts.insertedRows, 45);
  assert.equal(result.verification.bundleFactoryReady, 0);
  assert.equal(result.verification.listingImprovementReady, 0);
  assert.equal(result.verification.unitEconomicsUnsourceable, 5);
  for (const target of input.plan.targets) {
    const snapshot = await readProductTruthSnapshot(db, {
      sku: target.sku,
      channel: target.channel,
      storeIndex: target.storeIndex,
      expectedManifestSha256: MANIFEST_SHA256,
      asOf: APPLY_AT,
      maxPriceAgeMs: 24 * 60 * 60 * 1_000,
    });
    assert.equal(snapshot.views.bundleFactory.ready, false);
    assert.equal(snapshot.views.unitEconomics.status, "UNSOURCEABLE");
    assert.equal(
      snapshot.views.listingImprovement.ready,
      false,
      JSON.stringify(snapshot.views.listingImprovement),
    );
    assert.ok(
      snapshot.views.listingImprovement.blockers.some((blocker) =>
        blocker.includes("CONTENT_DESCRIPTION_MISSING")
      ),
    );
    assert.ok(
      snapshot.views.listingImprovement.blockers.some((blocker) =>
        blocker.includes("CONTENT_GALLERY_MISSING")
      ),
    );
  }
});

test("live barcode retailer content is hash-bound and materialized into canonical content", async (t) => {
  const input = applyPlan(liveBarcodeFixture());
  const target = input.plan.targets.find((row) => row.listingKey === "walmart:1:SKU-1");
  assert.ok(target);
  assert.equal(target.sourceBinding.componentBarcodeEvidenceSha256, "1".repeat(64));
  assert.equal(target.content.sourceApi, "target_direct_html");
  assert.equal(
    target.content.sourceUrl,
    "https://www.target.com/p/pepperidge-farm-bakery-classics-top-sliced-white-hot-dog-buns-14oz-8ct/-/A-17189284",
  );
  const plannedContent = JSON.parse(target.content.contentJson) as {
    description: string;
    nutritionFacts: Record<string, unknown>;
    ingredients: string;
    allergens: string;
    storage: string;
    sourceBinding: {
      exactContentEvidenceArtifactSha256: string;
      exactContentRawHtmlSha256: string;
      originalSourceApi: string;
    };
  };
  assert.equal(plannedContent.description, "Exact Target description.");
  assert.deepEqual(plannedContent.nutritionFacts, { servings_per_container: "8" });
  assert.equal(plannedContent.ingredients, "Wheat flour, water.");
  assert.equal(plannedContent.allergens, "Contains: Wheat, Milk, Sesame Seeds.");
  assert.equal(plannedContent.storage, "Shelf-Stable");
  assert.equal(plannedContent.sourceBinding.originalSourceApi, "target_direct_html");
  assert.equal(
    plannedContent.sourceBinding.exactContentEvidenceArtifactSha256,
    "1".repeat(64),
  );
  assert.equal(plannedContent.sourceBinding.exactContentRawHtmlSha256, "c".repeat(64));

  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  const result = await executeApproved(db, input);
  assert.equal(result.status, "APPLIED");
  const persisted = (await db.execute({
    sql: "SELECT sourceApi,contentJson FROM ProductContentObservation WHERE id=?",
    args: [target.content.id],
  })).rows[0];
  assert.equal(persisted?.sourceApi, "target_direct_html");
  assert.equal(String(persisted?.contentJson), target.content.contentJson);
});

test("direct Target content is separately hash-bound and materialized", async (t) => {
  const input = applyPlan(directTargetContentFixture());
  const target = input.plan.targets.find((row) => row.listingKey === "walmart:1:SKU-1");
  assert.ok(target);
  const evidenceSha256 =
    input.fixture.snapshot.directTargetContentEvidence[0]?.evidenceArtifactSha256;
  assert.ok(evidenceSha256);
  assert.equal(target.sourceBinding.componentBarcodeEvidenceSha256, null);
  assert.equal(
    target.sourceBinding.directTargetContentEvidenceSha256,
    evidenceSha256,
  );
  assert.equal(target.content.sourceApi, "target_direct_html");
  const plannedContent = JSON.parse(target.content.contentJson) as {
    description: string;
    allergens: string;
    storage: string;
    sourceBinding: {
      exactContentEvidenceArtifactSha256: string;
      exactContentRawHtmlSha256: string;
      rowHashes: {
        directTargetContentEvidenceSha256: string;
      };
    };
  };
  assert.equal(plannedContent.description, "Exact direct Target description.");
  assert.equal(plannedContent.allergens, "Contains: Milk.");
  assert.equal(plannedContent.storage, "Ready to Eat");
  assert.equal(
    plannedContent.sourceBinding.exactContentEvidenceArtifactSha256,
    evidenceSha256,
  );
  assert.equal(plannedContent.sourceBinding.exactContentRawHtmlSha256, "d".repeat(64));
  assert.equal(
    plannedContent.sourceBinding.rowHashes.directTargetContentEvidenceSha256,
    evidenceSha256,
  );

  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  const result = await executeApproved(db, input);
  assert.equal(result.status, "APPLIED");
  const persisted = (await db.execute({
    sql: "SELECT sourceApi,contentJson FROM ProductContentObservation WHERE id=?",
    args: [target.content.id],
  })).rows[0];
  assert.equal(persisted?.sourceApi, "target_direct_html");
  assert.equal(String(persisted?.contentJson), target.content.contentJson);
});

test("standing no-paid policy authorizes a fresh bounded READY_TO_APPLY wave", async (t) => {
  const input = applyPlan();
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  const preflight = await preflightProductTruthLegacyBridgeWave({
    db,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    plan: input.plan,
    planJson: input.planJson,
    planSha256: input.planSha256,
    checkedAt: APPLY_AT,
  });
  const preflightJson = renderProductTruthLegacyBridgePreflightReport(preflight);
  const policy = standingPolicy();
  const report = await applyProductTruthLegacyBridgeWave({
    db,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    plan: input.plan,
    planJson: input.planJson,
    planSha256: input.planSha256,
    standingPolicy: policy.value,
    standingPolicyJson: policy.json,
    standingPolicySha256: policy.sha256,
    standingPreflightReport: preflight,
    standingPreflightReportJson: preflightJson,
    standingPreflightReportSha256:
      productTruthLegacyBridgeBytesSha256(preflightJson),
    startedAt: APPLY_AT,
    completedAt: APPLY_AT,
  });
  assert.equal(report.status, "APPLIED");
  assert.equal(report.counts.insertedRows, 45);
  assert.deepEqual(report.authorization, {
    mode: "STANDING_NO_PAID_POLICY",
    standingPolicyId: policy.value.policyId,
    standingPolicySha256: policy.sha256,
    preflightReportSha256: productTruthLegacyBridgeBytesSha256(preflightJson),
  });
});

test("inverted apply timestamps fail before any canonical write", async (t) => {
  const input = applyPlan();
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  const permit = approval(input);
  await assert.rejects(
    applyProductTruthLegacyBridgeWave({
      db,
      databaseTargetFingerprint: TARGET_FINGERPRINT,
      plan: input.plan,
      planJson: input.planJson,
      planSha256: input.planSha256,
      approval: permit.value,
      approvalJson: permit.json,
      approvalSha256: permit.sha256,
      confirmation: expectedProductTruthLegacyBridgeConfirmation(
        input.plan,
        input.planSha256,
      ),
      startedAt: APPLY_AT,
      completedAt: "2026-07-26T12:59:59.999Z",
    }),
    /LEGACY_BRIDGE_TIMESTAMP_INVALID/,
  );
  const count = await db.execute("SELECT COUNT(*) AS count FROM SkuCost");
  assert.equal(Number(count.rows[0]?.count), 0);
});

test("standing policy rejects an over-ceiling or stale wave before writes", async (t) => {
  const input = applyPlan();
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  const preflight = await preflightProductTruthLegacyBridgeWave({
    db,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    plan: input.plan,
    planJson: input.planJson,
    planSha256: input.planSha256,
    checkedAt: APPLY_AT,
  });
  const preflightJson = renderProductTruthLegacyBridgePreflightReport(preflight);
  const tooSmall = standingPolicy({ maximumDatabaseRowsPerWave: 34 });
  await assert.rejects(
    applyProductTruthLegacyBridgeWave({
      db,
      databaseTargetFingerprint: TARGET_FINGERPRINT,
      plan: input.plan,
      planJson: input.planJson,
      planSha256: input.planSha256,
      standingPolicy: tooSmall.value,
      standingPolicyJson: tooSmall.json,
      standingPolicySha256: tooSmall.sha256,
      standingPreflightReport: preflight,
      standingPreflightReportJson: preflightJson,
      standingPreflightReportSha256:
        productTruthLegacyBridgeBytesSha256(preflightJson),
      startedAt: APPLY_AT,
      completedAt: APPLY_AT,
    }),
    /LEGACY_BRIDGE_STANDING_POLICY_INVALID/,
  );
  const stalePolicy = standingPolicy({ maximumPreflightAgeMs: 1 });
  await assert.rejects(
    applyProductTruthLegacyBridgeWave({
      db,
      databaseTargetFingerprint: TARGET_FINGERPRINT,
      plan: input.plan,
      planJson: input.planJson,
      planSha256: input.planSha256,
      standingPolicy: stalePolicy.value,
      standingPolicyJson: stalePolicy.json,
      standingPolicySha256: stalePolicy.sha256,
      standingPreflightReport: preflight,
      standingPreflightReportJson: preflightJson,
      standingPreflightReportSha256:
        productTruthLegacyBridgeBytesSha256(preflightJson),
      startedAt: "2026-07-26T13:00:00.002Z",
      completedAt: "2026-07-26T13:00:00.002Z",
    }),
    /LEGACY_BRIDGE_STANDING_PREFLIGHT_STALE/,
  );
  const count = await db.execute("SELECT COUNT(*) AS count FROM SkuCost");
  assert.equal(Number(count.rows[0]?.count), 0);
});

test("one donor mapping to two canonical variants fails before a wave plan exists", () => {
  const fixture = donorVariantCollisionFixture();
  assert.throws(
    () => applyPlan(fixture),
    /LEGACY_BRIDGE_DONOR_VARIANT_COLLISION/,
  );
});

test("approved wave atomically materializes exact content with an honest UNSOURCEABLE cost and is idempotent", async (t) => {
  const input = applyPlan();
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  const before = await preflightProductTruthLegacyBridgeWave({
    db,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    plan: input.plan,
    planJson: input.planJson,
    planSha256: input.planSha256,
    checkedAt: APPLY_AT,
  });
  assert.equal(before.status, "READY_TO_APPLY");
  assert.equal(before.counts.absentRows, 45);
  const first = await executeApproved(db, input);
  assert.equal(first.status, "APPLIED");
  assert.equal(first.counts.insertedRows, 45);
  const second = await executeApproved(db, input);
  assert.equal(second.status, "ALREADY_APPLIED");
  assert.equal(second.counts.exactExistingRows, 45);
  const after = await preflightProductTruthLegacyBridgeWave({
    db,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    plan: input.plan,
    planJson: input.planJson,
    planSha256: input.planSha256,
    checkedAt: APPLY_AT,
  });
  assert.equal(after.status, "ALREADY_APPLIED");
  assert.equal(after.counts.exactExistingRows, 45);

  for (const target of input.plan.targets) {
    const contentRow = (await db.execute({
      sql: `SELECT sourceApi,meteredReceiptId,contentJson
            FROM ProductContentObservation WHERE id=?`,
      args: [target.content.id],
    })).rows[0];
    assert.equal(
      contentRow.sourceApi,
      PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE,
    );
    assert.equal(contentRow.meteredReceiptId, null);
    const contentJson = JSON.parse(String(contentRow.contentJson)) as {
      sourceBinding: {
        materializationRoute: string;
        originalSourceApi: string;
      };
    };
    assert.equal(
      contentJson.sourceBinding.materializationRoute,
      PRODUCT_TRUTH_LEGACY_BRIDGE_MATERIALIZATION_SOURCE,
    );
    assert.equal(contentJson.sourceBinding.originalSourceApi, "oxylabs");

    const snapshot = await readProductTruthSnapshot(db, {
      sku: target.sku,
      channel: target.channel,
      storeIndex: target.storeIndex,
      expectedManifestSha256: MANIFEST_SHA256,
      asOf: APPLY_AT,
      maxPriceAgeMs: 24 * 60 * 60 * 1_000,
    });
    assert.equal(snapshot.views.bundleFactory.ready, true);
    assert.equal(snapshot.views.listingImprovement.ready, true);
    assert.equal(snapshot.views.unitEconomics.status, "UNSOURCEABLE");
    assert.equal(snapshot.views.procurement.ready, false);
    assert.equal(snapshot.views.bundleFactory.components[0].content?.provenance.sourceUrl,
      input.plan.targets.find((item) => item.listingKey === target.listingKey)?.content.sourceUrl);
  }
});

test("approval or source drift fails before any canonical write", async (t) => {
  const input = applyPlan();
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  await assert.rejects(
    executeApproved(db, input, "WRONG_CONFIRMATION"),
    /LEGACY_BRIDGE_CONFIRMATION_MISMATCH/,
  );
  assert.equal(
    Number((await db.execute("SELECT COUNT(*) AS count FROM CanonicalProductVariant")).rows[0].count),
    0,
  );
  await db.execute({
    sql: "UPDATE DonorProduct SET description=? WHERE id=?",
    args: ["drifted", input.plan.targets[0].donorProductId],
  });
  await assert.rejects(
    executeApproved(db, input),
    /LEGACY_BRIDGE_SOURCE_DRIFT/,
  );
  assert.equal(
    Number((await db.execute("SELECT COUNT(*) AS count FROM CanonicalProductVariant")).rows[0].count),
    0,
  );
});

test("an injected database failure rolls the entire wave back", async (t) => {
  const input = applyPlan();
  const db = await seededDatabase(t, input.fixture);
  t.after(() => db.close());
  await db.execute(`
    CREATE TRIGGER test_legacy_bridge_abort
    BEFORE INSERT ON SkuCost
    WHEN NEW.sku='SKU-3'
    BEGIN
      SELECT RAISE(ABORT, 'TEST_INJECTED_FAILURE');
    END
  `);
  await assert.rejects(
    executeApproved(db, input),
    /LEGACY_BRIDGE_TRANSACTION_FAILED.*TEST_INJECTED_FAILURE/,
  );
  for (const table of [
    "CanonicalProductVariant",
    "DonorProductVariantDecision",
    "ProductContentObservation",
    "SkuCostListingScopeLink",
    "SkuComponentEvidence",
    "SkuCost",
  ]) {
    const count = Number((await db.execute(`SELECT COUNT(*) AS count FROM "${table}"`)).rows[0].count);
    assert.equal(count, 0, table);
  }
  const confirmed = Number((await db.execute(
    "SELECT COUNT(*) AS count FROM DonorProduct WHERE identityStatus='exact_confirmed'",
  )).rows[0].count);
  assert.equal(confirmed, 0);
});
