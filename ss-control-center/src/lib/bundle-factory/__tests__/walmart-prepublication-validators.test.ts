import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChannelSKU } from "@/generated/prisma/client";
import {
  WALMART_PREPUBLICATION_EVIDENCE_SCHEMA,
  WALMART_PUBLIC_CONTRACT_SCHEMA,
  buildProductTruthListingManifest,
  mergeWalmartListingContracts,
  parseWalmartListingAttributes,
  sha256WalmartJson,
  type ProductTruthRecipeComponentEvidence,
  type WalmartPrepublicationEvidence,
  type WalmartPublicListingContract,
} from "@/lib/bundle-factory/walmart-listing-contract";
import type { ValidatorInput } from "@/lib/bundle-factory/validation/types";
import {
  WALMART_POLICY_VERSION,
  WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
} from "@/lib/bundle-factory/validation/walmart-prepublication-policy";
import { validatorWalmartItemType } from "@/lib/bundle-factory/validation/validators/validator-walmart-item-type";
import { validatorBrandField } from "@/lib/bundle-factory/validation/validators/validator-brand-field";
import { validatorRecipeContent } from "@/lib/bundle-factory/validation/validators/validator-recipe-content";
import { validatorCanonicalPrice } from "@/lib/bundle-factory/validation/validators/validator-canonical-price";
import { validatorComplianceRerun } from "@/lib/bundle-factory/validation/validators/validator-compliance-rerun";
import { validatorWalmartPrepublication } from "@/lib/bundle-factory/validation/validators/validator-walmart-prepublication";
import { validatorWalmartProductTruth } from "@/lib/bundle-factory/validation/validators/validator-walmart-product-truth";
import { validatorWalmartStaticPolicy } from "@/lib/bundle-factory/validation/validators/validator-walmart-static-policy";

function recent(hoursAgo = 1): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1_000).toISOString();
}

function sku(attributes: string): ChannelSKU {
  const now = new Date();
  return {
    id: "channel-sku-walmart-pilot",
    master_bundle_id: "master-walmart-pilot",
    channel: "WALMART",
    brand_account_id: "brand-account-walmart",
    sku: "SV-WM01-TEST",
    upc: "756441000010",
    upc_pool_id: "upc-pool-1",
    asin: null,
    walmart_item_id: null,
    ebay_item_id: null,
    tiktok_product_id: null,
    title: "Example Strawberry Snack 1 oz, 2 Pack",
    bullets: JSON.stringify(["Two unopened 1 oz retail units."]),
    description: "Two unopened Example Strawberry Snack 1 oz retail units.",
    search_terms: null,
    attributes,
    channel_category: "Food",
    channel_browse_node: null,
    price_cents: 1499,
    business_price_cents: null,
    lifecycle_status: "DRAFT",
    submitted_at: null,
    processing_at: null,
    live_at: null,
    live_url: null,
    last_error_at: null,
    errors: null,
    units_sold_30d: 0,
    revenue_30d_cents: 0,
    compliance_status: "CAN_PUBLISH",
    compliance_check_id: null,
    compliance_blocked_at: null,
    compliance_blocked_reasons: null,
    main_image_url: "https://images.example/main.jpg",
    validation_status: "PENDING",
    validation_errors: null,
    validated_at: null,
    validation_check_id: null,
    validation_attempt_count: 0,
    available_quantity: null,
    inventory_checked_at: null,
    package_length_in: 8,
    package_width_in: 6,
    package_height_in: 3,
    package_weight_oz: 3,
    country_of_origin: "US",
    item_type: "Snack Foods",
    listing_status: "PENDING",
    submission_id: null,
    published_at: null,
    distribution_errors: null,
    distribution_attempt_count: 0,
    last_status_check_at: null,
    created_at: now,
    updated_at: now,
  };
}

