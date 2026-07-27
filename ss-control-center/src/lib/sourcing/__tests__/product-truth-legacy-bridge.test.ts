import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  compileProductTruthLegacyBridgePlan,
  productTruthLegacyBridgeBytesSha256,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeComponentRow,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";

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
