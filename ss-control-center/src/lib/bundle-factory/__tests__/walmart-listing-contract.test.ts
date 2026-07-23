import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "@/lib/sourcing/canonical-product-match-provenance";

import {
  PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA,
  WALMART_PREPUBLICATION_EVIDENCE_SCHEMA,
  WALMART_PUBLIC_CONTRACT_SCHEMA,
  assertValidWalmartDistributionApproval,
  buildProductTruthListingManifest,
  mergeWalmartListingContracts,
  sealWalmartDistributionApproval,
  type ProductTruthRecipeComponentEvidence,
  type PublishableWalmartSkuInput,
  type WalmartPrepublicationEvidence,
  type WalmartPublicListingContract,
} from "@/lib/bundle-factory/walmart-listing-contract";

const component: ProductTruthRecipeComponentEvidence = {
  component_key: "variant-a",
  donor_product_id: "donor-a",
  canonical_variant_id: "canonical-a",
  variant_decision_id: "decision-a",
  product_name: "Example Strawberry Snack 1 oz",
  manufacturer_brand: "Example",
  manufacturer_upc: "012345678905",
  flavor: "Strawberry",
  qty: 2,
  content_role: "EXACT",
  content_observation_id: "content-a",
  content_source_url: "https://manufacturer.example/item-a",
  content_captured_at: "2026-07-18T12:00:00.000Z",
  matcher_version: CANONICAL_PRODUCT_MATCHER_VERSION,
  matcher_implementation_sha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  matcher_release_sha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  facts: {
    ingredients: "Corn, sugar, strawberry powder.",
    allergens: { contains: [], may_contain: [] },
    nutrition_facts: { calories: 100 },
    attributes: { flavor: "Strawberry" },
  },
  price_evidence: {
    role: "PRICE",
    observation_id: "price-a",
    donor_offer_id: "offer-a",
    match_tier: "EXACT_IDENTITY",
    retailer: "walmart",
    source_url: "https://www.walmart.com/ip/123456789",
    observed_at: "2026-07-19T11:00:00.000Z",
    locality_evidence: "zip_scoped",
    zip: "33765",
    first_party: true,
    in_stock: true,
    package_price: 4.99,
    pack_size_seen: 1,
    price_per_unit: 4.99,
  },
};

const staleMatcherProvenanceCases = [
  {
    field: "matcher_version",
    current: CANONICAL_PRODUCT_MATCHER_VERSION,
    stale: "canonical-product-match/0.0.0",
  },
  {
    field: "matcher_implementation_sha256",
    current: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
    stale: "1".repeat(64),
  },
  {
    field: "matcher_release_sha256",
    current: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    stale: "2".repeat(64),
  },
] as const;

const walmart: WalmartPublicListingContract = {
  contract_version: WALMART_PUBLIC_CONTRACT_SCHEMA,
  spec_version: "5.0.20260501-19_21_29-api",
  spec_schema_hash: "a".repeat(64),
  spec_fetched_at: "2026-07-19T11:30:00.000Z",
  product_type: "Snack Foods",
  country_of_origin_substantial_transformation: "United States",
  secondary_image_urls: ["https://images.example/secondary.jpg"],
  public_attributes: { multipackQuantity: 2, countPerPack: 1, count: 2 },
  offer_handoff: {
    mode: "STAGED_AFTER_ITEM_SETUP",
    quantity: 2,
    fulfillment_center_id: "FC-1",
    fulfillment_lag_time: 1,
  },
};

