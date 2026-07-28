// Unit tests for donor flavor dedup + per-unit cost parsing — the pre-planner
// normalisation that stops "Strawberry + Strawberry" mixes and pack-price COGS.
//   npx tsx --test src/lib/bundle-factory/__tests__/donor-dedup.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePackUnits,
  canonicalFlavorKey,
  donorUnitPriceCents,
  normalizedOfferUnitPriceCents,
  dedupeDonorFlavors,
  type DedupableDonor,
} from "@/lib/bundle-factory/donor-dedup";

const mk = (o: Partial<DedupableDonor> & { id: string }): DedupableDonor => ({
  title: null, brand: "Smucker's", productLine: "Uncrustables", flavor: null,
  bestPrice: null, ...o,
});

// Real catalog titles (Reference Catalog, 2026-07-07).
const T = {
  straw4: "Smuckers Uncrustables Peanut Butter & Strawberry Jam Sandwiches, 4 Count, 2 oz",
  straw10: "Smuckers Uncrustables Peanut Butter & Strawberry Jam Sandwiches, 10 Count, 2 oz",
  straw8oz: "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct",
  straw20oz: "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich – 20oz",
  grape10: "Smuckers Uncrustables Peanut Butter & Grape Jelly Sandwiches, 10 Count, 2 oz",
  wheat: "Smucker's Uncrustables Frozen Whole Wheat Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct",
  choc: "Smuckers Uncrustables Chocolate Flavored Hazelnut Spread Sandwiches, 4 Count",
  bigTwo: "Smucker's 2ct/30oz Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich",
};

test("parsePackUnits — Count / ct / Noz-slash-Nct / ct-first patterns", () => {
  assert.equal(parsePackUnits(T.straw10), 10);
  assert.equal(parsePackUnits(T.straw4), 4);
  assert.equal(parsePackUnits(T.straw8oz), 4);
  assert.equal(parsePackUnits(T.bigTwo), 2);
  assert.equal(parsePackUnits(T.straw20oz), null); // no count in title
  assert.equal(parsePackUnits(null), null);
});

test("canonicalFlavorKey — same flavor across retailers/sizes → same key", () => {
  const o = { brand: "Smucker's", productLine: "Uncrustables" };
  const a = canonicalFlavorKey(T.straw4, o);
  assert.equal(canonicalFlavorKey(T.straw10, o), a);
  assert.equal(canonicalFlavorKey(T.straw8oz, o), a);
  assert.equal(canonicalFlavorKey(T.straw20oz, o), a);
  assert.equal(canonicalFlavorKey(T.bigTwo, o), a);
  assert.match(a, /peanut butter & strawberry jam/);
});

test("canonicalFlavorKey — distinct variants stay distinct", () => {
  const o = { brand: "Smucker's", productLine: "Uncrustables" };
  const straw = canonicalFlavorKey(T.straw4, o);
  assert.notEqual(canonicalFlavorKey(T.wheat, o), straw); // Whole Wheat ≠ plain
  assert.notEqual(canonicalFlavorKey(T.grape10, o), straw);
  assert.notEqual(canonicalFlavorKey(T.choc, o), straw);
});

test("donorUnitPriceCents — bestPrice is already the per-unit catalog rollup", () => {
  assert.equal(donorUnitPriceCents(mk({ id: "a", title: T.straw10, bestPrice: 0.98 })), 98);
  assert.equal(donorUnitPriceCents(mk({ id: "b", title: T.straw4, bestPrice: 0.99 })), 99);
  assert.equal(donorUnitPriceCents(mk({ id: "c", title: T.straw20oz, bestPrice: 1.05 })), 105);
  assert.equal(donorUnitPriceCents(mk({ id: "d", title: T.straw10, bestPrice: null })), null);
});

test("raw offer total is normalized by retail carton count before bestPrice", () => {
  const row = mk({
    id: "raw-offer",
    title: "Uncrustables Peanut Butter & Grape Jelly, 10 Count",
    bestPrice: 9.84,
    offers: [{ price: 9.84, packSizeSeen: 10, pricePerUnit: 9.84 }],
  });
  assert.equal(normalizedOfferUnitPriceCents(row), 98);
  assert.equal(donorUnitPriceCents(row), 98);
});

test("dedupeDonorFlavors — one entry per flavor, cheapest per-unit donor wins", () => {
  const donors = [
    mk({ id: "s4", title: T.straw4, bestPrice: 0.99 }),
    mk({ id: "s10", title: T.straw10, bestPrice: 0.98 }), // winner
    mk({ id: "s20", title: T.straw20oz, bestPrice: 1.05 }),
    mk({ id: "g10", title: T.grape10, bestPrice: 0.98 }),
    mk({ id: "ww", title: T.wheat, bestPrice: 0.97 }),
    mk({ id: "ch", title: T.choc, bestPrice: 0.99 }),
  ];
  const entries = dedupeDonorFlavors(donors);
  assert.equal(entries.length, 4); // strawberry, grape, whole-wheat straw, chocolate
  const straw = entries.find((e) => /strawberry/.test(e.key) && !/wheat/.test(e.key))!;
  assert.equal(straw.donor.id, "s10");
  assert.equal(straw.unit_price_cents, 98);
  assert.ok(straw.costable);
});

test("dedupeDonorFlavors — missing bestPrice is un-costable regardless of title count", () => {
  const donors = [
    mk({ id: "s20", title: T.straw20oz, bestPrice: null }),
    mk({ id: "g10", title: T.grape10, bestPrice: 0.98 }),
  ];
  const entries = dedupeDonorFlavors(donors);
  const straw = entries.find((e) => /strawberry/.test(e.key))!;
  assert.equal(straw.costable, false);
  assert.equal(straw.unit_price_cents, null);
  const grape = entries.find((e) => /grape/.test(e.key))!;
  assert.ok(grape.costable);
});

test("dedupeDonorFlavors — explicit flavor column wins over title parsing", () => {
  const donors = [
    mk({ id: "x1", title: T.straw4, flavor: "PB & Strawberry", bestPrice: 0.99 }),
    mk({ id: "x2", title: T.straw10, flavor: "pb & strawberry", bestPrice: 0.98 }),
  ];
  const entries = dedupeDonorFlavors(donors);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].donor.id, "x2"); // cheaper per unit
});

test("dedupeDonorFlavors — inconsistent brand fields don't split a flavor (prod leak 2026-07-07)", () => {
  // Catalog reality: same flavor, brand recorded three different ways.
  const donors = [
    mk({ id: "a", brand: "Uncrustables", productLine: null,
      title: "Smuckers Uncrustables Peanut Butter & Strawberry Jam Sandwiches, 10 Count, 2 oz", bestPrice: 0.98 }),
    mk({ id: "b", brand: "Smucker'S", productLine: null,
      title: "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct", bestPrice: 0.97 }),
    mk({ id: "c", brand: null, productLine: null,
      title: "Smuckers Uncrustables Peanut Butter & Strawberry Jam Sandwiches, 4 Count", bestPrice: 0.99 }),
  ];
  const entries = dedupeDonorFlavors(donors);
  assert.equal(entries.length, 1); // ONE strawberry flavor, not three
  assert.equal(entries[0].donor.id, "b"); // $0.97/unit is cheapest
  assert.ok(!/smucker|uncrustable/i.test(entries[0].label), entries[0].label);
});
