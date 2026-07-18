import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addCatalogAnomalies,
  assessLedgerRow,
  buildCanonicalRecipe,
  extractLiveListing,
  failedLiveListing,
  schedulePrice,
  summarizeLedger,
  REJECTED_BRAND_CARD_REHOST_URLS,
  VERIFIED_BRAND_CARD_REHOST_URLS,
  type LedgerDbSnapshot,
  type LiveListingSnapshot,
} from "../audit/uncrustables-ledger";
import { BRAND_CARD_COLD_CHAIN_URL } from "../attributes/brand-assets";
import { priceFor } from "../../pricing/cost-model";

const MARKETPLACE = "ATVPDKIKX0DER";

function idealBullets(): string[] {
  return [
    "Twenty-four frozen sandwiches",
    "Ships in an insulated cooler",
    "Strawberry flavor",
    "Keep frozen until ready to enjoy",
    "Packed and shipped by the listing curator",
  ];
}

function dbFixture(): LedgerDbSnapshot {
  const component = {
    product_id: "donor-strawberry",
    product_name: "Uncrustables Peanut Butter & Strawberry Jam",
    brand: "Uncrustables",
    flavor: "Strawberry",
    qty: 24,
    unit_price_cents: 100,
    source_url: null,
  };
  return {
    channel_sku: {
      id: "channel-1",
      channel: "AMAZON_SALUTEM",
      store_index: 1,
      sku: "AA-BBBB-CCCC",
      upc: "123456789012",
      asin: "B0TEST1234",
      title: "Uncrustables Strawberry, 24 Count",
      bullets: idealBullets(),
      description: "A 24-count frozen bundle.",
      attributes: {},
      channel_category: "GROCERY",
      channel_browse_node: "123",
      price_cents: 7699,
      business_price_cents: 7699,
      lifecycle_status: "LIVE",
      compliance_status: "CAN_PUBLISH",
      validation_status: "PASSED",
      listing_status: "LIVE",
      main_image_url: "https://img/main.png",
      submitted_at: null,
      live_at: "2026-07-17T12:00:00.000Z",
      published_at: "2026-07-17T12:00:00.000Z",
      errors: [],
      distribution_errors: [],
    },
    master: {
      id: "master-1",
      generation_job_id: "job-1",
      name: "Uncrustables Strawberry — 24 ct",
      brand: "Uncrustables",
      category: "FROZEN_GROCERY",
      composition_type: "SINGLE_FLAVOR",
      pack_count: 24,
      lifecycle_status: "LIVE",
      estimated_cost_cents: 2400,
      suggested_price_cents: 7699,
      main_image_url: "https://img/main.png",
      secondary_image_urls: [],
      components: [component],
    },
    draft: {
      id: "draft-1",
      generation_job_id: "job-1",
      name: "Uncrustables Strawberry — 24 ct",
      brand: "Uncrustables",
      category: "FROZEN_GROCERY",
      composition_type: "SINGLE_FLAVOR",
      pack_count: 24,
      status: "PUBLISHED",
      compliance_status: "CAN_PUBLISH",
      components: [component],
      selected_variant_idx: 0,
      selected_variant: { name: "Strawberry — 24 ct", composition: [component] },
      title: "Uncrustables Strawberry, 24 Count",
      bullets: idealBullets(),
      description: "A 24-count frozen bundle.",
      main_image_url: "https://img/main.png",
      secondary_image_urls: [],
      generated_content: [
        {
          channel: "AMAZON_SALUTEM",
          compliance_status: "CAN_PUBLISH",
          title: "Uncrustables Strawberry, 24 Count",
          bullets: idealBullets(),
          description: "A 24-count frozen bundle.",
          main_image_url: "https://img/main.png",
        },
      ],
    },
  };
}