function fixture(): ValidatorInput {
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
    content_captured_at: recent(24),
    matcher_version: "canonical-product-match/1.2.0",
    facts: {
      ingredients: "Corn, sugar, strawberry powder.",
      allergens: { contains: [], may_contain: [] },
      nutrition_facts: { calories: 100 },
      attributes: { flavor: "Strawberry" },
    },
    price_evidence: {
      role: "PRICE",
      observation_id: "offer-observation-a",
      donor_offer_id: "offer-a",
      match_tier: "EXACT_IDENTITY",
      retailer: "walmart",
      source_url: "https://www.walmart.com/ip/123456789",
      observed_at: recent(1),
      locality_evidence: "zip_scoped",
      zip: "33765",
      first_party: true,
      in_stock: true,
      package_price: 4.99,
      pack_size_seen: 1,
      price_per_unit: 4.99,
    },
  };
  const productTruth = buildProductTruthListingManifest({
    sku: "SV-WM01-TEST",
    storeIndex: 1,
    verifiedAt: new Date(recent(1)),
    packCount: 2,
    components: [component],
    images: [{
      role: "MAIN",
      url: "https://images.example/main.jpg",
      depicted_component_keys: ["variant-a"],
      source_content_observation_ids: ["content-a"],
      represented_unit_count: 2,
      rights_basis: "AI_DERIVED_FROM_RIGHTS_CLEARED_INPUTS",
      rights_evidence_ref: "image-run:pilot",
      reviewed_at: recent(1),
    }, {
      role: "SECONDARY",
      url: "https://images.example/secondary.jpg",
      depicted_component_keys: ["variant-a"],
      source_content_observation_ids: ["content-a"],
      represented_unit_count: 2,
      rights_basis: "SOURCE_ALLOWED",
      rights_evidence_ref: "image-source:pilot-secondary",
      reviewed_at: recent(1),
    }],
  });
  const publicAttributes = {
    multipackQuantity: 2,
    countPerPack: 1,
    count: 2,
    condition: "New",
  };
  const walmart: WalmartPublicListingContract = {
    contract_version: WALMART_PUBLIC_CONTRACT_SCHEMA,
    spec_version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
    spec_schema_hash: "a".repeat(64),
    spec_fetched_at: recent(1),
    product_type: "Snack Foods",
    country_of_origin_substantial_transformation: "United States",
    secondary_image_urls: ["https://images.example/secondary.jpg"],
    public_attributes: publicAttributes,
    offer_handoff: {
      mode: "STAGED_AFTER_ITEM_SETUP",
      quantity: 2,
      fulfillment_center_id: "FC-1",
      fulfillment_lag_time: 1,
    },
  };
  const prepublication: WalmartPrepublicationEvidence = {
    schema_version: WALMART_PREPUBLICATION_EVIDENCE_SCHEMA,
    policy_version: WALMART_POLICY_VERSION,
    generated_at: recent(0.5),
    store_index: 1,
    sku: "SV-WM01-TEST",
    catalog_search: {
      searched_at: recent(0.5),
      query_gtin: "756441000010",
      result: "NO_EXACT_MATCH",
      setup_method: "FULL_ITEM",
      walmart_item_id: null,
      evidence_ref: "catalog-search:pilot",
    },
    category_approvals: [{
      scope: "INGESTIBLE_PRODUCTS",
      status: "APPROVED",
      verified_at: recent(24),
      evidence_ref: "seller-center:ingestible-approved",
    }],
    sku_policy_review: {
      status: "CLEARED",
      reviewed_at: recent(1),
      evidence_ref: "policy-review:pilot",
    },
    recall_check: {
      status: "CLEAR",
      checked_at: recent(0.5),
      source: "official recall sources",
      evidence_ref: "recall-check:pilot",
    },
    brand_rights: {
      brand: "Example",
      basis: "BRAND_OWNER",
      verified_at: recent(24),
      evidence_ref: "brand-portal:example",
    },
    condition: { value: "New", verified_at: recent(1) },
    expiration: {
      applicable: true,
      shelf_life_days: 180,
      minimum_days_remaining_at_ship: 90,
      lot_check_procedure_ref: "sop:expiration-lot-check",
      source_ref: "manufacturer-label:item-a",
      verified_at: recent(24),
    },
    item_spec: {
      feed_type: "MP_ITEM",
      version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
      product_type: "Snack Foods",
      retrieved_at: walmart.spec_fetched_at,
      schema_sha256: walmart.spec_schema_hash,
      attributes_sha256: sha256WalmartJson(publicAttributes),
      required_attributes: [
        "productName",
        "brand",
        "mainImageUrl",
        "countryOfOriginSubstantialTransformation",
        "multipackQuantity",
        "countPerPack",
        "count",
        "condition",
      ],
      missing_required_attributes: [],
      validation_status: "PASSED",
    },
  };
  const attributes = mergeWalmartListingContracts("{}", {
    productTruth,
    walmart,
    prepublication,
  });
  return {
    sku: sku(attributes),
    master_bundle: {
      id: "master-walmart-pilot",
      brand: "Example",
      category: "SHELF_STABLE_GROCERY",
      packaging_spec: "{}",
      cost_breakdown: "{}",
      pack_count: 2,
      suggested_price_cents: 1499,
      total_weight_oz: 3,
      main_image_url: "https://images.example/main.jpg",
      estimated_cost_cents: 499,
    },
    bundle_components: [{
      id: "bundle-component-a",
      product_name: component.product_name,
      manufacturer_brand: component.manufacturer_brand,
      manufacturer_upc: component.manufacturer_upc,
      flavor: component.flavor,
      qty: component.qty,
      source_url: component.content_source_url,
      ingredients: component.facts.ingredients,
      allergens: JSON.stringify(component.facts.allergens),
      storage_temp: "Shelf-stable",
      expiration_days: 180,
      donor_image_urls: JSON.stringify(["https://images.example/source-a.jpg"]),
    }],
    draft_brand: "Example",
    margin_floor_pct: 0.2,
  };
}

