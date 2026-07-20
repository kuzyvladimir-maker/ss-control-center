// Phase 2.5 Stage 7 — payload builder unit tests for the Amazon and
// Walmart publish modules. Pure functions, no I/O.
//
// Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/distribution-payloads.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import type { ChannelSKU } from "@/generated/prisma/client";
import {
  AMAZON_VALIDATION_PREVIEW_REQUIRED,
  UNCRUSTABLES_EXISTING_LISTING_REQUIRES_SURGICAL_PATCH,
  buildAmazonAttributes,
  buildAmazonPayload,
  submitToAmazon,
} from "@/lib/bundle-factory/distribution/amazon-publish";
import {
  buildWalmartMultipartBody,
  buildWalmartPayload,
  submitToWalmart,
} from "@/lib/bundle-factory/distribution/walmart-publish";
import { channelTarget } from "@/lib/bundle-factory/distribution/account-map";
import {
  VERIFIED_PHYSICAL_PACKAGE_SCHEMA,
  type VerifiedPhysicalPackageSpecs,
} from "@/lib/bundle-factory/physical-package-specs";
import {
  sha256WalmartJson,
  WALMART_PUBLIC_CONTRACT_SCHEMA,
  type WalmartPublicListingContract,
} from "@/lib/bundle-factory/walmart-listing-contract";
import { WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION } from
  "@/lib/bundle-factory/validation/walmart-prepublication-policy";
import {
  assembleWalmartOwnerPermit,
  buildWalmartOwnerPermitSigningRequest,
} from "@/lib/bundle-factory/walmart-owner-permit";
import { hashWalmartPayload } from
  "@/lib/bundle-factory/distribution/walmart-payload-hash";

const OWNER_KEYS = generateKeyPairSync("ed25519");
const OWNER_PUBLIC_DER = OWNER_KEYS.publicKey.export({
  format: "der",
  type: "spki",
}) as Buffer;
Object.assign(process.env, {
  NODE_ENV: "test",
  WALMART_NEW_SKU_TEST_MODE: "1",
  WALMART_API_BASE_URL: "https://walmart.fixture.test",
  WALMART_NEW_SKU_TEST_OWNER_KEY_ID: "owner-payload-fixture-key",
  WALMART_NEW_SKU_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64:
    OWNER_PUBLIC_DER.toString("base64"),
});

const VERIFIED_PHYSICAL: VerifiedPhysicalPackageSpecs = {
  schema_version: VERIFIED_PHYSICAL_PACKAGE_SCHEMA,
  source: "OPERATOR_SHIP_SPECS",
  verified_at: "2026-07-17T12:00:00.000Z",
  weight_oz: 32,
  length_in: 14,
  width_in: 10,
  height_in: 6,
};

