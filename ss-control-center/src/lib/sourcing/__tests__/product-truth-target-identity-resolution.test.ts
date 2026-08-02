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
  compileProductTruthDirectRetailerIdentityEvidence,
  renderProductTruthDirectRetailerIdentityEvidence,
} from "../product-truth-direct-retailer-identity-evidence";
import {
  PRODUCT_TRUTH_AUTHORITATIVE_WALMART_ITEM_REPORT_EVIDENCE_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import {
  compileProductTruthListingRetailerIdentityBridge,
  renderProductTruthListingRetailerIdentityBridge,
} from "../product-truth-listing-retailer-identity-bridge";
import {
  productTruthOperationalSha256,
} from "../product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
  renderProductTruthSourceDetailAdmission,
  type ProductTruthSourceDetailAdmission,
} from "../product-truth-source-detail-admission";
import {
  compileProductTruthTargetIdentityResolution,
} from "../product-truth-target-identity-resolution";

const CAPTURED_AT = "2026-08-01T14:00:00.000Z";
const EVIDENCE_AT = "2026-08-01T14:30:00.000Z";
const GENERATED_AT = "2026-08-01T15:00:00.000Z";
const FINGERPRINT = "a".repeat(64);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function nextData(value: unknown): Uint8Array {
  return Buffer.from(
    `<html><script id="__NEXT_DATA__">${JSON.stringify(value)}</script></html>`,
  );
}

