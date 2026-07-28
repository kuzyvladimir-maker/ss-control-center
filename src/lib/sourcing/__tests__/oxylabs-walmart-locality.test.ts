import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOxylabsWalmartProductQuery,
  inferOxylabsWalmartInStock,
  parseOxylabsWalmartProductResult,
  proveOxylabsWalmartLocality,
} from "../oxylabs-fetch";

test("direct Walmart product request binds exact Clearwater store and ZIP", () => {
  assert.deepEqual(buildOxylabsWalmartProductQuery("34312392"), {
    source: "walmart_product",
    product_id: "34312392",
    parse: true,
    delivery_zip: "33765",
    store_id: "2081",
  });
  assert.throws(
    () => buildOxylabsWalmartProductQuery("34312392?other=1"),
    /OXYLABS_WALMART_PRODUCT_ID_INVALID/,
  );
});

test("proves Clearwater locality only from the structured response location", () => {
  assert.deepEqual(
    proveOxylabsWalmartLocality({
      content: { location: { zip_code: "33765", store_id: "1234" } },
    }),
    { requestedZip: "33765", responseZip: "33765", localityProven: true },
  );
});

test("accepts the provider's legacy zipcode spelling and normalizes ZIP+4", () => {
  assert.deepEqual(
    proveOxylabsWalmartLocality({
      content: { location: { zipcode: "33765-1234" } },
    }),
    { requestedZip: "33765", responseZip: "33765", localityProven: true },
  );
});

test("fails closed for missing, malformed, or mismatched response locality", () => {
  assert.equal(
    proveOxylabsWalmartLocality({ content: { location: { zip_code: "95829" } } })
      .localityProven,
    false,
  );
  assert.equal(
    proveOxylabsWalmartLocality({
      delivery_zip: "33765",
      content: { results: [] },
    }).localityProven,
    false,
  );
  assert.deepEqual(
    proveOxylabsWalmartLocality(
      { content: { location: { zip_code: "33765" } } },
      "not-a-zip",
    ),
    { requestedZip: null, responseZip: "33765", localityProven: false },
  );
});

test("requires an explicit stock or fulfillment signal", () => {
  assert.equal(inferOxylabsWalmartInStock({ fulfillment: { out_of_stock: true } }), false);
  assert.equal(inferOxylabsWalmartInStock({ fulfillment: { out_of_stock: false } }), true);
  assert.equal(inferOxylabsWalmartInStock({ general: { out_of_stock: true } }), false);
  assert.equal(inferOxylabsWalmartInStock({ general: { out_of_stock: false } }), true);
  assert.equal(inferOxylabsWalmartInStock({ fulfillment: { pickup: false, delivery: true } }), true);
  assert.equal(inferOxylabsWalmartInStock({ fulfillment: { pickup: false, delivery: false, shipping: false } }), false);
  assert.equal(inferOxylabsWalmartInStock({ general: {} }), null);
});

test("parses one direct Walmart product result without trusting the requested ID", () => {
  const parsed = parseOxylabsWalmartProductResult({
    content: {
      general: {
        url: "https://www.walmart.com/ip/RITZ-Bits-Cheese/34312392",
        meta: { sku: "5207432412", gtin: "0044000035457" },
        title: "RITZ Bits Cheese Sandwich Crackers Lunch Snacks, 8.8 oz",
        description: "Exact product description.",
        main_image: "https://i5.walmartimages.com/seo/ritz-front.jpeg?odnWidth=612",
        images: [
          "https://i5.walmartimages.com/seo/ritz-front.jpeg?odnWidth=612",
          "https://i5.walmartimages.com/seo/ritz-back.jpeg?odnWidth=612",
        ],
      },
      price: { price: 3.97, currency: "USD" },
      seller: { name: "Walmart.com" },
      fulfillment: { out_of_stock: false, shipping: true },
      location: { zip_code: "33765" },
    },
    url: "https://www.walmart.com/ip/RITZ-Bits-Cheese/34312392",
  }, "34312392", null, "2026-07-27T12:00:00.000Z");

  assert.equal(parsed.localityProven, true);
  assert.equal(parsed.responseZip, "33765");
  assert.equal(parsed.offers.length, 1);
  assert.deepEqual(parsed.offers[0], {
    retailer: "walmart",
    retailerProductId: "34312392",
    price: 3.97,
    currency: "USD",
    inStock: true,
    productUrl: "https://www.walmart.com/ip/RITZ-Bits-Cheese/34312392",
    zip: "33765",
    localityEvidence: "zip_scoped",
    observedAt: "2026-07-27T12:00:00.000Z",
    title: "RITZ Bits Cheese Sandwich Crackers Lunch Snacks, 8.8 oz",
    description: "Exact product description.",
    keyFeatures: [],
    imageUrls: [
      "https://i5.walmartimages.com/seo/ritz-front.jpeg",
      "https://i5.walmartimages.com/seo/ritz-back.jpeg",
    ],
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "Walmart.com",
    sourceApi: "oxylabs",
    via: "direct",
  });
});

test("fails closed when direct product URL Item ID conflicts or is absent", () => {
  const base = {
    content: {
      general: {
        url: "https://www.walmart.com/ip/Test/34312392",
        title: "RITZ Bits Cheese Sandwich Crackers, 8.8 oz",
      },
      price: { price: 3.97, currency: "USD" },
      seller: { name: "Walmart.com" },
      fulfillment: { out_of_stock: false },
      location: { zip_code: "33765" },
    },
  };
  assert.equal(
    parseOxylabsWalmartProductResult({
      ...base,
      content: {
        ...base.content,
        general: {
          ...base.content.general,
          url: "https://www.walmart.com/ip/Test/99999999",
          meta: { sku: "5207432412" },
        },
      },
    }, "34312392").offers.length,
    0,
  );
  assert.equal(
    parseOxylabsWalmartProductResult({
      content: {
        ...base.content,
        general: {
          title: "RITZ Bits Cheese Sandwich Crackers, 8.8 oz",
        },
      },
    }, "34312392").offers.length,
    0,
  );
});
