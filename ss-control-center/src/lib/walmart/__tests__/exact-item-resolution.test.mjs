import assert from "node:assert/strict";
import test from "node:test";

import {
  EXACT_ITEM_RESOLUTION_SCHEMA,
  resolveExactWalmartItemCandidate,
} from "../exact-item-resolution.ts";

const sku = "FaisalX-1130";
const title = "Pepperidge Farm Whole Grain Thin Sliced 15 Grain Bread, 22 oz (Pack of 2)";
const image = "https://i5.walmartimages.com/seo/Pepperidge-Farm_bread.hash.png";

function seller(overrides = {}) {
  return {
    ItemResponse: [{
      sku,
      productName: title,
      upc: "684611898401",
      gtin: "00684611898401",
      wpid: "2IAXRO7DM5YP",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
      ...overrides,
    }],
    totalItems: 1,
  };
}

function catalogItem(overrides = {}) {
  return {
    itemId: "8412702942",
    standardUpc: ["00684611898401"],
    title,
    isMarketPlaceItem: true,
    images: [{ url: image }],
    ...overrides,
  };
}

test("resolves exact GTIN duplicates to one catalog candidate, never a PDP verification", () => {
  const result = resolveExactWalmartItemCandidate(sku, seller(), {
    items: [
      catalogItem({ brand: "Pepperidge Farm" }),
      catalogItem({
        images: [{ url: `${image}?odnHeight=180&odnWidth=180&odnBg=FFFFFF` }],
        properties: { variantItemsNum: "3" },
      }),
    ],
  });

  assert.equal(result.schema_version, EXACT_ITEM_RESOLUTION_SCHEMA);
  assert.equal(result.buyer_facing_verified, false);
  assert.equal(result.seller.gtin14, "00684611898401");
  assert.equal(result.seller.wpid, "2IAXRO7DM5YP");
  assert.equal(result.catalog_search_candidate.item_id, "8412702942");
  assert.equal(result.catalog_search_candidate.main_image_url, image);
  assert.equal(result.catalog_search_candidate.duplicate_rows_collapsed, 2);
  assert.equal(result.source_contract.positional_or_fuzzy_fallbacks, 0);
  assert.match(result.source_hashes.seller_payload_canonical_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.source_hashes.catalog_search_payload_canonical_sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.identity_evidence.includes("seller.wpid_not_itemId=2IAXRO7DM5YP"));
});

test("fails closed when exact standardUpc maps to two public itemIds", () => {
  assert.throws(
    () => resolveExactWalmartItemCandidate(sku, seller(), {
      items: [catalogItem(), catalogItem({ itemId: "9999999999" })],
    }),
    /maps to 2 unique numeric public itemIds/,
  );
});

test("fails closed on catalog standardUpc mismatch", () => {
  assert.throws(
    () => resolveExactWalmartItemCandidate(sku, seller(), {
      items: [catalogItem({ standardUpc: ["00000000000000"] })],
    }),
    /no exact standardUpc match/,
  );
});

test("fails closed when seller UPC and GTIN disagree", () => {
  assert.throws(
    () => resolveExactWalmartItemCandidate(
      sku,
      seller({ gtin: "00000000000000" }),
      { items: [catalogItem()] },
    ),
    /seller UPC and GTIN disagree/,
  );
});

test("fails closed when exact catalog match has no numeric public itemId", () => {
  assert.throws(
    () => resolveExactWalmartItemCandidate(sku, seller(), {
      items: [catalogItem({ itemId: "2IAXRO7DM5YP" })],
    }),
    /has no numeric public itemId/,
  );
});

test("fails closed when exact catalog match omits public itemId", () => {
  assert.throws(
    () => resolveExactWalmartItemCandidate(sku, seller(), {
      items: [catalogItem({ itemId: undefined })],
    }),
    /has no numeric public itemId/,
  );
});

test("fails closed on seller SKU mismatch", () => {
  assert.throws(
    () => resolveExactWalmartItemCandidate(sku, seller({ sku: "Wrong-SKU" }), {
      items: [catalogItem()],
    }),
    /exact-SKU seller row, found 0/,
  );
});

test("fails closed when duplicate rows disagree on identity-critical fields", () => {
  assert.throws(
    () => resolveExactWalmartItemCandidate(sku, seller(), {
      items: [
        catalogItem(),
        catalogItem({
          images: [{ url: "https://i5.walmartimages.com/seo/different.png" }],
        }),
      ],
    }),
    /duplicate catalog rows are not field-equivalent/,
  );
});
