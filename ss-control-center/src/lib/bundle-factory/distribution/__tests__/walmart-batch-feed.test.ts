/**
 * Everything checkable before the POST is checked before the POST.
 *
 * A batched feed changes the cost of a mistake: one bad item used to cost one
 * listing, and now costs every listing sharing the feed. These are the
 * conditions the composer must refuse rather than send.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalmartBatchFeed,
  WalmartBatchFeedError,
  WALMART_BATCH_FEED_MAX_ITEMS,
} from "../walmart-batch-feed";

const HEADER = { businessUnit: "WALMART_US", locale: "en", version: "5.0.20240517-01_09022024" };

function single(sku: string, upc: string, header = HEADER) {
  return {
    sku,
    payload: {
      MPItemFeedHeader: header,
      MPItem: [
        {
          Orderable: {
            sku,
            productIdentifiers: { productIdType: "UPC", productId: upc },
          },
          Visible: { Food: { brand: "Salutem Vita" } },
        },
      ],
    },
  };
}

test("a batch keeps one header and every item, in order", () => {
  const feed = buildWalmartBatchFeed([
    single("AA-1", "756441906001"),
    single("BB-2", "756441906002"),
    single("CC-3", "756441906003"),
  ]);
  assert.deepEqual(feed.skus, ["AA-1", "BB-2", "CC-3"]);
  const payload = feed.payload as { MPItemFeedHeader: unknown; MPItem: unknown[] };
  assert.deepEqual(payload.MPItemFeedHeader, HEADER);
  assert.equal(payload.MPItem.length, 3);
  assert.equal(JSON.parse(feed.content).MPItem.length, 3);
});

test("the same seller SKU twice is refused — the poll would be ambiguous", () => {
  assert.throws(
    () => buildWalmartBatchFeed([single("AA-1", "756441906001"), single("AA-1", "756441906002")]),
    (error: unknown) =>
      error instanceof WalmartBatchFeedError && /appears twice/.test(error.message),
  );
});

test("two items sharing a product ID are refused", () => {
  assert.throws(
    () => buildWalmartBatchFeed([single("AA-1", "756441906001"), single("BB-2", "756441906001")]),
    (error: unknown) =>
      error instanceof WalmartBatchFeedError && /used by two items/.test(error.message),
  );
});

test("items built against different specs cannot share a feed", () => {
  assert.throws(
    () =>
      buildWalmartBatchFeed([
        single("AA-1", "756441906001"),
        single("BB-2", "756441906002", { ...HEADER, version: "4.7" }),
      ]),
    (error: unknown) =>
      error instanceof WalmartBatchFeedError && /different specs/.test(error.message),
  );
});

test("a payload whose Orderable SKU disagrees with its entry is refused", () => {
  const wrong = single("AA-1", "756441906001");
  (wrong.payload.MPItem[0] as { Orderable: { sku: string } }).Orderable.sku = "ZZ-9";
  assert.throws(
    () => buildWalmartBatchFeed([wrong]),
    (error: unknown) =>
      error instanceof WalmartBatchFeedError && /resolves results by exact SKU/.test(error.message),
  );
});

test("a payload that is not exactly one item is refused", () => {
  const empty = single("AA-1", "756441906001");
  empty.payload.MPItem = [];
  assert.throws(
    () => buildWalmartBatchFeed([empty]),
    (error: unknown) =>
      error instanceof WalmartBatchFeedError && /exactly one MPItem/.test(error.message),
  );
});

test("an empty batch and an oversized batch are both refused", () => {
  assert.throws(() => buildWalmartBatchFeed([]), WalmartBatchFeedError);
  const many = Array.from({ length: WALMART_BATCH_FEED_MAX_ITEMS + 1 }, (_, i) =>
    single(`SKU-${i}`, `75644190${String(6000 + i).padStart(4, "0")}`),
  );
  assert.throws(
    () => buildWalmartBatchFeed(many),
    (error: unknown) =>
      error instanceof WalmartBatchFeedError && /at most 20 items/.test(error.message),
  );
});

test("a single-item batch is still a valid feed", () => {
  const feed = buildWalmartBatchFeed([single("AA-1", "756441906001")]);
  assert.equal((feed.payload as { MPItem: unknown[] }).MPItem.length, 1);
  assert.deepEqual(feed.skus, ["AA-1"]);
});
