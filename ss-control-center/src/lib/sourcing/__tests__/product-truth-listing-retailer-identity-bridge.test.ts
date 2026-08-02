import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildCanonicalProductVariantKey,
} from "../canonical-product-variant";
import {
  PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
  renderProductTruthComponentAcquisitionScope,
  type ProductTruthComponentAcquisitionScope,
} from "../product-truth-component-acquisition-scope";
import {
  PRODUCT_TRUTH_AUTHORITATIVE_WALMART_ITEM_REPORT_EVIDENCE_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthAuthoritativeWalmartItemReportEvidenceRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import {
  compileProductTruthListingRetailerIdentityBridge,
} from "../product-truth-listing-retailer-identity-bridge";
import {
  productTruthOperationalSha256,
} from "../product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
  renderProductTruthSourceDetailAdmission,
  type ProductTruthSourceDetailAdmission,
} from "../product-truth-source-detail-admission";

const CAPTURED_AT = "2026-08-01T12:00:00.000Z";
const GENERATED_AT = "2026-08-01T13:00:00.000Z";
const TARGET_FINGERPRINT = "a".repeat(64);
const SOURCE_REPORT_SHA = "b".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reportEvidence(input: {
  title: string;
  quantity: number;
  gtin: string;
}): ProductTruthAuthoritativeWalmartItemReportEvidenceRow {
  const core = {
    schemaVersion:
      PRODUCT_TRUTH_AUTHORITATIVE_WALMART_ITEM_REPORT_EVIDENCE_VERSION,
    listingKey: "walmart:1:SKU-1",
    storeIndex: 1,
    sku: "SKU-1",
    itemId: "seller-item-1",
    title: input.title,
    brand: "Campbell's",
    gtin: input.gtin,
    upc: input.gtin.slice(-12),
    itemPageUrl: "https://www.walmart.com/ip/seller-item-1",
    primaryImageUrl: "https://i5.walmartimages.com/example.jpeg",
    publishStatus: "PUBLISHED" as const,
    lifecycleStatus: "ACTIVE" as const,
    sourceReportId: "report-1",
    sourceReportName: "ItemReport.csv",
    sourceReportCapturedAt: CAPTURED_AT,
    sourceReportSha256: SOURCE_REPORT_SHA,
    sourceReportByteLength: 1234,
    sourceRowNumber: 2,
  };
  return {
    ...core,
    evidenceRowSha256: productTruthOperationalSha256(core),
  };
}