const prepublication: WalmartPrepublicationEvidence = {
  schema_version: WALMART_PREPUBLICATION_EVIDENCE_SCHEMA,
  policy_version: "walmart-us-prepublication/2026-07-23.4",
  generated_at: "2026-07-19T11:40:00.000Z",
  store_index: 1,
  sku: "SV-WM01-TEST",
  catalog_search: {
    searched_at: "2026-07-19T11:35:00.000Z",
    query_gtin: "756441000010",
    result: "NO_EXACT_MATCH",
    setup_method: "FULL_ITEM",
    walmart_item_id: null,
    evidence_ref: "catalog-search:test",
  },
  seller_account_health: {
    status: "HEALTHY_AND_ACCEPTING_NEW_ITEMS",
    store_index: 1,
    seller_account_fingerprint_sha256: "d".repeat(64),
    verified_at: "2026-07-19T11:36:00.000Z",
    evidence_ref: "seller-health:test",
  },
  fulfillment_compliance: {
    method: "SELLER_FULFILLED",
    inventory_owned_by_seller: true,
    direct_retailer_fulfillment: false,
    competitor_branded_packaging: false,
    third_party_promotional_materials: false,
    fulfillment_center_id: "FC-1",
    fulfillment_lag_time: 1,
    lag_exemption_status: "NOT_REQUIRED",
    verified_at: "2026-07-19T11:36:00.000Z",
    evidence_ref: "fulfillment:test",
  },
  category_approvals: [{
    scope: "SHELF_STABLE_FOOD",
    status: "NOT_REQUIRED",
    verified_at: "2026-07-19T11:36:00.000Z",
    evidence_ref: "category:test",
  }],
  sku_policy_review: {
    status: "CLEARED",
    reviewed_at: "2026-07-19T11:37:00.000Z",
    evidence_ref: "policy:test",
  },
  recall_check: {
    status: "CLEAR",
    checked_at: "2026-07-19T11:38:00.000Z",
    source: "official recall sources",
    evidence_ref: "recall:test",
  },
  brand_rights: {
    brand: "Example",
    basis: "LEGITIMATE_RESALE",
    verified_at: "2026-07-19T11:38:00.000Z",
    evidence_ref: "invoice:test",
  },
  product_identifier: {
    identifier_type: "UPC",
    value: "756441000010",
    checksum_valid: true,
    pool_acquired_from: "SpeedyBarcode",
    pool_recorded_owner: "Example Registrant LLC",
    registry_status: "VERIFIED",
    registry_registrant_name: "Example Registrant LLC",
    aligned_brand: "Example",
    brand_alignment_status: "VERIFIED",
    seller_account_fingerprint_sha256: "d".repeat(64),
    seller_assignment_authority_status: "VERIFIED",
    verified_at: "2026-07-19T11:38:00.000Z",
    evidence_ref: "product-id:test",
  },
  condition: { value: "New", verified_at: "2026-07-19T11:38:00.000Z" },
  expiration: {
    applicable: true,
    shelf_life_days: 180,
    minimum_days_remaining_at_ship: 90,
    lot_check_procedure_ref: "sop:test",
    source_ref: "label:test",
    verified_at: "2026-07-19T11:39:00.000Z",
  },
  item_spec: {
    feed_type: "MP_ITEM",
    version: walmart.spec_version,
    product_type: walmart.product_type,
    retrieved_at: walmart.spec_fetched_at,
    schema_sha256: walmart.spec_schema_hash,
    attributes_sha256: "b".repeat(64),
    required_attributes: ["productName"],
    missing_required_attributes: [],
    validation_status: "PASSED",
  },
};

function sku(attributes: string): PublishableWalmartSkuInput {
  return {
    id: "channel-sku-1",
    sku: "SV-WM01-TEST",
    channel: "WALMART",
    validation_check_id: "validation-run-1",
    upc: "756441000010",
    title: "Example Strawberry Snack, 1 oz, 2 Pack",
    bullets: JSON.stringify(["Two exact 1 oz retail units"]),
    description: "Two unopened Example Strawberry Snack 1 oz retail units.",
    price_cents: 1499,
    main_image_url: "https://images.example/main.jpg",
    package_weight_oz: 3,
    package_length_in: 8,
    package_width_in: 6,
    package_height_in: 3,
    attributes,
  };
}

test("builds a count-accurate exact Product Truth listing manifest", () => {
  const manifest = buildProductTruthListingManifest({
    sku: "SV-WM01-TEST",
    storeIndex: 1,
    verifiedAt: new Date("2026-07-19T11:30:00.000Z"),
    packCount: 2,
    components: [component],
    images: [{
      role: "MAIN",
      url: "https://images.example/main.jpg",
      depicted_component_keys: ["variant-a"],
      source_content_observation_ids: ["content-a"],
      represented_unit_count: 2,
      rights_basis: "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS",
      rights_evidence_ref: "image-run:test",
      reviewed_at: "2026-07-19T11:25:00.000Z",
    }],
  });
  assert.equal(manifest.schema_version, PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA);
  assert.match(manifest.recipe_hash, /^[a-f0-9]{64}$/);
  assert.throws(
    () => buildProductTruthListingManifest({
      sku: "SV-WM01-TEST",
      storeIndex: 1,
      verifiedAt: new Date("2026-07-19T11:30:00.000Z"),
      packCount: 3,
      components: [component],
      images: [],
    }),
    /recipe total 2 does not equal packCount 3/,
  );
});

