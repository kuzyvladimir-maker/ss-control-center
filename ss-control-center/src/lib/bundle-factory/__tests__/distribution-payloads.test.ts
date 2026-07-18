// Phase 2.5 Stage 7 — payload builder unit tests for the Amazon and
// Walmart publish modules. Pure functions, no I/O.
//
// Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/distribution-payloads.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChannelSKU } from "@/generated/prisma/client";
import {
  AMAZON_VALIDATION_PREVIEW_REQUIRED,
  buildAmazonAttributes,
  buildAmazonPayload,
  submitToAmazon,
} from "@/lib/bundle-factory/distribution/amazon-publish";
import {
  buildWalmartPayload,
  submitToWalmart,
} from "@/lib/bundle-factory/distribution/walmart-publish";
import { channelTarget } from "@/lib/bundle-factory/distribution/account-map";
import {
  VERIFIED_PHYSICAL_PACKAGE_SCHEMA,
  type VerifiedPhysicalPackageSpecs,
} from "@/lib/bundle-factory/physical-package-specs";

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

test("buildWalmartPayload — has spec header + single MPItem entry", () => {
  const payload = buildWalmartPayload(mkSku());
  const header = payload.MPItemFeedHeader as Record<string, unknown>;
  assert.equal(header.sellingChannel, "marketplace");
  assert.ok(Array.isArray(payload.MPItem));
  assert.equal((payload.MPItem as unknown[]).length, 1);
});

test("buildWalmartPayload — UPC in productIdentifiers as UPC type", () => {
  const payload = buildWalmartPayload(mkSku({ upc: "012345678905" }));
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  const ids = item.productIdentifiers as Array<{ productIdType: string; productId: string }>;
  assert.equal(ids[0].productIdType, "UPC");
  assert.equal(ids[0].productId, "012345678905");
});

test("buildWalmartPayload — weight converted oz → lb", () => {
  const payload = buildWalmartPayload(mkSku(), {
    physicalPackageSpecs: VERIFIED_PHYSICAL,
  });
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  const sw = item.shippingWeight as { value: number; unit: string };
  assert.equal(sw.unit, "LB");
  assert.equal(sw.value, 2); // 32 oz / 16 = 2 lb
});

test("buildWalmartPayload — legacy package columns do not invent shipping facts", () => {
  const payload = buildWalmartPayload(mkSku());
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  assert.equal(item.shippingWeight, undefined);
  assert.equal(item.assembledProductDimensions, undefined);
});

test("submitToWalmart — rejects measurement proof that does not match the SKU", async () => {
  const result = await submitToWalmart({
    sku: mkSku({ package_weight_oz: 31 }),
    storeIndex: 1,
    physicalPackageSpecs: VERIFIED_PHYSICAL,
    dryRun: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /operator-verified package weight and dimensions/i);
});

test("buildWalmartPayload — keyFeatures parsed from bullets_json", () => {
  const payload = buildWalmartPayload(mkSku());
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  const kf = item.keyFeatures as string[];
  assert.equal(kf.length, 3);
  assert.match(kf[0], /single-serve/);
});

test("buildWalmartPayload — productType defaults to 'Gift Baskets' when item_type empty", () => {
  const payload = buildWalmartPayload(mkSku({ item_type: null }));
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  assert.equal(item.productType, "Gift Baskets");
});

test("buildWalmartPayload — brand defaults to 'Salutem Vita' when not supplied", () => {
  const payload = buildWalmartPayload(mkSku());
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  assert.equal(item.brand, "Salutem Vita");
});

test("buildWalmartPayload — brand passes through (own-brand multipack)", () => {
  const payload = buildWalmartPayload(mkSku(), { brand: "Uncrustables" });
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  assert.equal(item.brand, "Uncrustables");
});

test("buildWalmartPayload — quantity trio emitted for a real multipack (packCount≥2)", () => {
  const payload = buildWalmartPayload(mkSku(), { packCount: 30 });
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  assert.equal(item.multipackQuantity, 30);
  assert.equal(item.countPerPack, 1);
  assert.equal(item.count, 30);
});

test("buildWalmartPayload — no quantity trio for a single unit / missing count", () => {
  const single = buildWalmartPayload(mkSku(), { packCount: 1 });
  const s = (single.MPItem as Array<Record<string, unknown>>)[0];
  assert.equal(s.multipackQuantity, undefined);
  assert.equal(s.count, undefined);

  const none = buildWalmartPayload(mkSku());
  const n = (none.MPItem as Array<Record<string, unknown>>)[0];
  assert.equal(n.multipackQuantity, undefined);
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