function fixture(input: {
  title?: string;
  quantity?: number;
  donorUpc?: string | null;
  donorAttributes?: string | null;
  reportGtin?: string;
}) {
  const quantity = input.quantity ?? 6;
  const identity = {
    brand: "Campbell's",
    productLine: "Chunky Soup",
    flavor: "Beef with Country Vegetables",
    form: "can",
    size: "18.8 oz",
    outerPackCount: 1,
  };
  const canonical = buildCanonicalProductVariantKey(identity);
  const productUrl =
    "https://www.target.com/p/campbell-beef-country-vegetables-18-8oz/-/A-11853100";
  const donor = {
    id: "donor-1",
    brand: "Campbell's",
    productLine: null,
    flavor: null,
    containerType: null,
    size: "18.8 oz",
    category: "Dry",
    upc: input.donorUpc === undefined ? "051000005502" : input.donorUpc,
    gtin: null,
    title: "Campbell's Chunky Beef with Country Vegetables Soup - 18.8oz",
    description: null,
    bullets: null,
    attributes: input.donorAttributes ?? null,
    nutritionFacts: null,
    ingredients: null,
    mainImageUrl: null,
    imageUrls: null,
    identityKey: "legacy:donor-1",
    identityStatus: "legacy_unverified",
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
  };
  const offer = {
    id: "do:target:11853100",
    donorProductId: donor.id,
    retailer: "target",
    retailerProductId: "11853100",
    via: "direct",
    price: 2.49,
    packSizeSeen: 1,
    pricePerUnit: 2.49,
    currency: "USD",
    zip: "33765",
    localityEvidence: "zip_scoped",
    inStock: true,
    productUrl,
    isFirstParty: true,
    sourceApi: "unwrangle",
    fetchedAt: CAPTURED_AT,
  };
  const evidence = reportEvidence({
    title: input.title
      ?? "Campbell's Chunky Soup, Ready to Serve Beef Soup with Country Vegetables, 18.8 oz Can (Pack of 6)",
    quantity,
    gtin: input.reportGtin ?? "00684611926128",
  });
  const snapshot = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: CAPTURED_AT,
    targetFingerprint: TARGET_FINGERPRINT,
    manifest: {
      schemaVersion: "phase1-authoritative-scope-manifest/v3",
      sha256: "c".repeat(64),
      asOf: CAPTURED_AT,
      listingCount: 1,
    },
    listings: [],
    components: [],
    donors: [donor],
    offers: [offer],
    canonicalDonorBindings: [],
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
    authoritativeWalmartItemReportEvidence: [evidence],
    bundleFactoryRecipeEvidence: [],
  } as unknown as ProductTruthLegacyBridgeSnapshot;
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
  const snapshotSha256 = sha256(snapshotJson);
  const scope = {
    schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
    generatedAt: CAPTURED_AT,
    source: {
      bridgeSnapshot: {
        schemaVersion: snapshot.schemaVersion,
        sha256: snapshotSha256,
        capturedAt: snapshot.capturedAt,
        targetFingerprint: TARGET_FINGERPRINT,
        donorCount: 1,
        offerCount: 1,
        canonicalBindingCount: 0,
      },
    },
    targets: [{
      ordinal: 0,
      acquisitionPriority: 1,
      canonicalVariantId: canonical.canonicalVariantId,
      canonicalIdentityHash: canonical.identityHash,
      canonicalIdentityJson: canonical.identityJson,
      targetIdentity: identity,
      identityQuality: { status: "ACQUISITION_READY", blockerCodes: [] },
      acquisitionLane: "PROVIDER_IDENTITY_ACQUISITION",
      exactCatalogCandidates: [],
      impact: {
        componentUses: 1,
        dependentListings: 1,
        immediateClosableListings: 1,
        amazonListings: 0,
        walmartListings: 1,
        knownGmv30d: 0,
        knownOrders30d: 0,
        knownUnits30d: 0,
      },
      dependencies: [{
        listingKey: evidence.listingKey,
        channel: "walmart",
        storeIndex: 1,
        sku: evidence.sku,
        componentIndex: 0,
        quantity,
        repairLane: "RETAILER_IDENTITY_RESEARCH",
        legacyComponentId: "component-1",
        legacyDonorProductId: donor.id,
        historicalEvidence: null,
        priority: {
          gmv30d: null,
          orders30d: null,
          units30d: null,
          repairPriority: 1,
        },
      }],
    }],
  } as unknown as ProductTruthComponentAcquisitionScope;
  const scopeJson = renderProductTruthComponentAcquisitionScope(scope);
  const scopeSha256 = sha256(scopeJson);
  const admission = {
    schemaVersion: PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
    generatedAt: CAPTURED_AT,
    databaseTargetFingerprint: TARGET_FINGERPRINT,
    source: {
      componentAcquisitionScope: {
        schemaVersion: scope.schemaVersion,
        sha256: scopeSha256,
        generatedAt: scope.generatedAt,
      },
      bridgeSnapshot: {
        schemaVersion: snapshot.schemaVersion,
        sha256: snapshotSha256,
        capturedAt: snapshot.capturedAt,
      },
    },
    targets: [{
      ordinal: 0,
      acquisitionPriority: 1,
      canonicalVariantId: canonical.canonicalVariantId,
      canonicalIdentityHash: canonical.identityHash,
      targetIdentity: identity,
      impact: scope.targets[0]!.impact,
      candidate: {
        retailer: "target",
        retailerProductId: offer.retailerProductId,
        productUrl,
        donorProductIds: [donor.id],
        offerIds: [offer.id],
        observedTitles: [donor.title],
        admissionReasons: ["MISSING_FORM_ONLY"],
      },
    }],
  } as unknown as ProductTruthSourceDetailAdmission;
  const admissionJson = renderProductTruthSourceDetailAdmission(admission);
  return {
    componentScope: scope,
    componentScopeJson: scopeJson,
    componentScopeSha256: scopeSha256,
    bridgeSnapshot: snapshot,
    bridgeSnapshotJson: snapshotJson,
    bridgeSnapshotSha256: snapshotSha256,
    sourceDetailAdmission: admission,
    sourceDetailAdmissionJson: admissionJson,
    sourceDetailAdmissionSha256: sha256(admissionJson),
  };
}

test("authoritative exact package form admits a multipack without treating its GTIN as manufacturer truth", () => {
  const result = compileProductTruthListingRetailerIdentityBridge({
    generatedAt: GENERATED_AT,
    ...fixture({}),
  });
  assert.equal(result.counts.admittedTargets, 1);
  assert.equal(result.counts.exactSingleUnitGtinTargets, 0);
  assert.equal(result.counts.exactAuthoritativePackageFormTargets, 1);
  assert.equal(result.counts.outerMarketplaceGtinEvidenceRows, 1);
  assert.equal(result.targets[0]!.identityMethod, "EXACT_AUTHORITATIVE_PACKAGE_FORM");
  assert.equal(
    result.targets[0]!.listingEvidence[0]!.reportGtinRole,
    "OUTER_MARKETPLACE_OFFER_GTIN",
  );
  assert.equal(
    result.targets[0]!.listingEvidence[0]!.identityProofRole,
    "EXACT_LISTING_PACKAGE_FORM",
  );
  assert.deepEqual(
    result.targets[0]!.listingEvidence[0]!.removedPresentationPhrases,
    ["ready to serve"],
  );
});

