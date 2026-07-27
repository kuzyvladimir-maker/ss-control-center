import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  compileProductTruthLegacyBridgePlan,
  productTruthLegacyBridgeBytesSha256,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeComponentRow,
  type ProductTruthDirectTargetContentEvidence,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import { renderProductTruthOperationalJson } from "../product-truth-operational-run-contract";

function component(
  overrides: Partial<ProductTruthLegacyBridgeComponentRow> = {},
): ProductTruthLegacyBridgeComponentRow {
  return {
    id: "component-1",
    sku: "SKU-1",
    idx: 0,
    product: "Acme Crunch Chips",
    flavor: "Barbecue",
    size: "8 oz",
    qty: 1,
    costMethod: "exact",
    retailer: "walmart",
    matchedTitle: null,
    perUnitCost: 3.49,
    lineCost: 3.49,
    donorProductId: "donor-1",
    contentDonorProductId: null,
    priceEvidenceDonorProductId: null,
    priceEvidenceOfferId: null,
    ...overrides,
  };
}

function donor(
  overrides: Partial<ProductTruthLegacyBridgeDonorRow> = {},
): ProductTruthLegacyBridgeDonorRow {
  return {
    id: "donor-1",
    brand: "Acme",
    productLine: null,
    flavor: null,
    containerType: null,
    size: "8 oz",
    category: "Dry",
    upc: "036000291452",
    gtin: null,
    title: "Acme Crunch Chips Barbecue Bag 8 oz",
    description: "Crunchy barbecue chips.",
    bullets: "[\"One bag\"]",
    attributes: "[{\"name\":\"Food condition\",\"value\":\"Shelf-Stable\"}]",
    nutritionFacts: "{\"calories\":150,\"allergens\":[]}",
    ingredients: "Potatoes, oil, seasoning.",
    mainImageUrl: "https://images.example/main.jpg",
    imageUrls: "[\"https://images.example/main.jpg\"]",
    identityKey: "acme-crunch-chips-barbecue-8oz",
    identityStatus: "legacy_unverified",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function offer(
  overrides: Partial<ProductTruthLegacyBridgeOfferRow> = {},
): ProductTruthLegacyBridgeOfferRow {
  return {
    id: "offer-1",
    donorProductId: "donor-1",
    retailer: "walmart",
    retailerProductId: "123",
    via: "direct",
    price: 3.49,
    packSizeSeen: 1,
    pricePerUnit: 3.49,
    currency: "USD",
    zip: "33765",
    localityEvidence: "zip_scoped",
    inStock: true,
    productUrl: "https://www.walmart.com/ip/123",
    isFirstParty: true,
    sourceApi: "test",
    fetchedAt: "2026-07-26T11:00:00.000Z",
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    brand: "Acme",
    product_line: "Crunch Chips",
    flavor: "Barbecue",
    size: "8 oz",
    container_type: "Bag",
    units_in_listing: 1,
    is_bundle: false,
    components: [],
    ...overrides,
  });
}

function snapshot(
  overrides: Partial<ProductTruthLegacyBridgeSnapshot> = {},
): ProductTruthLegacyBridgeSnapshot {
  return {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: "2026-07-26T12:00:00.000Z",
    targetFingerprint: "a".repeat(64),
    manifest: {
      schemaVersion: "phase1-authoritative-scope-manifest/v3",
      sha256: "b".repeat(64),
      asOf: "2026-07-26T00:00:00.000Z",
      listingCount: 1,
    },
    listings: [{
      listingKey: "ptls1:test",
      channel: "walmart",
      storeIndex: 1,
      sku: "SKU-1",
      listingUpc: null,
      listingUpcSource: null,
      priorityGmv30d: null,
      priorityOrders30d: null,
      priorityUnits30d: null,
      priorityObservedAt: null,
      productIdentityJson: identity(),
      productIdentityUpdatedAt: "2026-07-10T00:00:00.000Z",
    }],
    components: [component()],
    donors: [donor()],
    offers: [offer()],
    canonicalDonorBindings: [],
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
    ...overrides,
  };
}

function compile(value: ProductTruthLegacyBridgeSnapshot) {
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(value);
  return compileProductTruthLegacyBridgePlan({
    snapshot: value,
    snapshotJson,
    snapshotSha256: productTruthLegacyBridgeBytesSha256(snapshotJson),
    generatedAt: "2026-07-26T13:00:00.000Z",
  });
}

function directTargetEvidence(
  overrides: Partial<ProductTruthDirectTargetContentEvidence> = {},
) {
  const evidence: ProductTruthDirectTargetContentEvidence = {
    schemaVersion: "product-truth-direct-target-content-evidence/1.0.0",
    donorProductId: "donor-1",
    offerId: "offer-1",
    capturedAt: "2026-07-26T11:30:00.000Z",
    retailerContent: {
      retailer: "target",
      retailerProductId: "12973001",
      productUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      finalUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      httpStatus: 200,
      fetchedAt: "2026-07-26T11:30:00.000Z",
      htmlFile: "retailer-content.html",
      htmlSha256: "c".repeat(64),
      normalizedGtin14: "00036000291452",
      title: "Acme Crunch Chips Barbecue Bag 8 oz",
      description: "Exact Target description.",
      bullets: ["One exact bag"],
      attributes: ["State of Readiness: Ready to Eat"],
      nutritionFacts: { calories: 150 },
      ingredients: "Potatoes, oil, seasoning.",
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
    ...overrides,
  };
  return {
    ...evidence,
    evidenceArtifactSha256: productTruthLegacyBridgeBytesSha256(
      renderProductTruthOperationalJson(evidence),
    ),
  };
}

test("strict title exact donor can use byte-bound direct Target content", () => {
  const value = snapshot({
    donors: [donor({
      attributes: "[{\"label\":\"State of Readiness\",\"value\":\"Ready to Eat\"}]",
      nutritionFacts: "{\"calories\":150}",
      ingredients: "Potatoes, oil, seasoning.",
    })],
    offers: [offer({
      retailer: "target",
      retailerProductId: "12973001",
      productUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      sourceApi: "unwrangle",
    })],
    directTargetContentEvidence: [directTargetEvidence()],
  });
  const plan = compile(value);
  const componentPlan = plan.scopes[0].components[0];
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
  assert.equal(componentPlan.identityProof, "STRICT_TITLE_MATCH");
  assert.equal(componentPlan.contentAssessment?.complete, true);
  assert.equal(
    componentPlan.contentAssessment?.contentOverride?.evidenceType,
    "DIRECT_TARGET_CONTENT",
  );
  assert.equal(
    componentPlan.contentAssessment?.allergensEvidence
      && (componentPlan.contentAssessment.allergensEvidence as { value: string }).value,
    "Contains: Milk.",
  );
  assert.equal(
    componentPlan.contentAssessment?.storageEvidence
      && (componentPlan.contentAssessment.storageEvidence as { value: string }).value,
    "Ready to Eat",
  );
});

test("legacy label-shaped readiness attribute is accepted as explicit storage evidence", () => {
  const value = snapshot({
    donors: [donor({
      attributes: "[{\"label\":\"State of Readiness\",\"value\":\"Ready to Eat\"}]",
    })],
  });
  const assessment = compile(value).scopes[0].components[0].contentAssessment;
  assert.equal(assessment?.complete, true);
  assert.deepEqual(
    assessment?.storageEvidence,
    { label: "State of Readiness", value: "Ready to Eat" },
  );
});

test("direct Target evidence fails closed when the exact offer binding is wrong", () => {
  const value = snapshot({
    offers: [offer({
      retailer: "target",
      retailerProductId: "12973001",
      productUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      sourceApi: "unwrangle",
    })],
    directTargetContentEvidence: [directTargetEvidence({ offerId: "wrong-offer" })],
  });
  assert.throws(
    () => compile(value),
    /LEGACY_BRIDGE_DIRECT_TARGET_CONTENT_EVIDENCE_INVALID/,
  );
});

test("direct Target content cannot rescue a strict matcher rejection", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({ flavor: "Hot" }),
    }],
    donors: [donor({
      attributes: "[{\"label\":\"State of Readiness\",\"value\":\"Ready to Eat\"}]",
      nutritionFacts: "{\"calories\":150}",
      ingredients: "Potatoes, oil, seasoning.",
    })],
    offers: [offer({
      retailer: "target",
      retailerProductId: "12973001",
      productUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      sourceApi: "unwrangle",
    })],
    directTargetContentEvidence: [directTargetEvidence()],
  });
  const componentPlan = compile(value).scopes[0].components[0];
  assert.equal(componentPlan.matcherVerdict, "REJECT");
  assert.equal(componentPlan.disposition, "QUARANTINE");
  assert.equal(componentPlan.contentAssessment, null);
});

