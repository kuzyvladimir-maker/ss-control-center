// Unit tests for browse-node-resolver. Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/browse-node-resolver.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GIFT_BASKET_NODE,
  countDistinctBrands,
  resolveAmazonBrowseNode,
} from "../browse-node-resolver";
import { GIFT_BASKET_EXCEPTION_NODES } from "../compliance/browse-nodes";

test("DEFAULT_GIFT_BASKET_NODE is the documented primary exception node", () => {
  assert.equal(DEFAULT_GIFT_BASKET_NODE, "12011207011");
  assert.ok(GIFT_BASKET_EXCEPTION_NODES.includes(DEFAULT_GIFT_BASKET_NODE));
});

test("countDistinctBrands — empty / whitespace / case all ignored", () => {
  assert.equal(countDistinctBrands([]), 0);
  assert.equal(countDistinctBrands([{ brand: "" }, { brand: "  " }, { brand: null }]), 0);
  assert.equal(
    countDistinctBrands([
      { brand: "Eggo" },
      { brand: "EGGO" },
      { brand: " eggo " },
    ]),
    1,
  );
  assert.equal(
    countDistinctBrands([
      { brand: "Eggo" },
      { brand: "Stouffer's" },
      { brand: "Lean Cuisine" },
    ]),
    3,
  );
});

test("resolveAmazonBrowseNode — non-Amazon channels return null", () => {
  for (const ch of ["WALMART", "EBAY", "TIKTOK_1", "TIKTOK_2"]) {
    assert.equal(
      resolveAmazonBrowseNode({ channel: ch, distinct_brands: 5 }),
      null,
      `${ch} should not have a browse node assignment`,
    );
  }
});

test("resolveAmazonBrowseNode — multi-brand → Gift Basket Exception primary", () => {
  for (const ch of [
    "AMAZON_PERSONAL",
    "AMAZON_SALUTEM",
    "AMAZON_AMZCOM",
    "AMAZON_SIRIUS",
    "AMAZON_RETAILER",
  ]) {
    const node = resolveAmazonBrowseNode({ channel: ch, distinct_brands: 2 });
    assert.equal(node, DEFAULT_GIFT_BASKET_NODE);
  }
  // Many brands stays on the Gift Basket Exception path
  assert.equal(
    resolveAmazonBrowseNode({ channel: "AMAZON_AMZCOM", distinct_brands: 9 }),
    DEFAULT_GIFT_BASKET_NODE,
  );
});

test("resolveAmazonBrowseNode — single-brand still returns a non-empty Amazon node", () => {
  // Today single-brand defaults to the same Gift Basket Exception node;
  // when category-specific IDs are wired in, this test will need to
  // assert per-category mapping. The contract for now: must be non-null
  // for Amazon channels so validator-amazon-browse-node passes.
  const node = resolveAmazonBrowseNode({
    channel: "AMAZON_AMZCOM",
    distinct_brands: 1,
  });
  assert.notEqual(node, null);
  assert.ok((node ?? "").length > 0);
});

test("resolveAmazonBrowseNode — distinct_brands=0 treated as single-brand path", () => {
  // Edge: pool with all empty brands. Don't crash; pick the safe default.
  const node = resolveAmazonBrowseNode({
    channel: "AMAZON_SALUTEM",
    distinct_brands: 0,
  });
  assert.notEqual(node, null);
});
