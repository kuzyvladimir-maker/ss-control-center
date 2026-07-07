// Phase 2.5 Stage 7 — payload builder unit tests for the Amazon and
// Walmart publish modules. Pure functions, no I/O.
//
// Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/distribution-payloads.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChannelSKU } from "@/generated/prisma/client";
import {
  buildAmazonAttributes,
  buildAmazonPayload,
} from "@/lib/bundle-factory/distribution/amazon-publish";
import {
  buildWalmartPayload,
} from "@/lib/bundle-factory/distribution/walmart-publish";
import { channelTarget } from "@/lib/bundle-factory/distribution/account-map";

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
  const attrs = buildAmazonAttributes(mkSku());
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

test("buildAmazonAttributes — omits dimensions when any side is null", () => {
  const attrs = buildAmazonAttributes(mkSku({ package_length_in: null }));
  assert.equal(attrs.item_package_dimensions, undefined);
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
  const payload = buildWalmartPayload(mkSku({ package_weight_oz: 32 }));
  const item = (payload.MPItem as Array<Record<string, unknown>>)[0];
  const sw = item.shippingWeight as { value: number; unit: string };
  assert.equal(sw.unit, "LB");
  assert.equal(sw.value, 2); // 32 oz / 16 = 2 lb
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
  const po = (attrs.purchasable_offer as Array<Record<string, any>>)[0];
  assert.equal(po.our_price[0].schedule[0].value_with_tax, 86.25);
  assert.equal(po.minimum_seller_allowed_price[0].schedule[0].value_with_tax, 74.53);
  assert.equal(po.maximum_seller_allowed_price[0].schedule[0].value_with_tax, 86.25);
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
  const po = (attrs.purchasable_offer as Array<Record<string, any>>)[0];
  assert.equal(po.our_price[0].schedule[0].value_with_tax, 50);
  assert.equal(po.minimum_seller_allowed_price, undefined);
  assert.equal(po.maximum_seller_allowed_price[0].schedule[0].value_with_tax, 86.25);
});

test("buildAmazonAttributes — no band in rich attrs -> plain our_price only", () => {
  const attrs = buildAmazonAttributes(mkSku({ price_cents: 8625 }));
  const po = (attrs.purchasable_offer as Array<Record<string, any>>)[0];
  assert.equal(po.our_price[0].schedule[0].value_with_tax, 86.25);
  assert.equal(po.minimum_seller_allowed_price, undefined);
  assert.equal(po.maximum_seller_allowed_price, undefined);
});