test("fresh exact live-image barcode can prove a same-product multipack component", () => {
  const value = snapshot({
    capturedAt: "2026-07-27T13:00:00.000Z",
    listings: [{
      ...snapshot().listings[0],
      listingKey: "walmart:1:FaisalX-1148",
      sku: "FaisalX-1148",
      listingUpc: "742132418239",
      productIdentityJson: identity({
        brand: "Pepperidge Farm",
        product_line: "Hot Dog Buns",
        flavor: "White",
        size: "8 count",
        container_type: "Bag",
        units_in_listing: 2,
        base_unit: "Pepperidge Farm White Top-Sliced Hot Dog Buns 8 count bag",
      }),
    }],
    components: [component({
      id: "comp:FaisalX-1148:0",
      sku: "FaisalX-1148",
      product: "Hot Dog Buns",
      flavor: "White",
      size: "8 count",
      qty: 2,
      donorProductId: "donor-1",
    })],
    donors: [donor({
      id: "donor-1",
      brand: "Pepperidge Farm",
      size: "14 oz",
      upc: "014100070931",
      title: "Pepperidge Farm Bakery Classics Top Sliced White Hot Dog Buns - 14oz/8ct",
      bullets: "[\"8 BUNS: 8-count bag of Pepperidge Farm Top Sliced Soft White hot dog buns\"]",
    })],
    offers: [offer({
      donorProductId: "donor-1",
      retailer: "target",
      retailerProductId: "17189284",
      productUrl: "https://www.target.com/p/-/A-17189284",
      fetchedAt: "2026-07-27T12:00:00.000Z",
    })],
    componentBarcodeEvidence: [{
      schemaVersion: "product-truth-live-image-barcode-evidence/1.0.0",
      evidenceArtifactSha256: "1".repeat(64),
      listingKey: "walmart:1:FaisalX-1148",
      componentIndex: 0,
      capturedAt: "2026-07-27T12:45:00.000Z",
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
        productUrl: "https://www.target.com/p/-/A-17189284",
        finalUrl: "https://www.target.com/p/-/A-17189284",
        httpStatus: 200,
        fetchedAt: "2026-07-27T12:45:00.000Z",
        htmlFile: "retailer-content.html",
        htmlSha256: "c".repeat(64),
        normalizedGtin14: "00014100070931",
        title: "Pepperidge Farm Bakery Classics Top Sliced White Hot Dog Buns - 14oz/8ct",
        description: "Exact product description.",
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
    }],
  });
  const plan = compile(value);
  const componentPlan = plan.scopes[0].components[0];
  assert.equal(plan.scopes[0].writeEligible, true);
  assert.equal(componentPlan.identityProof, "EXACT_LIVE_IMAGE_BARCODE");
  assert.equal(componentPlan.targetIdentity?.productLine, "bakery classics hot dog buns");
  assert.deepEqual(componentPlan.targetIdentity?.modifiers, ["top sliced"]);
  assert.match(
    String(componentPlan.targetVariant?.canonicalVariantId),
    /^cpv1:[a-f0-9]{64}$/,
  );
});

