import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalmartNewSkuCommercialDiscovery,
  type WalmartNewSkuCommercialDiscoveryRow,
} from "../walmart-new-sku-commercial-discovery";

const AS_OF = "2026-07-23T06:30:00.000Z";

function row(input: Partial<WalmartNewSkuCommercialDiscoveryRow> & {
  offer_id: string;
  retailer: string;
  price: number;
}): WalmartNewSkuCommercialDiscoveryRow {
  return {
    donor_product_id: "donor-1",
    title: "Example Shelf Stable Snack 4 oz",
    brand: "Example",
    size: "4 oz",
    category: "Dry Grocery",
    manufacturer_upc: "012345678905",
    description: "Exact product description",
    ingredients: "Corn, salt",
    nutrition_facts: "{}",
    main_image_url: "https://example.com/main.jpg",
    image_urls: JSON.stringify([
      "https://example.com/main.jpg",
      "https://example.com/nutrition.jpg",
    ]),
    needs_review: 0,
    retailer_product_id: `${input.retailer}-item`,
    via: "direct",
    pack_size_seen: 1,
    price_per_unit: input.price,
    zip: "33765",
    locality_evidence: "zip_scoped",
    in_stock: 1,
    is_first_party: 1,
    offer_title: "Example Shelf Stable Snack 4 oz",
    product_url: `https://${input.retailer}.example/item`,
    fetched_at: "2026-07-22T12:00:00.000Z",
    ...input,
  };
}

test("commercial discovery prices to 30% margin and keeps the comparable informational", () => {
  const discovery = buildWalmartNewSkuCommercialDiscovery({
    rows: [
      row({ offer_id: "walmart", retailer: "walmart", price: 10 }),
      row({ offer_id: "target", retailer: "target", price: 2 }),
    ],
    asOf: AS_OF,
    packCount: 2,
  });

  assert.equal(discovery.authority,
    "PROVISIONAL_PRODUCT_TRUTH_GAP_PRIORITY_ONLY_NOT_LISTING_TRUTH");
  assert.equal(discovery.full_seller_catalog_read, false);
  assert.equal(discovery.paid_provider_calls, 0);
  assert.equal(discovery.marketplace_calls, 0);
  assert.equal(discovery.candidates.length, 1);
  assert.deepEqual(discovery.candidates[0]!.provisional_economics, {
    goods_cents: 400,
    packaging_cents: 150,
    seller_shipping_label_cents: 878,
    referral_fee_bps: 1500,
    target_margin_bps: 3000,
    minimum_item_price_cents: 2598,
    linearized_walmart_comparable_cents: 2000,
    proposed_to_comparable_ratio_bps: 12990,
    price_competitiveness_signal: "ABOVE_EXACT_COMPARABLE_WARNING",
    source_discount_bps: 8000,
  });
  assert.equal(
    discovery.claims.walmart_comparable_is_informational_not_candidate_rejection,
    true,
  );
  assert.equal(discovery.claims.walmart_pricing_rule_can_still_unpublish, true);
});

test("same-price Walmart sourcing remains viable when 30% margin determines price", () => {
  const discovery = buildWalmartNewSkuCommercialDiscovery({
    rows: [
      row({ offer_id: "walmart", retailer: "walmart", price: 3.97 }),
    ],
    asOf: AS_OF,
    packCount: 2,
  });
  assert.equal(discovery.candidates.length, 1);
  assert.equal(discovery.candidates[0]!.source_offer.retailer, "walmart");
  assert.equal(
    discovery.candidates[0]!.provisional_economics.minimum_item_price_cents,
    3313,
  );
  assert.equal(
    discovery.candidates[0]!.provisional_economics
      .price_competitiveness_signal,
    "ABOVE_EXACT_COMPARABLE_WARNING",
  );
});