test("matcher provenance fails closed at manifest build, approval seal, and publication validation", () => {
  const manifest = buildProductTruthListingManifest({
    sku: "SV-WM01-TEST",
    storeIndex: 1,
    verifiedAt: new Date("2026-07-19T11:30:00.000Z"),
    packCount: 2,
    components: [component],
    images: [{
      role: "MAIN",
      url: "https://images.example/main.jpg",
      depicted_component_keys: ["variant-a"],
      source_content_observation_ids: ["content-a"],
      represented_unit_count: 2,
      rights_basis: "SOURCE_ALLOWED",
      rights_evidence_ref: "rights:test",
      reviewed_at: "2026-07-19T11:25:00.000Z",
    }],
  });
  const attributes = mergeWalmartListingContracts("{}", {
    productTruth: manifest,
    walmart,
    prepublication,
  });
  const sealed = sealWalmartDistributionApproval({
    sku: sku(attributes),
    approvedAt: new Date("2026-07-19T12:00:00.000Z"),
    approvedBy: "Vladimir",
    validationRunId: "validation-run-1",
    marketplacePayloadSha256: "a".repeat(64),
  });

  for (const provenanceCase of staleMatcherProvenanceCases) {
    const expectedError = new RegExp(provenanceCase.field);
    assert.throws(
      () => buildProductTruthListingManifest({
        sku: "SV-WM01-TEST",
        storeIndex: 1,
        verifiedAt: new Date("2026-07-19T11:30:00.000Z"),
        packCount: 2,
        components: [{
          ...component,
          [provenanceCase.field]: provenanceCase.stale,
        }],
        images: manifest.images,
      }),
      expectedError,
    );

    const staleAttributes = attributes.replace(
      provenanceCase.current,
      provenanceCase.stale,
    );
    assert.notEqual(staleAttributes, attributes);
    assert.throws(
      () => sealWalmartDistributionApproval({
        sku: sku(staleAttributes),
        approvedAt: new Date("2026-07-19T12:00:00.000Z"),
        approvedBy: "Vladimir",
        validationRunId: "validation-run-1",
        marketplacePayloadSha256: "a".repeat(64),
      }),
      expectedError,
    );

    const staleSealedAttributes = sealed.attributes.replace(
      provenanceCase.current,
      provenanceCase.stale,
    );
    assert.notEqual(staleSealedAttributes, sealed.attributes);
    assert.throws(
      () => assertValidWalmartDistributionApproval(sku(staleSealedAttributes)),
      expectedError,
    );
  }
});

test("approval seals every publishable field and detects later drift", () => {
  const manifest = buildProductTruthListingManifest({
    sku: "SV-WM01-TEST",
    storeIndex: 1,
    verifiedAt: new Date("2026-07-19T11:30:00.000Z"),
    packCount: 2,
    components: [component],
    images: [{
      role: "MAIN",
      url: "https://images.example/main.jpg",
      depicted_component_keys: ["variant-a"],
      source_content_observation_ids: ["content-a"],
      represented_unit_count: 2,
      rights_basis: "SOURCE_ALLOWED",
      rights_evidence_ref: "rights:test",
      reviewed_at: "2026-07-19T11:25:00.000Z",
    }],
  });
  const attributes = mergeWalmartListingContracts("{}", {
    productTruth: manifest,
    walmart,
    prepublication,
  });
  const before = sku(attributes);
  const sealed = sealWalmartDistributionApproval({
    sku: before,
    approvedAt: new Date("2026-07-19T12:00:00.000Z"),
    approvedBy: "Vladimir",
    validationRunId: "validation-run-1",
    marketplacePayloadSha256: "a".repeat(64),
  });
  const approvedSku = sku(sealed.attributes);
  assert.equal(
    assertValidWalmartDistributionApproval(approvedSku).approved_by,
    "Vladimir",
  );

  assert.throws(
    () => assertValidWalmartDistributionApproval({
      ...approvedSku,
      price_cents: approvedSku.price_cents + 1,
    }),
    /changed after approval/,
  );

  assert.throws(
    () => assertValidWalmartDistributionApproval({
      ...approvedSku,
      validation_check_id: "validation-run-2",
    }),
    /current validation run/,
  );

  assert.throws(
    () => sealWalmartDistributionApproval({
      sku: before,
      approvedAt: new Date("2026-07-19T12:00:00.000Z"),
      approvedBy: "Vladimir",
      validationRunId: "validation-run-2",
      marketplacePayloadSha256: "a".repeat(64),
    }),
    /current ChannelSKU validation run/,
  );
});
