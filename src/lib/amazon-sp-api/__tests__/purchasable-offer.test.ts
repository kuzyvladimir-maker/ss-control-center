// `purchasable_offer` is ONE attribute holding every offer entry, and a
// JSON-Patch `replace` overwrites the whole array. Sending only `our_price`
// therefore DELETES the B2B offer and the min/max bounds a repricer reads —
// which is exactly what setListingPrice used to do. These tests pin the merge.
//
//   npx tsx --test src/lib/amazon-sp-api/__tests__/purchasable-offer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isUncrustablesListingItem,
  mergePurchasableOffer,
  priceSchedule,
  sanitizeOfferEntry,
} from "../pricing";

/** Shape as Amazon actually returns it for a live listing (S1-KJU0-VX88). */
function liveOffer() {
  return [
    {
      currency: "USD",
      start_at: { value: "2023-09-09T01:41:04.759Z" },
      end_at: { value: null }, // open-ended — Amazon rejects a null echoed back
      audience: "ALL",
      our_price: priceSchedule(40.57),
      maximum_seller_allowed_price: priceSchedule(77),
      minimum_seller_allowed_price: priceSchedule(28.92),
      marketplace_id: "ATVPDKIKX0DER",
    },
    {
      currency: "USD",
      audience: "B2B",
      our_price: priceSchedule(29.28),
      marketplace_id: "ATVPDKIKX0DER",
    },
  ];
}

const priceOf = (e: Record<string, unknown>) =>
  (e.our_price as Array<{ schedule: Array<{ value_with_tax: number }> }>)[0].schedule[0].value_with_tax;

test("merge rewrites our_price on the consumer offer only", () => {
  const out = mergePurchasableOffer(liveOffer(), { price: 39.9 });
  assert.equal(out.length, 2);
  assert.equal(priceOf(out[0]), 39.9);
  assert.equal(out[1].audience, "B2B");
  assert.equal(priceOf(out[1]), 29.28, "B2B offer must survive untouched");
});

test("merge preserves the repricer band when it isn't being changed", () => {
  const out = mergePurchasableOffer(liveOffer(), { price: 39.9 });
  const min = out[0].minimum_seller_allowed_price as Array<{ schedule: Array<{ value_with_tax: number }> }>;
  const max = out[0].maximum_seller_allowed_price as Array<{ schedule: Array<{ value_with_tax: number }> }>;
  assert.equal(min[0].schedule[0].value_with_tax, 28.92);
  assert.equal(max[0].schedule[0].value_with_tax, 77);
});

test("merge moves the band when min/max are supplied", () => {
  const out = mergePurchasableOffer(liveOffer(), { price: 86.25, minPrice: 86.25, maxPrice: 86.25 });
  const min = out[0].minimum_seller_allowed_price as Array<{ schedule: Array<{ value_with_tax: number }> }>;
  const max = out[0].maximum_seller_allowed_price as Array<{ schedule: Array<{ value_with_tax: number }> }>;
  assert.equal(priceOf(out[0]), 86.25);
  assert.equal(min[0].schedule[0].value_with_tax, 86.25);
  assert.equal(max[0].schedule[0].value_with_tax, 86.25, "min=max=target pins a repricer");
});

test("merge strips end_at:{value:null} (Amazon rejects an echoed null)", () => {
  const out = mergePurchasableOffer(liveOffer(), { price: 39.9 });
  assert.equal("end_at" in out[0], false);
  assert.equal((out[0].start_at as { value: string }).value, "2023-09-09T01:41:04.759Z", "start_at is kept");
});

test("merge creates a consumer offer when the listing has none", () => {
  const out = mergePurchasableOffer(undefined, { price: 12.5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].audience, "ALL");
  assert.equal(priceOf(out[0]), 12.5);
});

test("an entry with no audience counts as the consumer offer", () => {
  const out = mergePurchasableOffer([{ currency: "USD", our_price: priceSchedule(10) }], { price: 11 });
  assert.equal(out.length, 1, "must not append a duplicate ALL entry");
  assert.equal(priceOf(out[0]), 11);
});

test("sanitizeOfferEntry drops only {value:null} wrappers", () => {
  const clean = sanitizeOfferEntry({ a: { value: null }, b: { value: "x" }, c: 1, d: [1, 2] });
  assert.equal("a" in clean, false);
  assert.deepEqual(clean.b, { value: "x" });
  assert.equal(clean.c, 1);
  assert.deepEqual(clean.d, [1, 2]);
});

test("Uncrustables identity lock uses live brand/title but not generic Smucker products", () => {
  assert.equal(isUncrustablesListingItem({
    attributes: { brand: [{ value: "Uncrustables" }] },
  }), true);
  assert.equal(isUncrustablesListingItem({
    summaries: [{ marketplaceId: "ATVPDKIKX0DER", itemName: "Uncrustables Strawberry 30 Count" }],
  }), true);
  assert.equal(isUncrustablesListingItem({
    attributes: { brand: [{ value: "Smucker's" }], item_name: [{ value: "Smucker's Jam" }] },
  }), false);
});
