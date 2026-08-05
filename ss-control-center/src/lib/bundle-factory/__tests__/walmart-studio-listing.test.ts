import assert from "node:assert/strict";
import test from "node:test";

import {
  WALMART_STUDIO_DECLARED_INVENTORY_UNITS,
  WALMART_STUDIO_LISTING_LANE,
  buildWalmartStudioListingEvidence,
  buildWalmartStudioPublicAttributes,
  estimateWalmartStudioShippingPackage,
  isWalmartStudioLane,
  packageArtworkRevisionId,
  resolveWalmartStudioProductType,
  walmartStudioDisplayBrand,
  walmartStudioDisplayFlavor,
} from "../walmart-studio-listing";

// The exact Campbell's component the factory built the five live drafts from.
const COMPONENT = {
  component_key: "component-0-cpv1:f44ab538",
  donor_product_id: "925b3e13-41d5-4a62-90b1-1c765a36857a",
  canonical_variant_id: "cpv1:f44ab538",
  variant_decision_id: "dpvd:91ea2030",
  product_name:
    "Campbell's Chunky Soup, Ready to Serve Baked Potato with Steak and Cheese Soup, 18.8 oz Can",
  flavor: "and baked cheese potato steak with",
  qty: 8,
  content_role: "EXACT",
  content_observation_id: "pco:6bab6d4a",
  content_source_url: "https://www.walmart.com/ip/10321387",
  content_captured_at: "2026-07-10T12:27:13.918Z",
  matcher_version: "canonical-product-match/1.2.1",
  price_evidence: {
    eligibility: "FACT",
    observation_id: "doo:185ef269",
    donor_offer_id: "do:walmart:10321387",
    retailer: "walmart",
    observed_at: "2026-08-02T01:26:36.648Z",
    locality_evidence: "zip_scoped",
    zip: "33765",
    price_per_unit: 2.26,
  },
};

const MAIN_IMAGE = {
  role: "MAIN" as const,
  url: "https://pub-6394.r2.dev/walmart-new-sku/draft-main/bcc12f5e.png",
  output_sha256: "b".repeat(64),
  source_asset_sha256s: ["a".repeat(64)],
  represented_unit_count: 8,
  construction_method: "DETERMINISTIC_EXACT_PIXEL_MULTIPACK" as const,
  exact_source_url: "https://i5.walmartimages.com/seo/campbells.jpeg",
};

test("declares the buy-to-order quantity the owner set", () => {
  // Owner 2026-08-02: 50 units per position on every ship node, because the
  // business holds no stock and buys at the moment of sale.
  assert.equal(WALMART_STUDIO_DECLARED_INVENTORY_UNITS, 50);
  const attributes = buildWalmartStudioPublicAttributes({
    packCount: 8,
    productType: "Prepared & Packaged Soups",
    countryOfOrigin: "US",
    secondaryImageUrls: [],
    fulfillmentCenterId: null,
    declaredQuantity: WALMART_STUDIO_DECLARED_INVENTORY_UNITS,
    // Walmart's required set for creating a food item; facts about the
    // product, not choices.
    containerMaterial: ["Metal"],
    foodCondition: ["Shelf-Stable"],
    ingredientListImageUrl: "https://example.test/ingredients.png",
    netContent: { unit: "Gram", measure: 532.971 },
  });
  const offer = attributes.offer_handoff as { quantity: number };
  assert.equal(offer.quantity, 50);
  // The quantity trio Walmart's spec wants: 8 retail packages, one item each.
  // Asserted field by field — the block also carries the required food fields
  // (condition, Prop 65, container, ingredient image, net content), and pinning
  // the whole object would break every time that required set grows.
  const publicAttributes = attributes.public_attributes as Record<string, unknown>;
  assert.equal(publicAttributes.multipackQuantity, 8);
  assert.equal(publicAttributes.countPerPack, 1);
  assert.equal(publicAttributes.count, 8);
});

test("resolves the product type from Walmart's live taxonomy list", () => {
  assert.equal(
    resolveWalmartStudioProductType({
      product_name: COMPONENT.product_name,
      flavor: COMPONENT.flavor,
    }),
    "Prepared & Packaged Soups",
  );
  // An unmapped product must return null so the validator can say which
  // product type is missing — never a guessed taxonomy slug.
  assert.equal(
    resolveWalmartStudioProductType({ product_name: "Ritz Bits Crackers" }),
    null,
  );
});