function liveFixture(): LiveListingSnapshot {
  const model = priceFor(24)!;
  return {
    fetched: true,
    error: null,
    asin: "B0TEST1234",
    amazon_statuses: ["BUYABLE", "DISCOVERABLE"],
    buyable: true,
    discoverable: true,
    product_type: "GROCERY",
    title: "Uncrustables Strawberry, 24 Count",
    title_total_units: 24,
    bullets: idealBullets(),
    description: "A 24-count frozen bundle.",
    brand: "Uncrustables",
    category: "food-gifts",
    browse_nodes: ["123"],
    item_type_keywords: ["food-gifts"],
    main_image_url: "https://img/main.png",
    gallery_image_urls: [
      BRAND_CARD_COLD_CHAIN_URL,
      "https://img/2.png",
      "https://img/3.png",
      "https://img/4.png",
      "https://img/5.png",
    ],
    unit_count: 24,
    number_of_items: 24,
    consumer_offer: {
      audience: "ALL",
      our_price: model.suggested,
      discounted_price: null,
      minimum_seller_allowed_price: model.floor,
      maximum_seller_allowed_price: model.suggested,
      quantity_discounts: [],
    },
    business_offers: [
      {
        audience: "B2B",
        our_price: model.suggested,
        discounted_price: null,
        minimum_seller_allowed_price: null,
        maximum_seller_allowed_price: null,
        quantity_discounts: [],
      },
    ],
    separate_business_price: null,
    fulfillment_availability: [
      { source: "attributes", fulfillment_channel_code: "DEFAULT", quantity: 7 },
    ],
    issues: [],
    raw_attributes: {},
    raw_offers: null,
  };
}

test("schedulePrice chooses the active schedule", () => {
  const value = [
    {
      schedule: [
        {
          value_with_tax: 70,
          start_at: { value: "2026-01-01T00:00:00Z" },
          end_at: { value: "2026-06-01T00:00:00Z" },
        },
        {
          value_with_tax: 76.99,
          start_at: { value: "2026-06-01T00:00:00Z" },
          end_at: { value: "2026-12-01T00:00:00Z" },
        },
      ],
    },
  ];
  assert.equal(schedulePrice(value, new Date("2026-07-17T12:00:00Z")), 76.99);
});

test("schedulePrice does not report an expired discount as active", () => {
  const expired = [
    {
      schedule: [
        {
          value_with_tax: 60,
          start_at: { value: "2026-01-01T00:00:00Z" },
          end_at: { value: "2026-02-01T00:00:00Z" },
        },
      ],
    },
  ];
  assert.equal(schedulePrice(expired, new Date("2026-07-17T12:00:00Z")), null);
});

test("extractLiveListing normalizes content, gallery, offers, availability, and issues", () => {
  const raw = {
    sku: "AA-BBBB-CCCC",
    summaries: [
      {
        marketplaceId: MARKETPLACE,
        asin: "B0TEST1234",
        productType: "GROCERY",
        status: ["BUYABLE", "DISCOVERABLE"],
        itemName: "fallback title",
      },
    ],
    attributes: {
      item_name: [{ value: "Uncrustables Strawberry, 24 Count", marketplace_id: MARKETPLACE }],
      brand: [{ value: "Uncrustables", marketplace_id: MARKETPLACE }],
      bullet_point: [{ value: "Bullet one", marketplace_id: MARKETPLACE }],
      product_description: [{ value: "Description", marketplace_id: MARKETPLACE }],
      recommended_browse_nodes: [{ value: "123", marketplace_id: MARKETPLACE }],
      item_type_keyword: [{ value: "food-gifts", marketplace_id: MARKETPLACE }],
      main_product_image_locator: [{ media_location: "https://img/main.png", marketplace_id: MARKETPLACE }],
      other_product_image_locator_1: [{ media_location: BRAND_CARD_COLD_CHAIN_URL, marketplace_id: MARKETPLACE }],
      unit_count: [{ value: 24, marketplace_id: MARKETPLACE }],
      number_of_items: [{ value: 24, marketplace_id: MARKETPLACE }],
      purchasable_offer: [
        {
          audience: "ALL",
          our_price: [{ schedule: [{ value_with_tax: 76.99 }] }],
          discounted_price: [{ schedule: [{ value_with_tax: 70 }] }],
          minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 66.95 }] }],
          maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 76.99 }] }],
        },
        {
          audience: "B2B",
          our_price: [{ schedule: [{ value_with_tax: 76.99 }] }],
          quantity_discount_plan: [{ quantity: 5, discount: 2 }],
        },
      ],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 11 }],
    },
    fulfillmentAvailability: [{ fulfillmentChannelCode: "AMAZON_NA", quantity: 3 }],
    issues: [
      {
        code: "WARN1",
        severity: "WARNING",
        message: "Example warning",
        attributeNames: ["item_name"],
        categories: ["INVALID_ATTRIBUTE"],
      },
    ],
    offers: [{ marketplaceId: MARKETPLACE }],
  };
  const live = extractLiveListing(raw, new Date("2026-07-17T12:00:00Z"));
  assert.equal(live.asin, "B0TEST1234");
  assert.equal(live.title_total_units, 24);
  assert.equal(live.consumer_offer?.our_price, 76.99);
  assert.equal(live.consumer_offer?.discounted_price, 70);
  assert.equal(live.business_offers[0]?.audience, "B2B");
  assert.equal(live.business_offers[0]?.quantity_discounts.length, 1);
  assert.deepEqual(
    live.fulfillment_availability.map((entry) => entry.quantity),
    [11, 3],
  );
  assert.equal(live.gallery_image_urls[0], BRAND_CARD_COLD_CHAIN_URL);
  assert.equal(live.issues[0]?.code, "WARN1");
  assert.deepEqual(live.raw_offers, [{ marketplaceId: MARKETPLACE }]);
});