function mutate(
  input: ValidatorInput,
  fn: (root: ReturnType<typeof parseWalmartListingAttributes>) => void,
): ValidatorInput {
  const root = parseWalmartListingAttributes(input.sku.attributes);
  fn(root);
  return { ...input, sku: { ...input.sku, attributes: JSON.stringify(root) } };
}

test("complete Walmart pilot evidence passes all three new gates", async () => {
  const input = fixture();
  assert.equal((await validatorWalmartProductTruth(input)).passed, true);
  assert.equal((await validatorWalmartStaticPolicy(input)).passed, true);
  assert.equal((await validatorWalmartPrepublication(input)).passed, true);
  assert.equal((await validatorBrandField(input)).passed, true);
  assert.equal((await validatorRecipeContent(input)).passed, true);
  assert.equal((await validatorCanonicalPrice(input)).passed, true);
  const legacyGate = await validatorComplianceRerun(input);
  assert.equal(legacyGate.passed, true);
  assert.equal(legacyGate.details?.reason, "dedicated_walmart_compliance_gates");
  const itemType = await validatorWalmartItemType(input);
  assert.equal(itemType.passed, true);
  assert.equal(itemType.details?.source, "versioned_get_spec_evidence");
});

test("Walmart manufacturer brand requires matching truth, recipe and rights", async () => {
  const valid = await validatorBrandField(fixture());
  assert.equal(valid.passed, true);
  assert.equal(valid.details?.source, "walmart_exact_brand_rights");

  const mismatch = mutate(fixture(), (root) => {
    root.walmart_prepublication!.brand_rights.brand = "Another Brand";
  });
  const rejected = await validatorBrandField(mismatch);
  assert.equal(rejected.passed, false);
  assert.match(rejected.message ?? "", /brand-rights/);
});

test("Walmart recipe gate reads and cross-checks the public quantity trio", async () => {
  assert.equal((await validatorRecipeContent(fixture())).passed, true);
  const netWeightBeforePack = fixture();
  netWeightBeforePack.sku.title = "Example Strawberry Snack 8 oz (Pack of 2)";
  assert.equal((await validatorRecipeContent(netWeightBeforePack)).passed, true);
  const drift = mutate(fixture(), (root) => {
    root.walmart!.public_attributes.count = 4;
  });
  const rejected = await validatorRecipeContent(drift);
  assert.equal(rejected.passed, false);
  assert.match(rejected.message ?? "", /quantity trio|pack_count/);
});

test("Product Truth fails closed on content-role, price and MAIN count drift", async () => {
  const badContent = mutate(fixture(), (root) => {
    (root.product_truth_manifest!.components[0] as { content_role: string }).content_role = "PRICE";
  });
  assert.match((await validatorWalmartProductTruth(badContent)).message ?? "", /content_role/);

  const stalePrice = mutate(fixture(), (root) => {
    root.product_truth_manifest!.components[0].price_evidence.observed_at = recent(24 * 8);
  });
  assert.match((await validatorWalmartProductTruth(stalePrice)).message ?? "", /stale/);

  const wrongCount = mutate(fixture(), (root) => {
    root.product_truth_manifest!.images[0].represented_unit_count = 1;
  });
  assert.match((await validatorWalmartProductTruth(wrongCount)).message ?? "", /MAIN represents/);
});