test("first-party retailer Container type proves the only package-form token missing from the listing", () => {
  const result = compileProductTruthListingRetailerIdentityBridge({
    generatedAt: GENERATED_AT,
    ...fixture({
      title: "Campbell's Chunky Beef Soup with Country Vegetables, 18.8 oz (Pack of 6)",
      donorAttributes: JSON.stringify([{
        name: "Container type",
        value: "Can",
      }]),
    }),
  });
  assert.equal(result.counts.admittedTargets, 1);
  assert.equal(result.counts.exactFirstPartyRetailerPackageFormTargets, 1);
  assert.equal(
    result.targets[0]!.identityMethod,
    "EXACT_FIRST_PARTY_RETAILER_PACKAGE_FORM",
  );
  assert.deepEqual(result.targets[0]!.retailerPackageFormEvidence, {
    source: "DONOR_ATTRIBUTES_CONTAINER_TYPE",
    donorProductId: "donor-1",
    donorRowSha256: result.targets[0]!.donor.donorRowSha256,
    attributeName: "Container type",
    rawValue: "Can",
    normalizedForm: "can",
  });
  assert.equal(
    result.targets[0]!.listingEvidence[0]!.identityProofRole,
    "EXACT_FIRST_PARTY_RETAILER_PACKAGE_FORM",
  );
});

test("first-party retailer package-form contradiction fails closed before listing-title fallback", () => {
  const result = compileProductTruthListingRetailerIdentityBridge({
    generatedAt: GENERATED_AT,
    ...fixture({
      donorAttributes: JSON.stringify([{
        name: "Container type",
        value: "Box",
      }]),
    }),
  });
  assert.equal(result.counts.admittedTargets, 0);
  assert.deepEqual(result.exclusions[0]!.blockerCodes, [
    "AUTHORITATIVE_RETAILER_PACKAGE_FORM_CONTRADICTION",
  ]);
});

test("missing package form remains excluded even when all title identity tokens match", () => {
  const result = compileProductTruthListingRetailerIdentityBridge({
    generatedAt: GENERATED_AT,
    ...fixture({
      title: "Campbell's Chunky Beef Soup with Country Vegetables, 18.8 oz (Pack of 6)",
    }),
  });
  assert.equal(result.counts.admittedTargets, 0);
  assert.deepEqual(result.exclusions[0]!.blockerCodes, [
    "AUTHORITATIVE_PACKAGE_FORM_NOT_EXACT",
  ]);
});

test("adjacent flavor in the authoritative listing cannot be used as package-form proof", () => {
  const result = compileProductTruthListingRetailerIdentityBridge({
    generatedAt: GENERATED_AT,
    ...fixture({
      title: "Campbell's Chunky Spicy Beef Soup with Country Vegetables, 18.8 oz Can (Pack of 6)",
    }),
  });
  assert.equal(result.counts.admittedTargets, 0);
  assert.deepEqual(result.exclusions[0]!.blockerCodes, [
    "AUTHORITATIVE_PACKAGE_FORM_NOT_EXACT",
  ]);
});

test("a byte-equal valid GTIN may prove identity only for an explicit single-unit listing", () => {
  const result = compileProductTruthListingRetailerIdentityBridge({
    generatedAt: GENERATED_AT,
    ...fixture({
      quantity: 1,
      title: "Campbell's Chunky Beef Soup with Country Vegetables, 18.8 oz",
      donorUpc: "051000005502",
      reportGtin: "00051000005502",
    }),
  });
  assert.equal(result.counts.exactSingleUnitGtinTargets, 1);
  assert.equal(result.targets[0]!.identityMethod, "EXACT_SINGLE_UNIT_GTIN_EQUALITY");
  assert.equal(
    result.targets[0]!.listingEvidence[0]!.reportGtinRole,
    "EXACT_SINGLE_UNIT_MANUFACTURER_GTIN",
  );
});

test("invalid donor UPC cannot unlock either identity path", () => {
  const result = compileProductTruthListingRetailerIdentityBridge({
    generatedAt: GENERATED_AT,
    ...fixture({ donorUpc: "051000005503" }),
  });
  assert.equal(result.counts.admittedTargets, 0);
  assert.deepEqual(result.exclusions[0]!.blockerCodes, [
    "DONOR_MANUFACTURER_GTIN_INVALID",
  ]);
});