test("exact existing donor becomes a no-fetch canonicalization candidate", () => {
  const plan = compile(snapshot());
  assert.equal(plan.counts.exactCanonicalizationCandidates, 1);
  assert.equal(plan.scopes[0].writeEligible, true);
  assert.equal(plan.scopes[0].components[0].matcherVerdict, "EXACT_IDENTITY");
  assert.equal(plan.scopes[0].components[0].donorOfferId, "offer-1");
  assert.equal(plan.scopes[0].components[0].contentAssessment?.complete, true);
  assert.match(
    String(plan.scopes[0].components[0].targetVariant?.canonicalVariantId),
    /^cpv1:[a-f0-9]{64}$/,
  );
  assert.deepEqual(plan.safety, {
    readOnly: true,
    databaseWrites: 0,
    providerCalls: 0,
    paidCalls: 0,
    retailerFetches: 0,
    mutatesLegacyCatalog: false,
    createsAdditionalCatalog: false,
    historicalExactFlagsAreIdentityProof: false,
    priceProxyMayProvideContent: false,
  });
  assert.equal(plan.pricePolicy.maxAgeMs, 86_400_000);
});

test("historical exact flag cannot admit Hot target matched to Maple donor", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Jimmy Dean",
        product_line: "Premium Pork Sausage",
        flavor: "Hot",
        size: "16 oz",
        container_type: "Roll",
      }),
    }],
    components: [component({
      product: "Jimmy Dean Premium Pork Sausage",
      flavor: "Hot",
      size: "16 oz",
      costMethod: "exact",
    })],
    donors: [donor({
      brand: "Jimmy Dean",
      size: "16 oz",
      title: "Jimmy Dean Premium Pork Sausage Maple Roll 16 oz",
    })],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].disposition, "QUARANTINE");
  assert.equal(plan.scopes[0].components[0].matcherVerdict, "REJECT");
  assert.ok(plan.scopes[0].components[0].matcherReasonCodes.includes("TITLE_TARGET_TOKEN_MISSING"));
});

