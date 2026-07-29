import { test } from "node:test";
import assert from "node:assert/strict";

import {
  studioChannelRoute,
  WALMART_CANONICAL_OPERATOR_MESSAGE,
} from "@/lib/bundle-factory/studio-channel-routing";
import {
  buildWalmartStudioWorkItems,
  parseWalmartPromptIntent,
  resolveWalmartStudioRequestIntent,
} from "@/lib/bundle-factory/walmart-studio-request";
import { scoreProductTruthWalmartRequestMatch } from
  "@/lib/sourcing/product-truth-read-contract";

test("legacy Studio routes Amazon normally but never creates Walmart work", () => {
  assert.equal(studioChannelRoute("AMAZON_SALUTEM"), "LEGACY_STUDIO_ALLOWED");
  assert.equal(studioChannelRoute("AMAZON_PERSONAL"), "LEGACY_STUDIO_ALLOWED");
  assert.equal(
    studioChannelRoute("WALMART"),
    "CANONICAL_WALMART_OPERATOR_REQUIRED",
  );
  assert.match(WALMART_CANONICAL_OPERATOR_MESSAGE, /Bundle Factory Walmart pilot/);
  assert.match(WALMART_CANONICAL_OPERATOR_MESSAGE, /walmart:new-sku/);
});

test("Russian Campbell's request preserves 5 listings and 8 cans instead of applying defaults", () => {
  const prompt =
    "Готовь мне 5 листингов с супами консервированными Campbell's. " +
    "Фасовка должна быть по 8 банок в одном листинге.";

  assert.deepEqual(parseWalmartPromptIntent(prompt), {
    listing_count: 5,
    pack_count: 8,
  });

  const request = resolveWalmartStudioRequestIntent({
    prompt,
    listingCount: null,
    packCount: null,
  });
  assert.equal(request.listing_count, 5);
  assert.equal(request.pack_count, 8);
  assert.deepEqual(request.blockers, []);
  assert.deepEqual(buildWalmartStudioWorkItems(request), [
    { ordinal: 1, listing_count: 1, pack_count: 8 },
    { ordinal: 2, listing_count: 1, pack_count: 8 },
    { ordinal: 3, listing_count: 1, pack_count: 8 },
    { ordinal: 4, listing_count: 1, pack_count: 8 },
    { ordinal: 5, listing_count: 1, pack_count: 8 },
  ]);
});

test("structured Walmart fields must agree with numbers written in the prompt", () => {
  const request = resolveWalmartStudioRequestIntent({
    prompt: "Create 2 listings, pack of 3",
    listingCount: 1,
    packCount: 2,
  });

  assert.deepEqual(
    request.blockers.map((blocker) => blocker.code),
    ["LISTING_COUNT_CONFLICT", "PACK_COUNT_CONFLICT"],
  );
  assert.deepEqual(
    request.blockers.map((blocker) => blocker.kind),
    ["INPUT_CONFLICT", "INPUT_CONFLICT"],
  );
});

test("Walmart request defaults remain explicit", () => {
  assert.deepEqual(
    resolveWalmartStudioRequestIntent({
      prompt: "Create Campbell's soup multipacks",
      listingCount: null,
      packCount: null,
    }),
    {
      listing_count: 2,
      pack_count: 2,
      prompt_listing_count: null,
      prompt_pack_count: null,
      blockers: [],
    },
  );

  const accepted = resolveWalmartStudioRequestIntent({
    prompt: "Create 1 listing with 3 cans per listing",
    listingCount: 1,
    packCount: 3,
  });
  assert.equal(accepted.listing_count, 1);
  assert.equal(accepted.pack_count, 3);
  assert.deepEqual(accepted.blockers, []);
});

test("Product Truth request matcher finds the Campbell's brand inside a Russian Walmart brief", () => {
  const query =
    "Создай 5 листингов с использованием консервированных супов Campbell's, по 8 банок.";
  assert.ok(
    scoreProductTruthWalmartRequestMatch({
      query,
      title: "Campbell's Condensed Tomato Soup, 10.75 oz Can",
      brand: "Campbell's",
      productLine: "Condensed Soup",
      flavor: "Tomato",
      category: "Canned Soup",
    }) >= 30,
  );
  assert.equal(
    scoreProductTruthWalmartRequestMatch({
      query,
      title: "RITZ Bits Cheese Sandwich Crackers, 8.8 oz",
      brand: "RITZ",
      productLine: "Bits",
      flavor: "Cheese",
      category: "Crackers",
    }),
    0,
  );
});