test("declares a shipping package anchored on the exact net mass", () => {
  const spec = estimateWalmartStudioShippingPackage({
    sizeDimension: "MASS",
    sizeBaseAmount: 532.97103475, // 18.8 oz, from Product Truth
    sizeBaseUnit: "g",
    packCount: 8,
  });
  // 8 × 18.8 oz net = 150.4 oz; the declared weight adds retail tare and the
  // corrugated box, so it must exceed net but stay in a sane range.
  assert.ok(spec.package_weight_oz > 150.4, "declared weight covers net mass");
  assert.ok(spec.package_weight_oz < 200, "declared weight is not inflated");
  assert.ok(spec.package_length_in > 0 && spec.package_height_in > 0);
  assert.equal(spec.basis, "ESTIMATED_FROM_EXACT_NET_MASS");

  // Without an exact mass there is nothing to anchor on, so it refuses
  // rather than shipping a category average.
  assert.throws(
    () => estimateWalmartStudioShippingPackage({
      sizeDimension: "COUNT",
      sizeBaseAmount: 8,
      sizeBaseUnit: "count",
      packCount: 8,
    }),
    /no exact net mass/i,
  );
});

test("evidence carries the whole chain and refuses a mismatched image", () => {
  const evidence = buildWalmartStudioListingEvidence({
    sku: "CM-WM04-AB12",
    storeIndex: 1,
    packCount: 8,
    verifiedAt: new Date("2026-08-02T16:00:00.000Z"),
    component: COMPONENT,
    images: [MAIN_IMAGE],
    shippingTemplateId: "AN-WMB4-DL59",
    fulfillmentCenterId: null,
    declaredQuantity: 50,
  });
  const identity = evidence.identity as Record<string, unknown>;
  const content = evidence.content as Record<string, unknown>;
  const price = evidence.price as Record<string, unknown>;
  assert.equal(identity.canonical_variant_id, COMPONENT.canonical_variant_id);
  assert.equal(content.observation_id, COMPONENT.content_observation_id);
  assert.equal(price.observation_id, COMPONENT.price_evidence.observation_id);
  assert.equal(evidence.lane, WALMART_STUDIO_LISTING_LANE);

  // A main image that does not show the number of units being sold is the
  // exact defect that put wrong-product tiles live; it must not pass.
  assert.throws(
    () => buildWalmartStudioListingEvidence({
      sku: "CM-WM04-AB12",
      storeIndex: 1,
      packCount: 8,
      verifiedAt: new Date("2026-08-02T16:00:00.000Z"),
      component: COMPONENT,
      images: [{ ...MAIN_IMAGE, represented_unit_count: 6 }],
      shippingTemplateId: null,
      fulfillmentCenterId: null,
      declaredQuantity: 50,
    }),
    /represents 6 units/,
  );
});

test("the lane marker is what separates studio SKUs from the frozen pilot", () => {
  assert.equal(
    isWalmartStudioLane(JSON.stringify({ listing_lane: WALMART_STUDIO_LISTING_LANE })),
    true,
  );
  assert.equal(isWalmartStudioLane(JSON.stringify({ walmart: {} })), false);
  assert.equal(isWalmartStudioLane(null), false);
  assert.equal(isWalmartStudioLane("not json"), false);
});

test("packaging artwork revision is stable and digest-derived", () => {
  const first = packageArtworkRevisionId(["a".repeat(64), "b".repeat(64)]);
  const second = packageArtworkRevisionId(["b".repeat(64), "a".repeat(64)]);
  assert.match(first, /^par1:[a-f0-9]{64}$/);
  assert.equal(first, second, "order of source assets must not change the id");
});

test("shows the manufacturer's own brand and flavor, not the hashing tokens", () => {
  // component.flavor / manufacturer_brand are canonical identity keys built for
  // hashing. Shipping them as prose produced "Same campbells product" and
  // "Exact flavor or variant: chicken pie pot pub style" on real drafts.
  const component = {
    manufacturer_brand: "campbells",
    flavor: "chicken pie pot pub style",
    content_provenance: {
      decision_evidence: {
        targetIdentity: { brand: "Campbell'S", flavor: "Pub-Style Chicken Pot Pie" },
      },
    },
  };
  assert.equal(walmartStudioDisplayFlavor(component), "Pub-Style Chicken Pot Pie");
  // The legacy bridge title-cases across the apostrophe; that artifact is
  // repaired, and nothing else about the recorded brand changes.
  assert.equal(walmartStudioDisplayBrand(component), "Campbell's");

  // With no declared flavor the listing says nothing rather than inventing one
  // — the exact product name in the title already carries the variant.
  assert.equal(
    walmartStudioDisplayFlavor({ flavor: "england clam chowder new" }),
    null,
  );
  assert.equal(
    walmartStudioDisplayBrand({ manufacturer_brand: "campbells" }),
    "campbells",
  );
});