test("Amazon and club offers cannot displace an allowed Walmart source", () => {
  const discovery = buildWalmartNewSkuCommercialDiscovery({
    rows: [
      row({ offer_id: "walmart", retailer: "walmart", price: 20 }),
      row({ offer_id: "amazon", retailer: "amazon", price: 1 }),
      row({ offer_id: "bjs", retailer: "bjs", price: 1 }),
      row({ offer_id: "sams", retailer: "samsclub", price: 1 }),
      row({ offer_id: "costco", retailer: "costco", price: 1 }),
    ],
    asOf: AS_OF,
    packCount: 3,
  });
  assert.equal(discovery.candidates.length, 1);
  assert.equal(discovery.candidates[0]!.source_offer.retailer, "walmart");
  assert.equal(discovery.claims.clubs_require_separate_owner_approved_plan, true);
});

test("risk categories and incomplete legacy content never enter the shortlist", () => {
  const frozen = [
    row({
      offer_id: "frozen-walmart",
      retailer: "walmart",
      price: 20,
      donor_product_id: "frozen",
      title: "Frozen Snack",
      category: "Frozen",
    }),
    row({
      offer_id: "frozen-target",
      retailer: "target",
      price: 1,
      donor_product_id: "frozen",
      title: "Frozen Snack",
      category: "Frozen",
    }),
  ];
  const incomplete = [
    row({
      offer_id: "incomplete-walmart",
      retailer: "walmart",
      price: 20,
      donor_product_id: "incomplete",
      ingredients: null,
    }),
    row({
      offer_id: "incomplete-target",
      retailer: "target",
      price: 1,
      donor_product_id: "incomplete",
      ingredients: null,
    }),
  ];
  const discovery = buildWalmartNewSkuCommercialDiscovery({
    rows: [...frozen, ...incomplete],
    asOf: AS_OF,
    packCount: 2,
  });
  assert.deepEqual(discovery.candidates, []);
});

test("stale materialized prices stay visibly provisional", () => {
  const discovery = buildWalmartNewSkuCommercialDiscovery({
    rows: [
      row({
        offer_id: "walmart",
        retailer: "walmart",
        price: 10,
        fetched_at: "2026-07-01T00:00:00.000Z",
      }),
      row({
        offer_id: "target",
        retailer: "target",
        price: 2,
        fetched_at: null,
      }),
    ],
    asOf: AS_OF,
    packCount: 2,
  });
  assert.equal(
    discovery.candidates[0]!.walmart_comparable.stale_or_unparseable,
    true,
  );
  assert.equal(
    discovery.candidates[0]!.source_offer.stale_or_unparseable,
    true,
  );
  assert.equal(
    discovery.candidates[0]!.evidence_status,
    "SHORTLIST_ONLY_REQUIRES_FRESH_EXACT_EVIDENCE",
  );
});

test("merged cross-size SKIPPY rows are rejected before economics", () => {
  const product = {
    donor_product_id: "skippy-merged",
    title:
      "SKIPPY Peanut Butter, Creamy, 7 g Protein Per Serving, Shelf-Stable, 80 oz Plastic Jar",
    brand: "SKIPPY",
    size: "7 g",
    manufacturer_upc: "037600225106",
  };
  const discovery = buildWalmartNewSkuCommercialDiscovery({
    rows: [
      row({
        ...product,
        offer_id: "skippy-walmart",
        retailer: "walmart",
        price: 10.28,
        offer_title: "SKIPPY Creamy Peanut Butter 64 oz Plastic Jar",
        product_url:
          "https://www.walmart.com/ip/SKIPPY-Creamy-Peanut-Butter-64-oz/37447685",
      }),
      row({
        ...product,
        offer_id: "skippy-publix",
        retailer: "publix",
        price: 3.71,
        offer_title: "SKIPPY Creamy Peanut Butter 16.3 oz",
        product_url:
          "https://delivery.publix.com/products/skippy-creamy-peanut-butter-16-3-oz",
      }),
    ],
    asOf: AS_OF,
    packCount: 3,
  });
  assert.deepEqual(discovery.candidates, []);
});