test("historical exact flag cannot admit Patties target matched to Links donor", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Jimmy Dean",
        product_line: "Fully Cooked Pork Sausage",
        flavor: "Patties",
        size: "8 count",
        container_type: "Bag",
      }),
    }],
    donors: [donor({
      brand: "Jimmy Dean",
      size: "8 count",
      title: "Jimmy Dean Fully Cooked Pork Sausage Links Bag 8 Count",
    })],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].components[0].disposition, "QUARANTINE");
  assert.equal(plan.scopes[0].components[0].matcherVerdict, "REJECT");
});

test("cross-size donor is price-only and never content truth", () => {
  const value = snapshot({
    donors: [donor({
      size: "16 oz",
      title: "Acme Crunch Chips Barbecue Bag 16 oz",
    })],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].disposition, "QUARANTINE");
  assert.equal(plan.scopes[0].components[0].disposition, "PRICE_ONLY_ESTIMATE");
  assert.equal(plan.scopes[0].components[0].matcherVerdict, "CROSS_SIZE_ESTIMATE");
  assert.equal(plan.scopes[0].components[0].donorOfferId, null);
});

test("valid exact manufacturer UPC repairs a stale donor link without title guessing", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      listingUpc: "036000291452",
      listingUpcSource: "walmart_item",
    }],
    components: [component({ donorProductId: "wrong-donor" })],
    donors: [
      donor({
        id: "wrong-donor",
        upc: null,
        title: "Acme Crunch Chips Maple Bag 8 oz",
      }),
      donor({
        id: "gtin-donor",
        upc: "036000291452",
        title: "Legacy title with noisy retailer copy",
      }),
    ],
    offers: [offer({ donorProductId: "gtin-donor" })],
  });
  const plan = compile(value);
  const result = plan.scopes[0].components[0];
  assert.equal(result.identityProof, "EXACT_GTIN");
  assert.equal(result.donorProductId, "gtin-donor");
  assert.equal(result.legacyDonorProductId, "wrong-donor");
  assert.equal(result.disposition, "EXACT_CONTENT_AND_PRICE_CANDIDATE");
});

test("invalid UPC cannot bypass the strict matcher", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      listingUpc: "036000291453",
      listingUpcSource: "walmart_item",
    }],
    donors: [donor({
      upc: "036000291453",
      title: "Acme Crunch Chips Maple Bag 8 oz",
    })],
  });
  const result = compile(value).scopes[0].components[0];
  assert.equal(result.identityProof, "NONE");
  assert.equal(result.disposition, "QUARANTINE");
});

test("an outer marketplace UPC cannot prove a multipack base-unit donor", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      listingUpc: "036000291452",
      listingUpcSource: "walmart_item",
      productIdentityJson: identity({
        units_in_listing: 4,
        flavor: "Maple",
      }),
    }],
    components: [component({ qty: 4, flavor: "Maple" })],
    donors: [donor({
      upc: "036000291452",
      title: "Acme Crunch Chips Barbecue Bag 8 oz",
    })],
  });
  const result = compile(value).scopes[0].components[0];
  assert.equal(result.qty, 4);
  assert.equal(result.identityProof, "NONE");
  assert.equal(result.disposition, "QUARANTINE");
  assert.equal(result.matcherVerdict, "REJECT");
});

test("missing product identity and orphan donor fail closed", () => {
  const missing = snapshot({
    listings: [{ ...snapshot().listings[0], productIdentityJson: null }],
  });
  assert.deepEqual(
    compile(missing).scopes[0].blockers.map((item) => item.code),
    ["PRODUCT_IDENTITY_MISSING"],
  );

  const orphan = snapshot({ donors: [] });
  assert.equal(compile(orphan).scopes[0].components[0].blockers[0].code, "LEGACY_DONOR_ORPHANED");
});

test("bundle component brand must be explicit in the preserved identity", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Our Bundle",
        product_line: "Snack Box",
        is_bundle: true,
        components: [{
          product: "Crunch Chips",
          flavor: "Barbecue",
          size: "8 oz",
          qty: 2,
        }],
      }),
    }],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].components[0].disposition, "QUARANTINE");
  assert.ok(
    plan.scopes[0].components[0].blockers.some(
      (item) => item.code === "BUNDLE_COMPONENT_BRAND_UNPROVEN",
    ),
  );
});