function fixture(mode: "FORM_CORRECTION" | "CROSS_RETAILER_GTIN") {
  const formCorrection = mode === "FORM_CORRECTION";
  const identity = formCorrection
    ? {
      brand: "Mueller's",
      productLine: "Egg Noodles",
      flavor: "Wide",
      form: "bag",
      size: "12 oz",
      outerPackCount: 1,
    }
    : {
      brand: "Malt-O-Meal",
      productLine: "S'mores Breakfast Cereal",
      flavor: "S'mores",
      form: "bag",
      size: "30 oz",
      outerPackCount: 1,
    };
  const canonical = buildCanonicalProductVariantKey(identity);
  const evidenceDonor = {
    id: "evidence-donor",
    brand: identity.brand,
    productLine: null,
    flavor: null,
    containerType: null,
    size: identity.size,
    category: "Dry",
    upc: formCorrection ? "047325908499" : null,
    gtin: null,
    title: formCorrection
      ? "Mueller's Wide Egg Noodles, 12 oz"
      : "Malt-O-Meal S'mores Breakfast Cereal - 30oz",
    description: "Description",
    bullets: "[]",
    attributes: formCorrection
      ? JSON.stringify([{ name: "Container type", value: "Box" }])
      : null,
    nutritionFacts: "{}",
    ingredients: "Ingredients",
    mainImageUrl: "https://example.com/main.jpeg",
    imageUrls: "[\"https://example.com/main.jpeg\"]",
    identityKey: "legacy:evidence-donor",
    identityStatus: "legacy_unverified",
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
  };
  const evidenceUrl = formCorrection
    ? "https://www.walmart.com/ip/example/38125427?classType=REGULAR"
    : "https://www.target.com/p/example/-/A-92782650";
  const evidenceOffer = {
    id: formCorrection ? "do:walmart:38125427" : "do:target:92782650",
    donorProductId: evidenceDonor.id,
    retailer: formCorrection ? "walmart" : "target",
    retailerProductId: formCorrection ? "38125427" : "92782650",
    via: "direct",
    price: 2.49,
    packSizeSeen: 1,
    pricePerUnit: 2.49,
    currency: "USD",
    zip: "33765",
    localityEvidence: "zip_scoped",
    inStock: true,
    productUrl: evidenceUrl,
    isFirstParty: true,
    sourceApi: "saved",
    fetchedAt: CAPTURED_AT,
  };
  const pivotDonor = formCorrection ? null : {
    ...evidenceDonor,
    id: "materialization-donor",
    upc: "042400240518",
    title:
      "Malt-O-Meal S'mores Breakfast Cereal, Graham, Chocolate & Marshmallow, 30 oz Bag",
    attributes: JSON.stringify([{ name: "Container type", value: "Bag" }]),
    identityKey: "legacy:materialization-donor",
  };
  const pivotOffer = pivotDonor ? {
    ...evidenceOffer,
    id: "do:walmart:49606925",
    donorProductId: pivotDonor.id,
    retailer: "walmart",
    retailerProductId: "49606925",
    productUrl: "https://www.walmart.com/ip/example/49606925",
  } : null;
  const reportCore = {
    schemaVersion:
      PRODUCT_TRUTH_AUTHORITATIVE_WALMART_ITEM_REPORT_EVIDENCE_VERSION,
    listingKey: "walmart:1:SKU-1",
    storeIndex: 1,
    sku: "SKU-1",
    itemId: "seller-item-1",
    title: `${evidenceDonor.title} (Pack of 2)`,
    brand: identity.brand,
    gtin: "00684611926128",
    upc: "684611926128",
    itemPageUrl: "https://www.walmart.com/ip/seller-item-1",
    primaryImageUrl: "https://i5.walmartimages.com/example.jpeg",
    publishStatus: "PUBLISHED" as const,
    lifecycleStatus: "ACTIVE" as const,
    sourceReportId: "report-1",
    sourceReportName: "ItemReport.csv",
    sourceReportCapturedAt: CAPTURED_AT,
    sourceReportSha256: "b".repeat(64),
    sourceReportByteLength: 100,
    sourceRowNumber: 2,
  };
  const report = {
    ...reportCore,
    evidenceRowSha256: productTruthOperationalSha256(reportCore),
  };
  const donors = [evidenceDonor, ...(pivotDonor ? [pivotDonor] : [])];
  const offers = [evidenceOffer, ...(pivotOffer ? [pivotOffer] : [])];
  const snapshot = {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: CAPTURED_AT,
    targetFingerprint: FINGERPRINT,
    manifest: {
      schemaVersion: "phase1-authoritative-scope-manifest/v3",
      sha256: "c".repeat(64),
      asOf: CAPTURED_AT,
      listingCount: 1,
    },
    listings: [],
    components: [],
    donors,
    offers,
    canonicalDonorBindings: [],
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
    authoritativeWalmartItemReportEvidence: [report],
    bundleFactoryRecipeEvidence: [],
  } as unknown as ProductTruthLegacyBridgeSnapshot;
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
  const snapshotSha = sha256(snapshotJson);
  const target = {
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
      listingKey: report.listingKey,
      channel: "walmart",
      storeIndex: 1,
      sku: report.sku,
      componentIndex: 0,
      quantity: 2,
      repairLane: "RETAILER_IDENTITY_RESEARCH",
      legacyComponentId: "component-1",
      legacyDonorProductId: evidenceDonor.id,
      historicalEvidence: null,
      priority: {
        gmv30d: null,
        orders30d: null,
        units30d: null,
        repairPriority: 1,
      },
    }],
  };
  const scope = {
    schemaVersion: PRODUCT_TRUTH_COMPONENT_ACQUISITION_SCOPE_VERSION,
    generatedAt: CAPTURED_AT,
    source: {
      bridgeSnapshot: {
        schemaVersion: snapshot.schemaVersion,
        sha256: snapshotSha,
        capturedAt: snapshot.capturedAt,
        targetFingerprint: FINGERPRINT,
        donorCount: donors.length,
        offerCount: offers.length,
        canonicalBindingCount: 0,
      },
    },
    targets: [target],
  } as unknown as ProductTruthComponentAcquisitionScope;
  const scopeJson = renderProductTruthComponentAcquisitionScope(scope);
  const scopeSha = sha256(scopeJson);
  const admission = {
    schemaVersion: PRODUCT_TRUTH_SOURCE_DETAIL_ADMISSION_VERSION,
    generatedAt: CAPTURED_AT,
    databaseTargetFingerprint: FINGERPRINT,
    source: {
      componentAcquisitionScope: {
        schemaVersion: scope.schemaVersion,
        sha256: scopeSha,
        generatedAt: scope.generatedAt,
      },
      bridgeSnapshot: {
        schemaVersion: snapshot.schemaVersion,
        sha256: snapshotSha,
        capturedAt: snapshot.capturedAt,
      },
    },
    targets: [{
      ordinal: 0,
      acquisitionPriority: 1,
      canonicalVariantId: canonical.canonicalVariantId,
      canonicalIdentityHash: canonical.identityHash,
      targetIdentity: identity,
      impact: target.impact,
      candidate: {
        retailer: evidenceOffer.retailer,
        retailerProductId: evidenceOffer.retailerProductId,
        productUrl: evidenceUrl,
        donorProductIds: [evidenceDonor.id],
        offerIds: [evidenceOffer.id],
        observedTitles: [evidenceDonor.title],
        admissionReasons: ["MISSING_FORM_ONLY"],
      },
    }],
  } as unknown as ProductTruthSourceDetailAdmission;
  const admissionJson = renderProductTruthSourceDetailAdmission(admission);
  const admissionSha = sha256(admissionJson);
  const listingBridge = compileProductTruthListingRetailerIdentityBridge({
    generatedAt: CAPTURED_AT,
    componentScope: scope,
    componentScopeJson: scopeJson,
    componentScopeSha256: scopeSha,
    bridgeSnapshot: snapshot,
    bridgeSnapshotJson: snapshotJson,
    bridgeSnapshotSha256: snapshotSha,
    sourceDetailAdmission: admission,
    sourceDetailAdmissionJson: admissionJson,
    sourceDetailAdmissionSha256: admissionSha,
  });
  const listingBridgeJson = renderProductTruthListingRetailerIdentityBridge(
    listingBridge,
  );
  const evidenceHtml = formCorrection
    ? nextData({
      props: { pageProps: { initialData: { data: {
        product: {
          usItemId: "38125427",
          name: evidenceDonor.title,
          upc: evidenceDonor.upc,
        },
        idml: {
          specifications: [{ name: "Container type", value: "Box" }],
          directions: [],
        },
      } } } },
    })
    : nextData({
      props: { pageProps: { item: {
        primary_barcode: "042400240518",
        product_description: {
          title: "Malt-O-Meal S&#39;mores Breakfast Cereal - 30oz",
          bullet_descriptions: ["Net weight: 30oz"],
        },
        enrichment: {},
      } } },
    });
  const evidence = compileProductTruthDirectRetailerIdentityEvidence({
    targetCanonicalVariantId: canonical.canonicalVariantId,
    donorProductId: evidenceDonor.id,
    offerId: evidenceOffer.id,
    retailer: evidenceOffer.retailer as "walmart" | "target",
    productUrl: evidenceUrl,
    finalUrl: evidenceUrl,
    httpStatus: 200,
    capturedAt: EVIDENCE_AT,
    htmlBytes: evidenceHtml,
  });
  const evidenceJson = renderProductTruthDirectRetailerIdentityEvidence(evidence);
  return {
    generatedAt: GENERATED_AT,
    componentScope: scope,
    componentScopeJson: scopeJson,
    componentScopeSha256: scopeSha,
    bridgeSnapshot: snapshot,
    bridgeSnapshotJson: snapshotJson,
    bridgeSnapshotSha256: snapshotSha,
    sourceDetailAdmission: admission,
    sourceDetailAdmissionJson: admissionJson,
    sourceDetailAdmissionSha256: admissionSha,
    listingRetailerIdentityBridge: listingBridge,
    listingRetailerIdentityBridgeJson: listingBridgeJson,
    listingRetailerIdentityBridgeSha256: sha256(listingBridgeJson),
    directEvidence: [{
      evidence,
      evidenceJson,
      evidenceSha256: sha256(evidenceJson),
      htmlBytes: evidenceHtml,
    }],
  };
}

