import assert from "node:assert/strict";
import test from "node:test";

import {
  inferOxylabsWalmartInStock,
  proveOxylabsWalmartLocality,
} from "../oxylabs-fetch";

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
  assert.equal(inferOxylabsWalmartInStock({ general: { out_of_stock: true } }), false);
  assert.equal(inferOxylabsWalmartInStock({ general: { out_of_stock: false } }), true);
  assert.equal(inferOxylabsWalmartInStock({ fulfillment: { pickup: false, delivery: true } }), true);
  assert.equal(inferOxylabsWalmartInStock({ fulfillment: { pickup: false, delivery: false, shipping: false } }), false);
  assert.equal(inferOxylabsWalmartInStock({ general: {} }), null);
});
