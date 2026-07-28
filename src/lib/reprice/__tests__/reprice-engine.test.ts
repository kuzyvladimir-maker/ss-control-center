import { test } from "node:test";
import assert from "node:assert/strict";

import { decideReprice } from "../reprice-engine";
import type { SkuOffers } from "@/lib/amazon-sp-api/pricing";

function losingOffer(): SkuOffers {
  return {
    sku: "TEST-SKU",
    ok: true,
    totalOfferCount: 2,
    buyBoxLanded: 95,
    offers: [
      {
        mine: true,
        isFeatured: false,
        isBuyBoxWinner: false,
        listingPrice: 100,
        shipping: 0,
        landed: 100,
      },
      {
        mine: false,
        isFeatured: true,
        isBuyBoxWinner: true,
        listingPrice: 95,
        shipping: 0,
        landed: 95,
      },
    ],
  };
}

test("Featured Offer repricer never changes an Uncrustables base price", () => {
  const decision = decideReprice(
    { sku: "TEST-SKU", title: "Uncrustables Strawberry Frozen Sandwiches, 30 Count" },
    losingOffer(),
  );
  assert.equal(decision.action, "skipped_price_locked");
  assert.equal(decision.newPrice, null);
  assert.match(decision.reason ?? "", /coupons/i);
});

test("Featured Offer repricer keeps generic SKU behavior", () => {
  const decision = decideReprice(
    { sku: "TEST-SKU", title: "Generic Grocery Bundle" },
    losingOffer(),
  );
  assert.equal(decision.action, "repriced");
  assert.equal(decision.newPrice, 94.99);
});
