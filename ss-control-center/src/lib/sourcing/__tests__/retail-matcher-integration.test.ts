import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { scoreOffer, type CanonicalProduct, type RetailOffer } from "../retail-fetch";

const target: CanonicalProduct = {
  brand: "Acme",
  product_line: "Potato Chips",
  flavor: "Original",
  base_unit: "Bag",
  size: "8 oz",
  outer_pack_count: 1,
};

function offer(title: string): RetailOffer {
  return {
    retailer: "publix",
    retailerProductId: title,
    price: 3.99,
    currency: "USD",
    inStock: true,
    productUrl: "https://example.test/product",
    zip: "33765",
    localityEvidence: "zip_scoped",
    observedAt: "2026-07-18T20:00:00.000Z",
    title,
    description: null,
    keyFeatures: [],
    imageUrls: [],
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "publix",
    sourceApi: "test",
    via: "direct",
  };
}

test("SKU-specific retailer gate accepts only canonical exact identity", () => {
  const exact = scoreOffer(offer("Acme Potato Chips Original Bag, 8 oz"), target);
  assert.equal(exact.accepted, true);
  assert.equal(exact.identityMatch?.verdict, "EXACT_IDENTITY");

  const adjacent = scoreOffer(offer("Acme Potato Chips Original Spicy Bag, 8 oz"), target);
  assert.equal(adjacent.accepted, false);
  assert.equal(adjacent.identityMatch?.verdict, "REJECT");
  assert.ok(adjacent.identityMatch?.reasonCodes.includes("TITLE_UNEXPLAINED_CANDIDATE_TOKEN"));
});

test("outer multipack and token substrings cannot become exact", () => {
  const multipack = scoreOffer(offer("2 Pack Acme Potato Chips Original Bag, 8 oz"), target);
  assert.equal(multipack.accepted, false);
  assert.ok(multipack.identityMatch?.reasonCodes.includes("OUTER_PACK_COUNT_MISMATCH"));

  const doveTarget: CanonicalProduct = {
    brand: "Dove",
    product_line: "Promises",
    flavor: "Milk Chocolate",
    base_unit: "Candy",
    size: "7.61 oz",
    outer_pack_count: 1,
  };
  const substring = scoreOffer(offer("Dover Promises Milk Chocolate Candy, 7.61 oz"), doveTarget);
  assert.equal(substring.accepted, false);
  assert.ok(substring.identityMatch?.reasonCodes.includes("TITLE_BRAND_NOT_FOUND"));
});

test("retailer escalation uses matcher verdict plus locality/freshness policy", () => {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const source = readFileSync(resolve(project, "src/lib/sourcing/donor-catalog.ts"), "utf8");
  const start = source.indexOf("const strictHit");
  const end = source.indexOf("const now = evaluationNow", start);
  const strictHit = source.slice(start, end);
  assert.match(strictHit, /o\.identityMatch/);
  assert.match(strictHit, /evaluatePriceEvidenceEligibility/);
  assert.doesNotMatch(strictHit, /\.includes\(b\)|\.includes\(k\)/);
});
