import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_PLAN_VERSION,
  PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION,
  PRODUCT_TRUTH_AMAZON_CATALOG_INCLUDED_DATA,
  PRODUCT_TRUTH_AMAZON_CATALOG_MARKETPLACE_ID,
  PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS,
  renderProductTruthAmazonCatalogCapturePlan,
  renderProductTruthAmazonCatalogListingEvidence,
  type ProductTruthAmazonCatalogCapturePlan,
  type ProductTruthAmazonCatalogListingEvidence,
} from "../product-truth-amazon-catalog-evidence";
import {
  compileProductTruthAmazonListingDecomposition,
} from "../product-truth-amazon-listing-decomposition";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import { renderProductTruthOperationalJson } from "../product-truth-operational-run-contract";

const AT = "2026-08-01T16:00:00.000Z";
const MANIFEST_SHA = "1".repeat(64);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const target = {
    ordinal: 1,
    listingKey: "amazon:1:MOTTS-1",
    storeIndex: 1,
    sku: "MOTTS-1",
    asin: "B09QT2N7ZR",
    listingTitle: "Motts 100% Apple Juice - 1 Pack (8ct, 6.75oz Each)",
    repairLane: "LISTING_IDENTITY_RECOVERY" as const,
    sourceReportId: "report-1",
    sourceCapturedAt: AT,
    sourceContentSha256: "2".repeat(64),
    manifestRowSha256: "3".repeat(64),
    recipeScopeEntrySha256: "4".repeat(64),
  };
  const plan: ProductTruthAmazonCatalogCapturePlan = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_CATALOG_CAPTURE_PLAN_VERSION,
    generatedAt: AT,
    source: {
      manifest: {
        schemaVersion: "phase1-authoritative-scope-manifest/v3",
        sha256: MANIFEST_SHA,
        listingCount: 1,
      },
      recipeRepairScope: {
        schemaVersion: "product-truth-recipe-repair-scope/1.0.0",
        sha256: "5".repeat(64),
        generatedAt: AT,
      },
    },
    requestContract: {
      api: "Amazon Catalog Items 2022-04-01",
      method: "GET",
      marketplaceId: PRODUCT_TRUTH_AMAZON_CATALOG_MARKETPLACE_ID,
      includedData: PRODUCT_TRUTH_AMAZON_CATALOG_INCLUDED_DATA,
      concurrency: 1,
      attemptsPerTarget: 1,
      maxTargets: PRODUCT_TRUTH_AMAZON_CATALOG_MAX_TARGETS,
    },
    targetSetSha256: sha256(renderProductTruthOperationalJson([target])),
    targets: [target],
    claims: {
      explicitScopeOnly: true,
      readOnlyAmazonApi: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      authorizesCanonicalMaterialization: false,
      identifiersAreBaseUnitProof: false,
    },
  };
  const planJson = renderProductTruthAmazonCatalogCapturePlan(plan);
  const evidence: ProductTruthAmazonCatalogListingEvidence = {
    schemaVersion: PRODUCT_TRUTH_AMAZON_CATALOG_EVIDENCE_VERSION,
    compiledAt: AT,
    source: {
      planSha256: sha256(planJson),
      captureSha256: "6".repeat(64),
      targetSetSha256: plan.targetSetSha256,
    },
    entries: [{
      ordinal: 1,
      listingKey: target.listingKey,
      storeIndex: 1,
      sku: target.sku,
      asin: target.asin,
      listingTitle: target.listingTitle,
      repairLane: target.repairLane,
      rawCapture: {
        file: "0001-B09QT2N7ZR.json",
        sha256: "7".repeat(64),
        byteLength: 100,
        capturedAt: AT,
      },
      catalog: {
        asin: target.asin,
        attributes: {
          brand: [{ value: "Ready Set Gourmet" }],
          manufacturer: [{ value: "Mott's" }],
          flavor: [{ value: "Apple Juice" }],
          number_of_items: [{ value: 12 }],
          each_unit_count: [{ value: 8 }],
        },
        identifiers: [],
        images: [],
        productTypes: [],
        relationships: [],
        summaries: [],
      },
      authority: {
        structuredMarketplaceEvidence: true,
        titleOnlyIdentityProof: false,
        identifiersAreBaseUnitProof: false,
        authorizesCanonicalMaterialization: false,
      },
    }],
    counts: {
      targets: 1,
      entriesWithIdentifiers: 0,
      identifierCount: 0,
      entriesWithAttributes: 1,
      entriesWithImages: 0,
    },
    claims: {
      offlineCompilation: true,
      networkCalls: 0,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      marketplaceMutations: 0,
      titleOnlyIdentityProof: false,
      identifiersAreBaseUnitProof: false,
      authorizesCanonicalMaterialization: false,
      createsAdditionalCatalog: false,
    },
  };
  const evidenceJson = renderProductTruthAmazonCatalogListingEvidence(evidence);
  const donor = (input: { id: string; title: string; retailer: string }) => ({
    id: input.id,
    brand: "Mott's",
    productLine: null,
    flavor: null,
    containerType: null,
    size: null,
    category: "Dry",
    upc: null,
    gtin: null,
    title: input.title,
    description: null,
    bullets: null,
    attributes: null,
    nutritionFacts: null,
    ingredients: null,
    mainImageUrl: null,
    imageUrls: null,
    identityKey: input.id,
    identityStatus: "legacy_unverified",
    createdAt: AT,
    updatedAt: AT,
  });
  const donors = [
    donor({ id: "juice-ok", title: "Mott's 100% Apple Juice, 6.75 fl oz, 8 Count Bottles", retailer: "walmart" }),
    donor({ id: "applesauce", title: "Mott's No Sugar Added Cinnamon Applesauce, 6 Count", retailer: "walmart" }),
    donor({ id: "juice-bjs", title: "Mott's Apple Juice, 8 Count", retailer: "bjs" }),
  ];
  const snapshot = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: AT,
    targetFingerprint: "8".repeat(64),
    manifest: { sha256: MANIFEST_SHA, listingCount: 1 },
    listings: [],
    components: [],
    donors,
    offers: donors.map((row) => ({
      id: `offer-${row.id}`,
      donorProductId: row.id,
      retailer: row.id === "juice-bjs" ? "bjs" : "walmart",
      retailerProductId: row.id,
      via: "direct",
      price: null,
      packSizeSeen: null,
      pricePerUnit: null,
      currency: "USD",
      zip: "33765",
      localityEvidence: null,
      inStock: null,
      productUrl: `https://example.test/${row.id}`,
      isFirstParty: true,
      sourceApi: "fixture",
      fetchedAt: AT,
    })),
    canonicalDonorBindings: [],
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
    authoritativeWalmartItemReportEvidence: [],
  } as unknown as ProductTruthLegacyBridgeSnapshot;
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
  return { plan, planJson, evidence, evidenceJson, snapshot, snapshotJson };
}

