// Pure-function tests for the image-pipeline prompt builder. The full
// orchestrator (DB + image worker + R2 + compliance gate) is covered by
// scripts/smoke-image-pipeline.ts in mock mode.
//
// Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/image-pipeline.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildImagePrompt, composeRetailBoxes, isColdCategory } from "../image-pipeline";

// MIX sample (2 flavors) → always wraps + variety (owner 2026-07-08).
const SAMPLE_VARIANT = {
  idx: 0,
  name: "Uncrustables variety x 30",
  composition: [
    { qty: 15, product_name: "Smucker's Uncrustables PB & Grape Jelly", brand: "Smucker's" },
    { qty: 15, product_name: "Smucker's Uncrustables PB & Strawberry", brand: "Smucker's" },
  ],
  feasibility_score: 92,
} as unknown as Parameters<typeof buildImagePrompt>[0]["variant"];

// SINGLE composable sample (30 = 3×10 boxes).
const SINGLE_VARIANT = {
  idx: 0,
  name: "Uncrustables PB & Grape x 30",
  composition: [{ qty: 30, product_name: "Smuckers Uncrustables PB & Grape, 10 Count", brand: "Smucker's" }],
  feasibility_score: 92,
} as unknown as Parameters<typeof buildImagePrompt>[0]["variant"];

function cold() {
  return buildImagePrompt({
    brand: "Salutem Vita",
    variant: SINGLE_VARIANT,
    composition_type: "SINGLE_FLAVOR",
    category: "FROZEN_GROCERY",
  });
}

test("isColdCategory — frozen + refrigerated are cold, shelf-stable is not", () => {
  assert.ok(isColdCategory("FROZEN_GROCERY"));
  assert.ok(isColdCategory("REFRIGERATED"));
  assert.ok(!isColdCategory("SHELF_STABLE"));
});

test("composeRetailBoxes — exact decompositions only (owner rule 2026-07-07)", () => {
  assert.deepEqual(composeRetailBoxes(45, [15, 10, 4]), [15, 15, 15]);
  assert.deepEqual(composeRetailBoxes(30, [15, 10, 4]), [15, 15]);
  assert.deepEqual(composeRetailBoxes(24, [15, 10, 4]), [10, 10, 4]); // greedy 15 would strand 9
  assert.deepEqual(composeRetailBoxes(24, [8]), [8, 8, 8]); // protein line: 8ct boxes
  assert.equal(composeRetailBoxes(30, [8]), null); // 30 not divisible by 8 → wraps
  assert.equal(composeRetailBoxes(30, [4]), null); // 4ct-only flavor at 30 → wraps
  assert.equal(composeRetailBoxes(2, [15, 10, 4]), null);
  assert.deepEqual(composeRetailBoxes(90, [15, 10, 4]), [15, 15, 15, 15, 15, 15]);
});

test("buildImagePrompt (cold single) — frozen hero: real product + Salutem cooler + gel packs", () => {
  const out = cold();
  assert.match(out, /SALUTEM SOLUTIONS/);
  assert.match(out, /cooler/i);
  assert.match(out, /FROZEN GEL PACK/);
  assert.match(out, /ONLY to the cooler and the gel packs/i);
  assert.match(out, /NEVER onto the third-party product/i);
  assert.match(out, /NO loose ice/i);
});

test("buildImagePrompt (single) — composable count → box COUNT, NO printed numbers", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: SINGLE_VARIANT, // 30 = 3×10
    composition_type: "SINGLE_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  assert.match(out, /EXACTLY 3 real Uncrustables retail boxes/);
  assert.match(out, /never loose sandwiches mixed with boxes/i);
  assert.match(out, /NO printed quantity numbers or count badges/i); // the no-numbers rule
  assert.ok(!/individually-wrapped sandwiches/i.test(out));
});

test("buildImagePrompt (single) — NON-composable count auto-falls back to WRAPS", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: {
      ...SINGLE_VARIANT,
      composition: [{ qty: 30, product_name: "Smucker's Uncrustables Frozen PB Sandwich - 7.2oz/4ct", brand: "Smucker's" }],
    } as typeof SINGLE_VARIANT,
    composition_type: "SINGLE_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  assert.match(out, /individually-wrapped sandwiches|sealed round sandwich/i);
  assert.match(out, /NO retail cartons/i);
  assert.match(out, /30 sandwiches/);
});

test("buildImagePrompt (MIX) — always wraps, lists EVERY flavor, per-flavor refs, no numbers", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: SAMPLE_VARIANT, // PB&Grape + PB&Strawberry
    composition_type: "MIXED_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  // Both flavors named + a variety, never single-flavor boxes.
  assert.match(out, /PB & Grape Jelly/);
  assert.match(out, /PB & Strawberry/);
  assert.match(out, /variety|mix of all of them/i);
  assert.match(out, /Reference images #2\.\.#3 are the flavors/); // per-flavor references
  assert.match(out, /do NOT show only one flavor/i);
  assert.match(out, /NO printed quantity numbers/i);
  assert.ok(!/EXACTLY \d+ real Uncrustables retail boxes/i.test(out)); // mixes never box-mode
});

test("buildImagePrompt — wraps mode is IGNORED for a real gift set (non-own-brand)", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: {
      ...SAMPLE_VARIANT,
      composition: [{ qty: 3, product_name: "Ghirardelli Squares", brand: "Ghirardelli" }],
    } as unknown as Parameters<typeof buildImagePrompt>[0]["variant"],
    composition_type: "MULTI_FLAVOR",
    category: "FROZEN_GROCERY",
    uncrustables_image_mode: "individual_wraps",
  });
  // Non-own-brand → always the gift-set carton framing, never wrappers.
  assert.ok(!/individually-wrapped sandwiches/i.test(out));
  assert.match(out, /arranged as a gift set/i);
});

test("buildImagePrompt (shelf-stable) — clean product on white, no cooler", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
    category: "SHELF_STABLE",
  });
  assert.match(out, /pure white background/i);
  assert.match(out, /No cooler/i);
  assert.match(out, /reproduce the actual retail packaging/i);
});

test("buildImagePrompt — square / 1:1 on both paths", () => {
  assert.match(cold(), /1:1/);
});

test("buildImagePrompt — no promotional language anywhere", () => {
  const out = cold();
  for (const word of [
    "perfect", "ultimate", "premium", "amazing",
    "delicious", "delightful", "ideal", "incredible",
  ]) {
    assert.ok(
      !new RegExp(`\\b${word}\\b`, "i").test(out),
      `prompt contains promo word "${word}"`,
    );
  }
});

test("buildImagePrompt — handles empty composition gracefully (no crash)", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: { ...SAMPLE_VARIANT, composition: [] },
    composition_type: "SINGLE_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  assert.match(out, /SALUTEM SOLUTIONS/);
});