function mkSku(overrides: Partial<ChannelSKU> = {}): ChannelSKU {
  const now = new Date();
  return {
    id: "sku_test",
    master_bundle_id: "mb_test",
    channel: "AMAZON_SALUTEM",
    brand_account_id: null,
    sku: "SV-AS01-A1B2",
    upc: "012345678905",
    upc_pool_id: null,
    asin: null,
    walmart_item_id: null,
    ebay_item_id: null,
    tiktok_product_id: null,
    title: "Salutem Vita Curated Refrigerated Lunch Variety Gift Basket Pack of 9",
    bullets: JSON.stringify([
      "Includes nine single-serve refrigerated lunch trays.",
      "Refrigerator-stable until the printed use-by date.",
      "Curated and assembled by Salutem Solutions LLC as a gift basket.",
    ]),
    description: "Variety pack of nine single-serve lunches.",
    search_terms: null,
    attributes: "{}",
    channel_category: null,
    channel_browse_node: "12011207011",
    price_cents: 0,
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
    main_image_url: "https://example.com/main.png",
    validation_status: "PASSED",
    validation_errors: null,
    validated_at: now,
    validation_check_id: null,
    validation_attempt_count: 1,
    available_quantity: 7,
    inventory_checked_at: now,
    package_length_in: 14,
    package_width_in: 10,
    package_height_in: 6,
    package_weight_oz: 32,
    country_of_origin: "US",
    item_type: "Refrigerated Lunches",
    listing_status: "PENDING",
    submission_id: null,
    published_at: null,
    distribution_errors: null,
    distribution_attempt_count: 0,
    last_status_check_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ── Amazon attribute builder ──────────────────────────────────────────

test("buildAmazonAttributes — required fields present", () => {
  const attrs = buildAmazonAttributes(
    mkSku(),
    undefined,
    undefined,
    VERIFIED_PHYSICAL,
  );
  assert.ok(Array.isArray(attrs.item_name));
  assert.ok(Array.isArray(attrs.bullet_point));
  assert.equal((attrs.bullet_point as unknown[]).length, 3);
  assert.ok(Array.isArray(attrs.product_description));
  assert.ok(Array.isArray(attrs.main_product_image_locator));
  assert.ok(Array.isArray(attrs.externally_assigned_product_identifier));
  assert.ok(Array.isArray(attrs.item_package_dimensions));
  assert.ok(Array.isArray(attrs.item_package_weight));
  assert.ok(Array.isArray(attrs.country_of_origin));
});

test("buildAmazonAttributes — UPC carries type=upc + marketplace_id", () => {
  const attrs = buildAmazonAttributes(mkSku({ upc: "012345678905" }));
  const id = (attrs.externally_assigned_product_identifier as Array<{ type: string; value: string; marketplace_id: string }>)[0];
  assert.equal(id.type, "upc");
  assert.equal(id.value, "012345678905");
  assert.ok(id.marketplace_id.length > 0);
});

test("buildAmazonAttributes — omits image block when main_image_url is null", () => {
  const attrs = buildAmazonAttributes(mkSku({ main_image_url: null }));
  assert.equal(attrs.main_product_image_locator, undefined);
});

test("buildAmazonAttributes — structured count wins and inventory is derived", () => {
  const attrs = buildAmazonAttributes(mkSku({
    title: "Uncrustables Strawberry, 4 ct, Pack of 45",
    attributes: JSON.stringify({ number_of_items: [{ value: 45 }] }),
    available_quantity: 7,
  }), "Uncrustables", "FROZEN_GROCERY");
  assert.equal((attrs.unit_count as Array<{ value: number }>)[0].value, 45);
  assert.equal(attrs.each_unit_count, undefined);
  assert.equal(
    (attrs.fulfillment_availability as Array<{ quantity: number }>)[0].quantity,
    7,
  );
});

test("buildAmazonAttributes — Uncrustables ignores stale DB price and seals the canonical offer", () => {
  const attrs = buildAmazonAttributes(mkSku({
    price_cents: 999,
    attributes: JSON.stringify({
      number_of_items: [{ value: 45 }],
      list_price: [{ value: 199.99, currency: "USD" }],
      purchasable_offer: [{
        discounted_price: [{ schedule: [{ value_with_tax: 9.99 }] }],
        minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 1 }] }],
        maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 999 }] }],
      }],
    }),
  }), "Uncrustables", "FROZEN_GROCERY");
  const offer = (attrs.purchasable_offer as Array<Record<string, unknown>>)[0];
  const scheduled = (key: string) =>
    ((offer[key] as Array<{ schedule: Array<{ value_with_tax: number }> }>)[0]
      .schedule[0].value_with_tax);
  assert.equal(scheduled("our_price"), 130.99);
  assert.equal(scheduled("minimum_seller_allowed_price"), 114.27);
  assert.equal(scheduled("maximum_seller_allowed_price"), 130.99);
  assert.equal(offer.discounted_price, undefined);
  assert.equal(attrs.list_price, undefined);
  const business = attrs.business_price as Array<{
    schedule: Array<{ value_with_tax: number }>;
  }>;
  assert.equal(business[0].schedule[0].value_with_tax, 130.99);
});

test("buildAmazonAttributes — shelf life and melting point are evidence-only", () => {
  const absent = buildAmazonAttributes(mkSku());
  assert.equal(absent.fc_shelf_life, undefined);
  assert.equal(absent.melting_temperature, undefined);

  const reviewed = buildAmazonAttributes(mkSku({
    attributes: JSON.stringify({
      fc_shelf_life: [{ value: 180, unit: "days" }],
      melting_temperature: [{ value: 28, unit: "degrees_fahrenheit" }],
    }),
  }));
  assert.deepEqual(reviewed.fc_shelf_life, [{ value: 180, unit: "days" }]);
  assert.deepEqual(reviewed.melting_temperature, [{ value: 28, unit: "degrees_fahrenheit" }]);
});

