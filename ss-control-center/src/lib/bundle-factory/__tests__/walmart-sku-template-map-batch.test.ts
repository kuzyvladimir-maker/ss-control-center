/**
 * The associations must batch too, or batching the items buys nothing: the
 * rate limit counts feeds, not the items inside them.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalmartSkuTemplateMapBatch,
  buildWalmartSkuTemplateMapContract,
} from "../walmart-shipping-template-association";

const one = (sku: string) => ({
  sku,
  shipping_template_id: "TPL-1",
  fulfillment_center_id: "FC-1",
});

test("many SKUs travel under one header", () => {
  const contract = buildWalmartSkuTemplateMapBatch([one("AA-1"), one("BB-2"), one("CC-3")]);
  const payload = contract.payload as unknown as {
    ItemFeedHeader: unknown;
    ItemFeed: Array<{ sku: string; actionType: string }>;
  };
  assert.equal(payload.ItemFeed.length, 3);
  assert.deepEqual(payload.ItemFeed.map((row) => row.sku), ["AA-1", "BB-2", "CC-3"]);
  assert.ok(payload.ItemFeed.every((row) => row.actionType === "Add"));
  assert.deepEqual(
    payload.ItemFeedHeader,
    (buildWalmartSkuTemplateMapContract(one("AA-1")).payload as unknown as {
      ItemFeedHeader: unknown;
    }).ItemFeedHeader,
  );
});

test("one SKU produces the same item as the single-SKU builder", () => {
  const batch = buildWalmartSkuTemplateMapBatch([one("AA-1")]);
  const single = buildWalmartSkuTemplateMapContract(one("AA-1"));
  assert.deepEqual(
    (batch.payload as unknown as { ItemFeed: unknown[] }).ItemFeed,
    (single.payload as unknown as { ItemFeed: unknown[] }).ItemFeed,
  );
});

test("a duplicate SKU is refused", () => {
  assert.throws(
    () => buildWalmartSkuTemplateMapBatch([one("AA-1"), one("AA-1")]),
    /appears twice/,
  );
});

test("an empty batch is refused", () => {
  assert.throws(() => buildWalmartSkuTemplateMapBatch([]), /at least one SKU/);
});

test("a missing template or ship node is refused, not defaulted", () => {
  assert.throws(
    () => buildWalmartSkuTemplateMapBatch([{ ...one("AA-1"), shipping_template_id: "" }]),
    /Shipping template ID is required/,
  );
  assert.throws(
    () => buildWalmartSkuTemplateMapBatch([{ ...one("AA-1"), fulfillment_center_id: "  " }]),
    /Fulfillment center ID is required/,
  );
});