test("exposes brand and outer-count contradictions without granting identity", () => {
  const source = fixture();
  const result = compileProductTruthAmazonListingDecomposition({
    compiledAt: AT,
    plan: source.plan,
    planJson: source.planJson,
    planSha256: sha256(source.planJson),
    evidence: source.evidence,
    evidenceJson: source.evidenceJson,
    evidenceSha256: sha256(source.evidenceJson),
    legacySnapshot: source.snapshot,
    legacySnapshotJson: source.snapshotJson,
    legacySnapshotSha256: sha256(source.snapshotJson),
  });
  assert.equal(result.entries[0]!.status, "CONTRADICTORY_CATALOG_STRUCTURE");
  assert.ok(result.entries[0]!.blockerCodes.includes(
    "CATALOG_BRAND_MANUFACTURER_CONFLICT",
  ));
  assert.ok(result.entries[0]!.blockerCodes.includes("OUTER_COUNT_CONFLICT"));
  assert.equal(result.counts.exactComponentIdentityProven, 0);
  assert.equal(result.claims.authorizesCanonicalMaterialization, false);
});

test("requires flavor anchors and excludes BJ's-only candidates", () => {
  const source = fixture();
  const result = compileProductTruthAmazonListingDecomposition({
    compiledAt: AT,
    plan: source.plan,
    planJson: source.planJson,
    planSha256: sha256(source.planJson),
    evidence: source.evidence,
    evidenceJson: source.evidenceJson,
    evidenceSha256: sha256(source.evidenceJson),
    legacySnapshot: source.snapshot,
    legacySnapshotJson: source.snapshotJson,
    legacySnapshotSha256: sha256(source.snapshotJson),
  });
  assert.deepEqual(
    result.entries[0]!.candidates.map((candidate) => candidate.donorProductId),
    ["juice-ok"],
  );
  assert.equal(result.entries[0]!.candidates[0]!.exactIdentityProven, false);
});

test("fails closed on evidence byte drift", () => {
  const source = fixture();
  assert.throws(() => compileProductTruthAmazonListingDecomposition({
    compiledAt: AT,
    plan: source.plan,
    planJson: source.planJson,
    planSha256: sha256(source.planJson),
    evidence: source.evidence,
    evidenceJson: `${source.evidenceJson} `,
    evidenceSha256: sha256(source.evidenceJson),
    legacySnapshot: source.snapshot,
    legacySnapshotJson: source.snapshotJson,
    legacySnapshotSha256: sha256(source.snapshotJson),
  }), /AMAZON_DECOMPOSITION_SOURCE_BINDING_MISMATCH/u);
});