test("exact direct retailer form corrects only the target form", () => {
  const result = compileProductTruthTargetIdentityResolution(
    fixture("FORM_CORRECTION"),
  );
  assert.equal(result.counts.correctedTargets, 1);
  assert.equal(result.targets[0]!.sourceIdentity.form, "bag");
  assert.equal(result.targets[0]!.resolvedIdentity.form, "box");
  assert.deepEqual(result.targets[0]!.changedFields, ["form"]);
  assert.equal(
    result.targets[0]!.materializationDonor.donorProductId,
    "evidence-donor",
  );
});

test("Target GTIN pivots to the unique same-GTIN donor with exact form", () => {
  const result = compileProductTruthTargetIdentityResolution(
    fixture("CROSS_RETAILER_GTIN"),
  );
  assert.equal(result.counts.crossRetailerGtinTargets, 1);
  assert.deepEqual(result.targets[0]!.changedFields, []);
  assert.equal(
    result.targets[0]!.materializationDonor.donorProductId,
    "materialization-donor",
  );
  assert.equal(
    result.targets[0]!.materializationDonor.normalizedManufacturerGtin14,
    "00042400240518",
  );
});

test("raw retailer byte drift is rejected before resolution", () => {
  const input = fixture("FORM_CORRECTION");
  input.directEvidence[0]!.htmlBytes = Buffer.from("tampered");
  assert.throws(
    () => compileProductTruthTargetIdentityResolution(input),
    /TARGET_IDENTITY_RESOLUTION_EVIDENCE_INVALID/,
  );
});