test("regional and club offers are not silently promoted", () => {
  const regional = snapshot({
    offers: [offer({ retailer: "publix", zip: "00000" })],
  });
  assert.equal(
    compile(regional).scopes[0].components[0].disposition,
    "EXACT_CONTENT_ONLY_CANDIDATE",
  );
  const club = snapshot({
    offers: [offer({ retailer: "costco" })],
  });
  assert.equal(
    compile(club).scopes[0].components[0].disposition,
    "EXACT_IDENTITY_ONLY_CANDIDATE",
  );
});

test("current exact content evidence is classified as already canonical", () => {
  const base = snapshot();
  const targetVariantId = compile(base).scopes[0].components[0].targetVariant?.canonicalVariantId;
  assert.ok(targetVariantId);
  const plan = compile(snapshot({
    canonicalDonorBindings: [{
      donorProductId: "donor-1",
      canonicalVariantId: targetVariantId,
      decisionId: "decision-1",
      decisionStatus: "exact_confirmed",
      decidedAt: "2026-07-26T11:30:00.000Z",
    }],
    canonicalListingComponents: [{
      listingKey: "ptls1:test",
      skuCostId: "cost-1",
      componentIndex: 0,
      evidenceStatus: "REJECT",
      targetCanonicalVariantId: targetVariantId,
      contentCanonicalVariantId: targetVariantId,
      contentObservationId: "content-1",
      observedContentCanonicalVariantId: targetVariantId,
      decisionStatus: "exact_confirmed",
      decisionCanonicalVariantId: targetVariantId,
    }],
  }));
  assert.equal(plan.scopes[0].disposition, "ALREADY_CANONICAL");
  assert.equal(plan.scopes[0].writeEligible, false);
  assert.equal(plan.scopes[0].components[0].disposition, "ALREADY_CANONICAL");
  assert.equal(plan.counts.alreadyCanonicalListings, 1);
  assert.equal(plan.counts.alreadyCanonicalComponents, 1);
  assert.equal(plan.counts.exactCanonicalizationCandidates, 0);
});

test("an exact donor already bound to another variant fails closed", () => {
  const conflictingVariantId = `cpv1:${"f".repeat(64)}`;
  const plan = compile(snapshot({
    canonicalDonorBindings: [{
      donorProductId: "donor-1",
      canonicalVariantId: conflictingVariantId,
      decisionId: "decision-conflict",
      decisionStatus: "exact_confirmed",
      decidedAt: "2026-07-26T11:30:00.000Z",
    }],
  }));
  assert.equal(plan.scopes[0].disposition, "QUARANTINE");
  assert.ok(plan.scopes[0].components[0].blockers.some(
    (item) => item.code === "CANONICAL_DONOR_VARIANT_CONFLICT",
  ));
});

test("partial or mismatched current canonical evidence fails closed", () => {
  const targetVariantId = compile(snapshot()).scopes[0].components[0].targetVariant?.canonicalVariantId;
  assert.ok(targetVariantId);
  const plan = compile(snapshot({
    canonicalListingComponents: [{
      listingKey: "ptls1:test",
      skuCostId: "cost-1",
      componentIndex: 0,
      evidenceStatus: "REJECT",
      targetCanonicalVariantId: targetVariantId,
      contentCanonicalVariantId: targetVariantId,
      contentObservationId: "content-1",
      observedContentCanonicalVariantId: targetVariantId,
      decisionStatus: "rejected",
      decisionCanonicalVariantId: targetVariantId,
    }],
  }));
  assert.equal(plan.scopes[0].disposition, "QUARANTINE");
  assert.equal(plan.scopes[0].components[0].disposition, "QUARANTINE");
  assert.ok(plan.scopes[0].blockers.some(
    (item) => item.code === "CANONICAL_LISTING_STATE_INVALID",
  ));
});

test("canonical snapshot binding and plan bytes are deterministic", () => {
  const value = snapshot();
  const first = compile(value);
  const second = compile(value);
  assert.equal(renderProductTruthLegacyBridgePlan(first), renderProductTruthLegacyBridgePlan(second));

  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(value);
  assert.throws(
    () => compileProductTruthLegacyBridgePlan({
      snapshot: value,
      snapshotJson,
      snapshotSha256: "0".repeat(64),
      generatedAt: "2026-07-26T13:00:00.000Z",
    }),
    /LEGACY_BRIDGE_SNAPSHOT_SHA256_MISMATCH/,
  );
});