test("Product Truth requires evidence for every public Walmart image URL", async () => {
  const missingSecondaryEvidence = mutate(fixture(), (root) => {
    root.product_truth_manifest!.images = root.product_truth_manifest!.images.filter(
      (image) => image.role === "MAIN",
    );
  });
  assert.match(
    (await validatorWalmartProductTruth(missingSecondaryEvidence)).message ?? "",
    /secondary image.*evidence row/,
  );

  const queryUrl = mutate(fixture(), (root) => {
    root.product_truth_manifest!.images[0].url =
      "https://images.example/main.jpg?cache=1";
    root.walmart!.secondary_image_urls = [
      "https://images.example/secondary.jpg?cache=1",
    ];
  });
  assert.match(
    (await validatorWalmartProductTruth(queryUrl)).message ?? "",
    /query-free HTTPS JPEG\/PNG/,
  );
});

test("Walmart gates fail closed when versioned contracts are absent", async () => {
  const input = fixture();
  input.sku = { ...input.sku, attributes: "{}" };
  assert.equal((await validatorWalmartProductTruth(input)).passed, false);
  assert.equal((await validatorWalmartPrepublication(input)).passed, false);
  assert.equal((await validatorBrandField(input)).passed, false);
});

test("static policy screening blocks prohibited signals and does not claim approval", async () => {
  const input = fixture();
  input.bundle_components[0].ingredients = "Sugar, CBD isolate";
  const blocked = await validatorWalmartStaticPolicy(input);
  assert.equal(blocked.passed, false);
  assert.match(blocked.message ?? "", /cannabis-cbd-thc/);

  const clean = await validatorWalmartStaticPolicy(fixture());
  assert.equal(clean.passed, true);
  assert.equal(clean.details?.screen_is_not_approval, true);
});

test("prepublication fails without ingestible approval, New condition or brand rights", async () => {
  const noApproval = mutate(fixture(), (root) => {
    root.walmart_prepublication!.category_approvals[0].status = "NOT_REQUIRED";
  });
  assert.match((await validatorWalmartPrepublication(noApproval)).message ?? "", /INGESTIBLE_PRODUCTS/);

  const used = mutate(fixture(), (root) => {
    (root.walmart_prepublication!.condition as { value: string }).value = "Used";
  });
  assert.match((await validatorWalmartPrepublication(used)).message ?? "", /condition/);

  const resaleFullItem = mutate(fixture(), (root) => {
    root.walmart_prepublication!.brand_rights.basis = "LEGITIMATE_RESALE";
  });
  assert.match((await validatorWalmartPrepublication(resaleFullItem)).message ?? "", /FULL_ITEM/);
});

test("initial pilot hard-blocks exact catalog matches until MP_ITEM_MATCH exists", async () => {
  const exactMatch = mutate(fixture(), (root) => {
    root.walmart_prepublication!.catalog_search.result = "EXACT_MATCH";
    root.walmart_prepublication!.catalog_search.setup_method = "MATCH_EXISTING";
    root.walmart_prepublication!.catalog_search.walmart_item_id = "123456789";
  });
  const rejected = await validatorWalmartPrepublication(exactMatch);
  assert.equal(rejected.passed, false);
  assert.match(rejected.message ?? "", /blocks EXACT_MATCH.*MP_ITEM_MATCH/);
});

test("prepublication fails on stale/wrong spec, required attributes and shelf life", async () => {
  const oldSpec = mutate(fixture(), (root) => {
    root.walmart_prepublication!.item_spec.version = "4.7";
    root.walmart!.spec_version = "4.7";
  });
  assert.match((await validatorWalmartPrepublication(oldSpec)).message ?? "", /5\.0\.20260501/);

  const missing = mutate(fixture(), (root) => {
    root.walmart_prepublication!.item_spec.required_attributes.push("ingredients");
  });
  assert.match((await validatorWalmartPrepublication(missing)).message ?? "", /ingredients/);

  const shortLife = mutate(fixture(), (root) => {
    root.walmart_prepublication!.expiration.minimum_days_remaining_at_ship = 20;
  });
  assert.match((await validatorWalmartPrepublication(shortLife)).message ?? "", /below 30 days/);
});

test("new gates skip non-Walmart channels", async () => {
  const input = fixture();
  input.sku = { ...input.sku, channel: "AMAZON_SALUTEM", attributes: "{}" };
  assert.equal((await validatorWalmartProductTruth(input)).passed, true);
  assert.equal((await validatorWalmartStaticPolicy(input)).passed, true);
  assert.equal((await validatorWalmartPrepublication(input)).passed, true);
});