test("top-level B2B offer prevents a false BUSINESS_PRICE_MISSING finding", () => {
  const raw = {
    summaries: [
      {
        marketplaceId: MARKETPLACE,
        asin: "B0TEST1234",
        productType: "GROCERY",
        status: ["BUYABLE", "DISCOVERABLE"],
      },
    ],
    attributes: {
      item_name: [
        {
          value: "Uncrustables Strawberry, 24 Count",
          marketplace_id: MARKETPLACE,
        },
      ],
      brand: [{ value: "Uncrustables", marketplace_id: MARKETPLACE }],
      bullet_point: idealBullets().map((value) => ({
        value,
        marketplace_id: MARKETPLACE,
      })),
      product_description: [
        { value: "A 24-count frozen bundle.", marketplace_id: MARKETPLACE },
      ],
      main_product_image_locator: [
        { media_location: "https://img/main.png", marketplace_id: MARKETPLACE },
      ],
      ...Object.fromEntries(
        liveFixture().gallery_image_urls.map((url, index) => [
          `other_product_image_locator_${index + 1}`,
          [{ media_location: url, marketplace_id: MARKETPLACE }],
        ]),
      ),
      unit_count: [{ value: 24, marketplace_id: MARKETPLACE }],
      number_of_items: [{ value: 24, marketplace_id: MARKETPLACE }],
      purchasable_offer: [
        {
          audience: "ALL",
          our_price: [{ schedule: [{ value_with_tax: 76.99 }] }],
          minimum_seller_allowed_price: [
            { schedule: [{ value_with_tax: 66.95 }] },
          ],
          maximum_seller_allowed_price: [
            { schedule: [{ value_with_tax: 76.99 }] },
          ],
        },
      ],
      fulfillment_availability: [
        { fulfillment_channel_code: "DEFAULT", quantity: 7 },
      ],
    },
    offers: [
      {
        marketplaceId: MARKETPLACE,
        offerType: "B2C",
        price: { currency: "USD", amount: "76.99" },
        audience: { value: "ALL", displayName: "Sell on Amazon" },
      },
      {
        marketplaceId: MARKETPLACE,
        offerType: "B2B",
        price: { currency: "USD", amount: "76.22" },
        audience: { value: "B2B", displayName: "Amazon Business (B2B)" },
      },
    ],
  };
  const live = extractLiveListing(raw);
  assert.equal(live.business_offers.length, 1);
  assert.equal(live.business_offers[0]?.audience, "B2B");
  assert.equal(live.business_offers[0]?.our_price, 76.22);

  const row = assessLedgerRow(dbFixture(), live);
  const codes = new Set(row.anomalies.map((value) => value.code));
  assert.equal(codes.has("BUSINESS_PRICE_MISSING"), false);
  assert.equal(codes.has("BUSINESS_PRICE_MISMATCH"), true);
});

test("canonical recipe uses selected variation and prices explicit master count", () => {
  const db = dbFixture();
  db.draft!.components[0] = { ...db.draft!.components[0], qty: 12 };
  const recipe = buildCanonicalRecipe(db);
  assert.equal(recipe.composition_source, "SELECTED_VARIANT");
  assert.equal(recipe.component_qty_sum, 24);
  assert.equal(recipe.total_units, 24);
  assert.equal(recipe.pricing?.suggested, priceFor(24)?.suggested);
});

test("a fully aligned listing has zero anomalies", () => {
  const row = assessLedgerRow(dbFixture(), liveFixture());
  assert.equal(row.perfect, true);
  assert.equal(row.highest_severity, "NONE");
  assert.deepEqual(row.anomalies, []);
});

test("Amazon CDN re-hosting is not treated as main-image drift", () => {
  const live = liveFixture();
  live.main_image_url = "https://m.media-amazon.com/images/I/MAIN.jpg";
  live.gallery_image_urls[0] =
    "https://m.media-amazon.com/images/I/INFOGRAPHIC.jpg";
  const row = assessLedgerRow(dbFixture(), live);
  const codes = new Set(row.anomalies.map((value) => value.code));
  assert.equal(codes.has("MAIN_IMAGE_DB_LIVE_DRIFT"), false);
  assert.equal(codes.has("PRICE_INFOGRAPHIC_NOT_IN_SLOT_1"), false);
  assert.equal(codes.has("PRICE_INFOGRAPHIC_IDENTITY_UNVERIFIED"), true);
});