test("submitToAmazon — Uncrustables without structured count fails before any PUT", async () => {
  const result = await submitToAmazon({
    sku: mkSku({
      attributes: JSON.stringify({
        purchasable_offer: [{
          our_price: [{ schedule: [{ value_with_tax: 9.99 }] }],
        }],
        business_price: [{ schedule: [{ value_with_tax: 8.99 }] }],
      }),
      price_cents: 7699,
    }),
    storeIndex: 1,
    brand: "Uncrustables",
    category: "FROZEN_GROCERY",
    physicalPackageSpecs: VERIFIED_PHYSICAL,
    verifiedAllergens: ["peanuts", "wheat"],
    dryRun: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /structured number_of_items/i);
  const attrs = result.payload.attributes as Record<string, unknown>;
  assert.equal(attrs.purchasable_offer, undefined);
  assert.equal(attrs.business_price, undefined);
});

test("Amazon publishing requires validation preview before every real PUT", () => {
  assert.equal(AMAZON_VALIDATION_PREVIEW_REQUIRED, true);
});

test("submitToAmazon — existing Uncrustables ASIN cannot use generic replacement PUT", async () => {
  assert.equal(UNCRUSTABLES_EXISTING_LISTING_REQUIRES_SURGICAL_PATCH, true);
  const result = await submitToAmazon({
    sku: mkSku({
      asin: "B0H82RQ226",
      attributes: JSON.stringify({ number_of_items: [{ value: 24 }] }),
      price_cents: 7699,
    }),
    storeIndex: 1,
    brand: "Uncrustables",
    category: "FROZEN_GROCERY",
    dryRun: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /sealed surgical PATCH workflow/i);
});

test("buildAmazonAttributes — preserves only an explicit each_unit_count", () => {
  const attrs = buildAmazonAttributes(mkSku({
    attributes: JSON.stringify({
      number_of_items: [{ value: 24 }],
      each_unit_count: [{ value: 4, marketplace_id: "ATVPDKIKX0DER" }],
    }),
  }));
  assert.equal((attrs.each_unit_count as Array<{ value: number }>)[0].value, 4);
});

test("buildAmazonAttributes — unknown inventory never becomes an invented 100", () => {
  const attrs = buildAmazonAttributes(mkSku({ available_quantity: null }));
  assert.equal(attrs.fulfillment_availability, undefined);
});

// Owner's standing rule: an own-brand passthrough listing ALWAYS publishes as
// "Uncrustables". A stale MasterBundle.brand of "Smucker's" once leaked through
// and Amazon rejected the listing with 8572 (UPC doesn't match brand records),
// so the publish boundary canonicalizes rather than trusting upstream data.
test("buildAmazonAttributes — Smucker's brand canonicalizes to Uncrustables", () => {
  for (const raw of ["Smucker's", "Smuckers", "Uncrustables"]) {
    const attrs = buildAmazonAttributes(mkSku(), raw);
    const brand = (attrs.brand as Array<{ value: string }>)[0].value;
    assert.equal(brand, "Uncrustables", `${raw} should publish as Uncrustables`);
    // manufacturer must agree with brand
    assert.equal((attrs.manufacturer as Array<{ value: string }>)[0].value, "Uncrustables");
  }
});

test("buildAmazonAttributes — a non-passthrough house brand is left alone", () => {
  const attrs = buildAmazonAttributes(mkSku(), "Salutem Vita");
  assert.equal((attrs.brand as Array<{ value: string }>)[0].value, "Salutem Vita");
});

// Amazon's live GROCERY schema requires these two even though our cached schema
// copy marks them optional; omitting them fails the PUT with 90220. Only bites
// listings that must CREATE an ASIN, so it surfaced on one stale draft.
test("buildAmazonAttributes — always emits the required liquid/heat attributes", () => {
  const attrs = buildAmazonAttributes(mkSku());
  assert.ok(Array.isArray(attrs.contains_liquid_contents));
  assert.ok(Array.isArray(attrs.is_heat_sensitive));
  assert.equal((attrs.contains_liquid_contents as Array<{ value: boolean }>)[0].value, false);
});

test("buildAmazonAttributes — is_heat_sensitive follows the bundle category", () => {
  const cold = buildAmazonAttributes(mkSku(), "Uncrustables", "FROZEN_GROCERY");
  assert.equal((cold.is_heat_sensitive as Array<{ value: boolean }>)[0].value, true);

  const chilled = buildAmazonAttributes(mkSku(), "Salutem Vita", "REFRIGERATED");
  assert.equal((chilled.is_heat_sensitive as Array<{ value: boolean }>)[0].value, true);

  const dry = buildAmazonAttributes(mkSku(), "Salutem Vita", "SHELF_STABLE");
  assert.equal((dry.is_heat_sensitive as Array<{ value: boolean }>)[0].value, false);

  // no category supplied (legacy callers) → shelf-stable default
  const legacy = buildAmazonAttributes(mkSku(), "Salutem Vita");
  assert.equal((legacy.is_heat_sensitive as Array<{ value: boolean }>)[0].value, false);
});

test("buildAmazonAttributes — ignores legacy package columns without proof", () => {
  const attrs = buildAmazonAttributes(mkSku());
  assert.equal(attrs.item_package_dimensions, undefined);
  assert.equal(attrs.item_package_weight, undefined);
});

test("buildAmazonAttributes — verified proof overrides stale rich package facts", () => {
  const attrs = buildAmazonAttributes(
    mkSku({
      attributes: JSON.stringify({
        item_package_dimensions: [{
          length: { value: 99, unit: "inches" },
          width: { value: 99, unit: "inches" },
          height: { value: 99, unit: "inches" },
        }],
        item_package_weight: [{ value: 999, unit: "ounces" }],
      }),
    }),
    undefined,
    undefined,
    VERIFIED_PHYSICAL,
  );
  const dims = (attrs.item_package_dimensions as Array<{
    length: { value: number };
    width: { value: number };
    height: { value: number };
  }>)[0];
  assert.equal(dims.length.value, 14);
  assert.equal(dims.width.value, 10);
  assert.equal(dims.height.value, 6);
  assert.equal(
    (attrs.item_package_weight as Array<{ value: number }>)[0].value,
    32,
  );
});

test("buildAmazonAttributes — compliance facts require explicit reviewed inputs", () => {
  const sku = mkSku({
    attributes: JSON.stringify({
      allergen_information: [{ value: "soy" }],
      is_expiration_dated_product: [{ value: true }],
      product_expiration_type: [{ value: "Expiration Date Required" }],
      item_weight: [{ value: 99, unit: "pounds" }],
      item_dimensions: [{ value: "99 x 99 x 99" }],
    }),
  });
  const unverified = buildAmazonAttributes(
    sku,
    "Uncrustables",
    "FROZEN_GROCERY",
    VERIFIED_PHYSICAL,
  );
  assert.equal(unverified.allergen_information, undefined);
  assert.equal(unverified.is_expiration_dated_product, undefined);
  assert.equal(unverified.product_expiration_type, undefined);
  assert.equal(unverified.item_weight, undefined);
  assert.equal(unverified.item_dimensions, undefined);

  const reviewed = buildAmazonAttributes(
    sku,
    "Uncrustables",
    "FROZEN_GROCERY",
    VERIFIED_PHYSICAL,
    ["peanuts", "wheat"],
    {
      source: "MANUFACTURER_LABEL",
      is_expiration_dated_product: true,
      product_expiration_type: "Expiration Date Required",
    },
  );
  assert.deepEqual(
    (reviewed.allergen_information as Array<{ value: string }>).map(
      (row) => row.value,
    ),
    ["peanuts", "wheat"],
  );
  assert.equal(
    (reviewed.is_expiration_dated_product as Array<{ value: boolean }>)[0].value,
    true,
  );
  assert.equal(
    (reviewed.product_expiration_type as Array<{ value: string }>)[0].value,
    "Expiration Date Required",
  );
});

test("submitToAmazon — rejects measurement proof that does not match the SKU", async () => {
  const result = await submitToAmazon({
    sku: mkSku({ package_length_in: 13 }),
    storeIndex: 1,
    physicalPackageSpecs: VERIFIED_PHYSICAL,
    dryRun: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /operator-verified package weight and dimensions/i);
});

test("submitToAmazon — food submission rejects missing reviewed allergens", async () => {
  const result = await submitToAmazon({
    sku: mkSku({
      attributes: JSON.stringify({ number_of_items: [{ value: 24 }] }),
    }),
    storeIndex: 1,
    brand: "Uncrustables",
    category: "FROZEN_GROCERY",
    physicalPackageSpecs: VERIFIED_PHYSICAL,
    dryRun: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /reviewed structured manufacturer allergen/i);
});

test("submitToAmazon — Uncrustables blocks without an exact MAIN authenticity permit", async () => {
  const result = await submitToAmazon({
    sku: mkSku({
      sku: "PB-ASAF-G2T6",
      main_image_url: "https://approved-assets.r2.dev/pb.png",
      attributes: JSON.stringify({ number_of_items: [{ value: 24 }] }),
    }),
    storeIndex: 1,
    brand: "Uncrustables",
    category: "FROZEN_GROCERY",
    physicalPackageSpecs: VERIFIED_PHYSICAL,
    verifiedAllergens: ["peanuts", "wheat"],
    dryRun: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /MAIN authenticity blocked.*permit is missing/i);
});

test("buildAmazonPayload — wraps attributes + productType + LISTING requirements", () => {
  const payload = buildAmazonPayload(mkSku(), "POULTRY");
  assert.equal(payload.productType, "POULTRY");
  assert.equal(payload.requirements, "LISTING");
  assert.ok(payload.attributes && typeof payload.attributes === "object");
});

// ── Walmart payload builder ──────────────────────────────────────────

function walmartContract(
  overrides: Partial<WalmartPublicListingContract> = {},
): WalmartPublicListingContract {
  return {
    contract_version: WALMART_PUBLIC_CONTRACT_SCHEMA,
    spec_version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
    spec_schema_hash: "a".repeat(64),
    spec_fetched_at: "2026-07-18T12:00:00.000Z",
    product_type: "Food And Beverage",
    country_of_origin_substantial_transformation: "US",
    secondary_image_urls: [
      "https://example.com/secondary-1.png",
      "https://example.com/secondary-2.png",
    ],
    public_attributes: { flavor: "Variety" },
    offer_handoff: {
      mode: "STAGED_AFTER_ITEM_SETUP",
      quantity: 7,
      fulfillment_center_id: "DEFAULT",
      fulfillment_lag_time: 1,
    },
    ...overrides,
  };
}

function walmartSku(
  overrides: Partial<ChannelSKU> = {},
  contract = walmartContract(),
): ChannelSKU {
  return mkSku({
    channel: "WALMART",
    price_cents: 7999,
    attributes: JSON.stringify({
      product_truth_manifest: { must_not_leak: true },
      walmart: contract,
      walmart_prepublication: { must_not_leak: true },
    }),
    ...overrides,
  });
}

const WALMART_BUILD_OPTIONS = {
  brand: "Salutem Vita",
  packCount: 9,
  physicalPackageSpecs: VERIFIED_PHYSICAL,
} as const;

function ownerAuthorization(sku: ChannelSKU) {
  const now = new Date();
  const approvalSha256 = "2".repeat(64);
  const sellerFingerprint = "7".repeat(64);
  const request = buildWalmartOwnerPermitSigningRequest({
    key_id: "owner-payload-fixture-key",
    signed_body: {
      permit_id: `owner-permit://payload-test/${sku.id}`,
      action: "WALMART_MP_ITEM_SUBMIT",
      environment: "TEST_FIXTURE_ONLY",
      engine_release_sha256: "1".repeat(64),
      approval_sha256: approvalSha256,
      doctor_receipt_sha256: "3".repeat(64),
      apply_preview_receipt_sha256: "4".repeat(64),
      certification_sha256: "5".repeat(64),
      candidate_key: "candidate-payload-test",
      channel_sku_id: sku.id,
      sku: sku.sku,
      upc: sku.upc!,
      payload_sha256: hashWalmartPayload(
        buildWalmartPayload(sku, WALMART_BUILD_OPTIONS),
      ),
      store_index: 1,
      seller_account_fingerprint_sha256: sellerFingerprint,
      database_target_fingerprint_sha256: "8".repeat(64),
      pilot_slot: 1,
      max_pilot_skus: 2,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 20 * 60_000).toISOString(),
      approved_by: "fixture-owner",
      decision_ref: "owner-decision://payload-test/one",
      live_submission_authorized: true,
      claims: {
        exact_one_sku: true,
        marketplace_submission_max: 1,
        delist: false,
        reprice: false,
        purchase: false,
        schedule: false,
      },
    },
  });
  const signedPermit = assembleWalmartOwnerPermit({
    request,
    signature_base64: sign(
      null,
      Buffer.from(request.signing_message_base64, "base64"),
      OWNER_KEYS.privateKey,
    ).toString("base64"),
  });
  return {
    signedPermit,
    engineReleaseSha256: signedPermit.signed_body.engine_release_sha256,
    approvalSha256,
    sellerAccountFingerprintSha256: sellerFingerprint,
  };
}

function unconsumedLifecycleClaim() {
  return {
    attemptId: "attempt-payload-fixture",
    claimToken: "claim-payload-fixture",
  };
}

function walmartParts(payload: Record<string, unknown>): {
  item: Record<string, unknown>;
  orderable: Record<string, unknown>;
  visible: Record<string, unknown>;
} {
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  return {
    item,
    orderable: item.Orderable as Record<string, unknown>,
    visible: (item.Visible as Record<string, Record<string, unknown>>)[
      "Food And Beverage"
    ],
  };
}

test("buildWalmartPayload — emits the full pinned MP_ITEM 5.0 header", () => {
  const payload = buildWalmartPayload(walmartSku(), WALMART_BUILD_OPTIONS);
  const header = payload.MPItemFeedHeader as Record<string, unknown>;
  assert.deepEqual(header, {
    sellingChannel: "marketplace",
    feedType: "MP_ITEM",
    processMode: "REPLACE",
    locale: "en",
    version: WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION,
    subset: "EXTERNAL",
    subCategory: "product_content_and_site_exp",
  });
  assert.ok(Array.isArray(payload.MPItem));
  assert.equal((payload.MPItem as unknown[]).length, 1);
});

test("buildWalmartPayload — uses nested Orderable/Visible and typed UPC", () => {
  const payload = buildWalmartPayload(
    walmartSku({ upc: "012345678905" }),
    WALMART_BUILD_OPTIONS,
  );
  const { item, orderable, visible } = walmartParts(payload);
  assert.deepEqual(orderable.productIdentifiers, {
    productIdType: "UPC",
    productId: "012345678905",
  });
  assert.equal(orderable.specProductType, "Food And Beverage");
  assert.equal(orderable.price, 79.99);
  assert.equal(visible.productName, walmartSku().title);
  assert.equal(visible.brand, "Salutem Vita");
  assert.equal(item.productIdentifiers, undefined);
});

test("buildWalmartPayload — carries exact verified package facts", () => {
  const payload = buildWalmartPayload(walmartSku(), WALMART_BUILD_OPTIONS);
  const { orderable } = walmartParts(payload);
  assert.equal(orderable.ShippingWeight, 2);
  assert.deepEqual(orderable.productPackageDimensionsAndWeight, {
    productPackageDimensionsDepth: 14,
    productPackageDimensionsHeight: 6,
    productPackageDimensionsWidth: 10,
    productPackageWeight: 2,
  });
});

test("buildWalmartPayload — refuses all former defaults", () => {
  assert.throws(
    () => buildWalmartPayload(walmartSku(), {
      packCount: 9,
      physicalPackageSpecs: VERIFIED_PHYSICAL,
    }),
    /brand.*no default/i,
  );
  assert.throws(
    () => buildWalmartPayload(walmartSku(), {
      brand: "Salutem Vita",
      physicalPackageSpecs: VERIFIED_PHYSICAL,
    }),
    /packCount is required/i,
  );
  assert.throws(
    () => buildWalmartPayload(walmartSku(), {
      brand: "Salutem Vita",
      packCount: 9,
    }),
    /operator-verified package/i,
  );
  assert.throws(
    () => buildWalmartPayload(mkSku({ price_cents: 7999 }), WALMART_BUILD_OPTIONS),
    /attributes\.walmart is required/i,
  );
});

test("submitToWalmart — rejects measurement proof that does not match the SKU", async () => {
  const result = await submitToWalmart({
    sku: walmartSku({ package_weight_oz: 31 }),
    storeIndex: 1,
    brand: "Salutem Vita",
    packCount: 9,
    physicalPackageSpecs: VERIFIED_PHYSICAL,
    dryRun: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /operator-verified package weight and dimensions/i);
});

test("buildWalmartPayload — sends public attributes and never root evidence", () => {
  const payload = buildWalmartPayload(walmartSku(), WALMART_BUILD_OPTIONS);
  const { visible } = walmartParts(payload);
  const kf = visible.keyFeatures as string[];
  assert.equal(kf.length, 3);
  assert.match(kf[0], /single-serve/);
  assert.equal(visible.flavor, "Variety");
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /product_truth_manifest/);
  assert.doesNotMatch(serialized, /walmart_prepublication/);
});

test("buildWalmartPayload — rejects old 4.7 even when passed as typed contract", () => {
  const old = {
    ...walmartContract(),
    spec_version: "4.7",
  } as WalmartPublicListingContract;
  assert.throws(
    () => buildWalmartPayload(walmartSku(), {
      ...WALMART_BUILD_OPTIONS,
      walmart: old,
    }),
    /exact MP_ITEM 5\.0/i,
  );
});

test("buildWalmartPayload — MATCH_EXISTING is routed away from MP_ITEM", () => {
  const sku = walmartSku({
    attributes: JSON.stringify({
      walmart: walmartContract(),
      walmart_prepublication: {
        catalog_search: {
          result: "EXACT_MATCH",
          setup_method: "MATCH_EXISTING",
        },
        item_spec: { feed_type: "MP_ITEM_MATCH" },
      },
    }),
  });
  assert.throws(
    () => buildWalmartPayload(sku, WALMART_BUILD_OPTIONS),
    /supports only NO_EXACT_MATCH -> FULL_ITEM -> MP_ITEM 5\.0/i,
  );
});

test("buildWalmartPayload — adapter-owned core fields cannot be overridden", () => {
  const bad = walmartContract({
    public_attributes: { brand: "Fake Brand" },
  });
  assert.throws(
    () => buildWalmartPayload(walmartSku({}, bad), WALMART_BUILD_OPTIONS),
    /public_attributes\.brand is adapter-owned/i,
  );
  const snakeCase = walmartContract({
    public_attributes: { main_image_url: "https://example.com/fake.png" },
  });
  assert.throws(
    () => buildWalmartPayload(walmartSku({}, snakeCase), WALMART_BUILD_OPTIONS),
    /public_attributes\.main_image_url is adapter-owned/i,
  );
});

test("buildWalmartPayload — exact quantity trio is derived from recipe", () => {
  const payload = buildWalmartPayload(walmartSku(), WALMART_BUILD_OPTIONS);
  const { visible } = walmartParts(payload);
  assert.equal(visible.multipackQuantity, 9);
  assert.equal(visible.countPerPack, 1);
  assert.equal(visible.count, 9);
});

test("buildWalmartPayload — conflicting quantity truth fails closed", () => {
  const bad = walmartContract({
    public_attributes: { multipackQuantity: 6 },
  });
  assert.throws(
    () => buildWalmartPayload(walmartSku({}, bad), WALMART_BUILD_OPTIONS),
    /conflicts with exact packCount 9/i,
  );
});

test("buildWalmartPayload — inventory follows explicit handoff mode", () => {
  const staged = buildWalmartPayload(walmartSku(), WALMART_BUILD_OPTIONS);
  assert.equal(walmartParts(staged).orderable.inventory, undefined);

  const inlineContract = walmartContract({
    offer_handoff: {
      mode: "INLINE",
      quantity: 11,
      fulfillment_center_id: "FC-1",
      fulfillment_lag_time: 2,
    },
  });
  const inline = buildWalmartPayload(
    walmartSku({}, inlineContract),
    WALMART_BUILD_OPTIONS,
  );
  assert.deepEqual(walmartParts(inline).orderable.inventory, [
    { fulfillmentCenterID: "FC-1", quantity: 11 },
  ]);
});

test("buildWalmartMultipartBody — is a pure JSON file request contract", () => {
  const body = buildWalmartMultipartBody(walmartSku(), WALMART_BUILD_OPTIONS);
  assert.deepEqual(body.params, { feedType: "MP_ITEM" });
  assert.equal(body.file.contentType, "application/json");
  assert.match(body.file.filename, /SV-AS01-A1B2-mp-item\.json$/);
  assert.deepEqual(JSON.parse(body.file.content), body.payload);
});

test("submitToWalmart — local dry run performs no API request", async () => {
  let calls = 0;
  const result = await submitToWalmart({
    sku: walmartSku(),
    storeIndex: 1,
    ...WALMART_BUILD_OPTIONS,
    dryRun: true,
    client: {
      async requestRaw() {
        calls += 1;
        throw new Error("must not be called");
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.walmart_status, "DRY_RUN_LOCAL_ONLY");
  assert.equal(result.schema_validation, null);
  assert.equal(calls, 0);
});

test("submitToWalmart — live schema failure prevents the feed call", async () => {
  const schema = {
    type: "object",
    required: ["fieldThatPayloadCannotHave"],
  };
  const contract = walmartContract({ spec_schema_hash: sha256WalmartJson(schema) });
  const calls: string[] = [];
  const sku = walmartSku({}, contract);
  const result = await submitToWalmart({
    sku,
    storeIndex: 1,
    ...WALMART_BUILD_OPTIONS,
    dryRun: false,
    beforeFeedPost() {},
    ownerPermitAuthorization: ownerAuthorization(sku),
    lifecyclePostClaim: unconsumedLifecycleClaim(),
    client: {
      async requestRaw(_method, path) {
        calls.push(path);
        return {
          status: 200,
          ok: true,
          body: { schema },
          correlationId: "cid-invalid",
        };
      },
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["/items/spec"]);
  assert.equal(result.issues[0]?.code, "WALMART_SPEC_VALIDATION_FAILED");
});

test("submitToWalmart — real submission cannot omit the approval fence", async () => {
  let calls = 0;
  const result = await submitToWalmart({
    sku: walmartSku(),
    storeIndex: 1,
    ...WALMART_BUILD_OPTIONS,
    dryRun: false,
    client: {
      async requestRaw() {
        calls += 1;
        throw new Error("must not be called");
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.code, "WALMART_MUTATION_FENCE_MISSING");
  assert.equal(calls, 0);
});

test("submitToWalmart — callback without a signed permit cannot post", async () => {
  let calls = 0;
  const result = await submitToWalmart({
    sku: walmartSku(),
    storeIndex: 1,
    ...WALMART_BUILD_OPTIONS,
    dryRun: false,
    beforeFeedPost() {},
    client: {
      async requestRaw() {
        calls += 1;
        throw new Error("must not be called");
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.code, "WALMART_MUTATION_FENCE_MISSING");
  assert.equal(calls, 0);
});

test("submitToWalmart — a signed permit alone cannot bypass the durable claim", async () => {
  let calls = 0;
  const sku = walmartSku();
  const result = await submitToWalmart({
    sku,
    storeIndex: 1,
    ...WALMART_BUILD_OPTIONS,
    dryRun: false,
    beforeFeedPost() {},
    ownerPermitAuthorization: ownerAuthorization(sku),
    client: {
      async requestRaw() {
        calls += 1;
        throw new Error("must not be called");
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.code, "WALMART_MUTATION_FENCE_MISSING");
  assert.equal(calls, 0);
});

test("submitToWalmart — production transport rejects a test-fixture permit", async () => {
  const schema = { type: "object", required: ["MPItemFeedHeader", "MPItem"] };
  const contract = walmartContract({ spec_schema_hash: sha256WalmartJson(schema) });
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const sequence: string[] = [];
  const sku = walmartSku({}, contract);
  const result = await submitToWalmart({
    sku,
    storeIndex: 1,
    ...WALMART_BUILD_OPTIONS,
    dryRun: false,
    beforeFeedPost() {
      sequence.push("approval-fence");
    },
    ownerPermitAuthorization: ownerAuthorization(sku),
    lifecyclePostClaim: unconsumedLifecycleClaim(),
    client: {
      async requestRaw(_method, path, options) {
        sequence.push(path);
        calls.push({ path, options: options as Record<string, unknown> });
        if (path === "/items/spec") {
          return {
            status: 200,
            ok: true,
            body: { schema },
            correlationId: "cid-spec",
          };
        }
        return {
          status: 200,
          ok: true,
          body: { feedId: "feed-123", status: "RECEIVED" },
          correlationId: "cid-feed",
        };
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.feed_id, null);
  assert.deepEqual(sequence, ["/items/spec", "approval-fence"]);
  assert.deepEqual(calls.map((call) => call.path), ["/items/spec"]);
  assert.equal(result.issues[0]?.code, "WALMART_MUTATION_FENCE_FAILED");
  assert.match(result.error ?? "", /KEY_UNTRUSTED_OR_REVOKED/);
});

test("submitToWalmart — mutation-adjacent fence can still block the feed", async () => {
  const schema = { type: "object" };
  const contract = walmartContract({ spec_schema_hash: sha256WalmartJson(schema) });
  const calls: string[] = [];
  const sku = walmartSku({}, contract);
  const result = await submitToWalmart({
    sku,
    storeIndex: 1,
    ...WALMART_BUILD_OPTIONS,
    dryRun: false,
    beforeFeedPost() {
      throw new Error("approval fingerprint drifted");
    },
    ownerPermitAuthorization: ownerAuthorization(sku),
    lifecyclePostClaim: unconsumedLifecycleClaim(),
    client: {
      async requestRaw(_method, path) {
        calls.push(path);
        return {
          status: 200,
          ok: true,
          body: { schema },
          correlationId: "cid-spec",
        };
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["/items/spec"]);
  assert.equal(result.issues[0]?.code, "WALMART_MUTATION_FENCE_FAILED");
  assert.match(result.error ?? "", /approval fingerprint drifted/i);
});

// ── channelTarget — skip set + marketplace mapping ────────────────────

test("channelTarget — AMAZON_SIRIUS reports skipReason (no SP-API app)", () => {
  const t = channelTarget("AMAZON_SIRIUS");
  assert.equal(t.kind, "amazon");
  assert.equal(t.account, "SIRIUS");
  assert.match(t.skipReason ?? "", /SIRIUS|SP-API/);
});

test("channelTarget — AMAZON_RETAILER reports skipReason (US suspended)", () => {
  const t = channelTarget("AMAZON_RETAILER");
  assert.equal(t.account, "RETAILER");
  assert.match(t.skipReason ?? "", /suspended|RETAILER/i);
});

test("channelTarget — AMAZON_SALUTEM is publishable", () => {
  const t = channelTarget("AMAZON_SALUTEM");
  assert.equal(t.kind, "amazon");
  assert.equal(t.account, "SALUTEM");
  assert.equal(t.skipReason, null);
});

test("channelTarget — WALMART is publishable, kind=walmart", () => {
  const t = channelTarget("WALMART");
  assert.equal(t.kind, "walmart");
  assert.equal(t.skipReason, null);
});

test("channelTarget — EBAY + TIKTOK report 'not implemented'", () => {
  for (const ch of ["EBAY", "TIKTOK_1", "TIKTOK_2"]) {
    const t = channelTarget(ch);
    assert.match(t.skipReason ?? "", /not implemented/i);
  }
});

// ── Price band (min = ROI floor, max = target) merged into purchasable_offer ──

type OfferTestShape = {
  our_price: Array<{ schedule: Array<{ value_with_tax: number }> }>;
  minimum_seller_allowed_price?: Array<{
    schedule: Array<{ value_with_tax: number }>;
  }>;
  maximum_seller_allowed_price?: Array<{
    schedule: Array<{ value_with_tax: number }>;
  }>;
};

test("buildAmazonAttributes — rich-attr price band survives with our_price set", () => {
  const band = {
    purchasable_offer: [{
      marketplace_id: "ATVPDKIKX0DER", currency: "USD",
      minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 74.53 }] }],
      maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 86.25 }] }],
    }],
  };
  const attrs = buildAmazonAttributes(
    mkSku({ attributes: JSON.stringify(band), price_cents: 8625 }),
  );
  const po = (attrs.purchasable_offer as OfferTestShape[])[0];
  assert.equal(po.our_price[0].schedule[0].value_with_tax, 86.25);
  assert.ok(po.minimum_seller_allowed_price);
  assert.ok(po.maximum_seller_allowed_price);
  assert.equal(po.minimum_seller_allowed_price[0].schedule[0].value_with_tax, 74.53);
  assert.equal(po.maximum_seller_allowed_price[0].schedule[0].value_with_tax, 86.25);
});

test("buildAmazonAttributes — coupon-only base removes list price and pins B2B to consumer", () => {
  const attrs = buildAmazonAttributes(mkSku({
    price_cents: 7699,
    attributes: JSON.stringify({
      list_price: [{ value: 99.99, currency: "USD" }],
      business_price: [{ currency: "USD", schedule: [{ value_with_tax: 66.22 }] }],
    }),
  }));
  assert.equal(attrs.list_price, undefined);
  const business = attrs.business_price as Array<{
    currency: string;
    marketplace_id: string;
    schedule: Array<{ value_with_tax: number }>;
  }>;
  assert.equal(business[0].currency, "USD");
  assert.equal(business[0].schedule[0].value_with_tax, 76.99);
});

test("buildAmazonAttributes — contradictory band parts are dropped, not sent", () => {
  const band = {
    purchasable_offer: [{
      marketplace_id: "ATVPDKIKX0DER", currency: "USD",
      minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 74.53 }] }],
      maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 86.25 }] }],
    }],
  };
  // Operator dropped the price to $50 → stale min ($74.53) would break the
  // listing (min > price). It must be omitted; max ($86.25 ≥ $50) stays.
  const attrs = buildAmazonAttributes(
    mkSku({ attributes: JSON.stringify(band), price_cents: 5000 }),
  );
  const po = (attrs.purchasable_offer as OfferTestShape[])[0];
  assert.equal(po.our_price[0].schedule[0].value_with_tax, 50);
  assert.equal(po.minimum_seller_allowed_price, undefined);
  assert.ok(po.maximum_seller_allowed_price);
  assert.equal(po.maximum_seller_allowed_price[0].schedule[0].value_with_tax, 86.25);
});

test("buildAmazonAttributes — no band in rich attrs -> plain our_price only", () => {
  const attrs = buildAmazonAttributes(mkSku({ price_cents: 8625 }));
  const po = (attrs.purchasable_offer as OfferTestShape[])[0];
  assert.equal(po.our_price[0].schedule[0].value_with_tax, 86.25);
  assert.equal(po.minimum_seller_allowed_price, undefined);
  assert.equal(po.maximum_seller_allowed_price, undefined);
});
