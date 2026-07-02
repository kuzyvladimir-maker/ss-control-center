// Unit tests for the mass-generator variation planner.
//   npx tsx --test src/lib/bundle-factory/__tests__/variation-planner.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { planVariations, splitCount, type PlannerFlavor } from "@/lib/bundle-factory/variation-planner";

const flavors = (n: number): PlannerFlavor[] =>
  Array.from({ length: n }, (_, i) => ({ id: `f${i}`, label: `Flavor${i}` }));

test("splitCount distributes evenly with remainder to the front", () => {
  assert.deepEqual(splitCount(30, 1), [30]);
  assert.deepEqual(splitCount(30, 2), [15, 15]);
  assert.deepEqual(splitCount(45, 2), [23, 22]);
  assert.deepEqual(splitCount(90, 3), [30, 30, 30]);
  assert.deepEqual(splitCount(100, 3), [34, 33, 33]);
});

test("own-brand: singles first (flavors × counts), then mixes", () => {
  const specs = planVariations(flavors(2), { targetCount: 100, ownBrand: true });
  // 2 flavors × 4 counts = 8 singles, then C(2,2)=1 combo × 4 counts = 4 mixes.
  assert.equal(specs.length, 12);
  const singles = specs.filter((s) => s.composition_type === "SINGLE_FLAVOR");
  const mixes = specs.filter((s) => s.composition_type === "MIXED_FLAVOR");
  assert.equal(singles.length, 8);
  assert.equal(mixes.length, 4);
  // singles come before mixes
  assert.ok(specs.findIndex((s) => s.composition_type === "MIXED_FLAVOR") >= 8);
});

test("quantities always sum to unit_count", () => {
  const specs = planVariations(flavors(4), { targetCount: 500, ownBrand: true });
  for (const s of specs) {
    assert.equal(s.quantities.reduce((a, b) => a + b, 0), s.unit_count);
    assert.equal(s.donor_ids.length, s.quantities.length);
  }
});

test("targetCount is a hard cap", () => {
  const specs = planVariations(flavors(8), { targetCount: 5, ownBrand: true });
  assert.equal(specs.length, 5);
});

test("counts default to 30/45/90/120 for own-brand", () => {
  const specs = planVariations(flavors(1), { targetCount: 100, ownBrand: true });
  // 1 flavor, no mixes possible → 4 singles at the 4 counts
  assert.equal(specs.length, 4);
  assert.deepEqual(
    specs.map((s) => s.unit_count).sort((a, b) => a - b),
    [30, 45, 90, 120],
  );
});

test("gift-set mode uses the pack size and small mixes", () => {
  const specs = planVariations(flavors(3), {
    targetCount: 100,
    ownBrand: false,
    defaultPack: 6,
  });
  // 3 singles @6, then 2-mix (3 combos) + 3-mix (1 combo) @6
  assert.ok(specs.every((s) => s.unit_count === 6));
  assert.equal(specs.filter((s) => s.composition_type === "SINGLE_FLAVOR").length, 3);
  assert.ok(specs.some((s) => s.composition_type === "MIXED_FLAVOR"));
});
