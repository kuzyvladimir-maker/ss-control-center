import assert from "node:assert/strict";
import { test } from "node:test";

import { isGrowthAdvisorPriceAttribute } from "./price-write-guard";

test("Growth Advisor price guard blocks top-level, nested, and pointer paths", () => {
  for (const attribute of [
    "purchasable_offer",
    "purchasable_offer.our_price",
    "/attributes/purchasable_offer/0/discounted_price",
    "business_price",
    "discounted_price",
    "list_price",
  ]) {
    assert.equal(isGrowthAdvisorPriceAttribute(attribute), true, attribute);
  }
  assert.equal(isGrowthAdvisorPriceAttribute("unit_count"), false);
  assert.equal(isGrowthAdvisorPriceAttribute("item_name"), false);
});