test("a pixel-verified Amazon brand-card re-host satisfies gallery slot 1", () => {
  const live = liveFixture();
  live.gallery_image_urls[0] = [...VERIFIED_BRAND_CARD_REHOST_URLS][0];
  const row = assessLedgerRow(dbFixture(), live);
  const codes = new Set(row.anomalies.map((value) => value.code));
  assert.equal(codes.has("PRICE_INFOGRAPHIC_NOT_IN_SLOT_1"), false);
  assert.equal(codes.has("PRICE_INFOGRAPHIC_IDENTITY_UNVERIFIED"), false);
});

test("a visually rejected Amazon re-host is a hard slot-1 mismatch", () => {
  const live = liveFixture();
  live.gallery_image_urls[0] = [...REJECTED_BRAND_CARD_REHOST_URLS][0];
  const row = assessLedgerRow(dbFixture(), live);
  const codes = new Set(row.anomalies.map((value) => value.code));
  assert.equal(codes.has("PRICE_INFOGRAPHIC_NOT_IN_SLOT_1"), true);
  assert.equal(codes.has("PRICE_INFOGRAPHIC_IDENTITY_UNVERIFIED"), false);
});

test("reconciliation detects recipe, title/unit, price, image, inventory, and Amazon failures", () => {
  const db = dbFixture();
  db.master.components = [];
  db.draft!.selected_variant!.composition[0].qty = 45;
  const live = liveFixture();
  live.buyable = false;
  live.amazon_statuses = ["DISCOVERABLE"];
  live.title_total_units = 180;
  live.unit_count = 180;
  live.number_of_items = null;
  live.consumer_offer!.our_price = 129.59;
  live.consumer_offer!.minimum_seller_allowed_price = null;
  live.gallery_image_urls = [];
  live.fulfillment_availability[0].quantity = 100;
  live.issues.push({
    code: "90220",
    severity: "ERROR",
    message: "Required attribute missing",
    attribute_names: ["number_of_items"],
    categories: [],
  });
  const row = assessLedgerRow(db, live);
  const codes = new Set(row.anomalies.map((value) => value.code));
  for (const code of [
    "MASTER_COMPONENTS_MISSING",
    "RECIPE_COUNT_MISMATCH",
    "NOT_BUYABLE",
    "TITLE_COUNT_MISMATCH",
    "UNIT_COUNT_MISMATCH",
    "NUMBER_OF_ITEMS_MISMATCH",
    "OUR_PRICE_MISMATCH",
    "MIN_PRICE_MISMATCH",
    "PRICE_INFOGRAPHIC_NOT_IN_SLOT_1",
    "GALLERY_TOO_SHORT",
    "FULFILLMENT_QUANTITY_HARDCODED_100",
    "AMAZON_ISSUE_ERROR",
  ]) {
    assert.ok(codes.has(code), `missing ${code}`);
  }
  assert.equal(row.highest_severity, "CRITICAL");
  assert.equal(row.perfect, false);
});

test("404 fetch errors are classified as missing Amazon listings", () => {
  const row = assessLedgerRow(
    dbFixture(),
    failedLiveListing(new Error("SP-API 404 on GET: not found")),
  );
  assert.ok(row.anomalies.some((value) => value.code === "AMAZON_LISTING_NOT_FOUND"));
});

test("catalog reconciliation finds duplicate live ASINs and recipes", () => {
  const first = assessLedgerRow(dbFixture(), liveFixture());
  const secondDb = dbFixture();
  secondDb.channel_sku.sku = "DD-EEEE-FFFF";
  const second = assessLedgerRow(secondDb, liveFixture());
  const rows = addCatalogAnomalies([first, second]);
  assert.ok(rows.every((row) => row.anomalies.some((a) => a.code === "DUPLICATE_LIVE_ASIN")));
  assert.ok(rows.every((row) => row.anomalies.some((a) => a.code === "DUPLICATE_RECIPE")));
  const summary = summarizeLedger(rows);
  assert.equal(summary.rows, 2);
  assert.equal(summary.anomaly_counts.DUPLICATE_LIVE_ASIN, 2);
  assert.equal(summary.anomaly_counts.DUPLICATE_RECIPE, 2);
});
