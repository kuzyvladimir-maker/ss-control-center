// Pure-function tests for the image-pipeline prompt builder. The full
// orchestrator (DB + image worker + R2 + compliance gate) is covered by
// scripts/smoke-image-pipeline.ts in mock mode.
//
// Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/image-pipeline.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildImagePrompt, composeRetailBoxes, isColdCategory } from "../image-pipeline";

// Composable sample: 15 + 15 → one 15-box per flavor (owner's exact-box rule).
const SAMPLE_VARIANT = {
  idx: 0,
  name: "Uncrustables variety x 30",
  composition: [
    { qty: 15, product_name: "Smucker's Uncrustables PB & Grape Jelly", brand: "Smucker's" },
    { qty: 15, product_name: "Smucker's Uncrustables PB & Strawberry", brand: "Smucker's" },
  ],
  feasibility_score: 92,
} as unknown as Parameters<typeof buildImagePrompt>[0]["variant"];

function cold() {
  return buildImagePrompt({
    brand: "Salutem Vita",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
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

test("buildImagePrompt (cold) — frozen hero: real product + Salutem cooler + gel packs", () => {
  const out = cold();
  assert.match(out, /15× Smucker's Uncrustables PB & Grape Jelly/);
  assert.match(out, /SALUTEM SOLUTIONS/);
  assert.match(out, /cooler/i);
  assert.match(out, /FROZEN GEL PACK/);
  // Salutem branding goes ONLY on cooler/gel packs, never the third-party product.
  assert.match(out, /ONLY to the cooler and the gel packs/i);
  assert.match(out, /NEVER onto the third-party product/i);
  // Real packaging reproduced exactly, NOT the old "generic unbranded" approach.
  assert.match(out, /reproduce that packaging exactly/i);
  assert.ok(!/generic, unbranded/i.test(out), "must not ask for generic unbranded packaging");
  // No loose ice.
  assert.match(out, /NO loose ice/i);
});

test("buildImagePrompt (own-brand) — composable count → EXACT box plan", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: {
      ...SAMPLE_VARIANT,
      composition: [{ qty: 30, product_name: "Smuckers Uncrustables PB & Grape, 10 Count", brand: "Smucker's" }],
    } as typeof SAMPLE_VARIANT,
    composition_type: "SINGLE_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  assert.match(out, /EXACTLY 3 boxes of 10/);
  assert.match(out, /never loose sandwiches mixed with boxes/i);
  assert.ok(!/individually-wrapped sandwiches/i.test(out));
});

test("buildImagePrompt (own-brand) — NON-composable count auto-falls back to WRAPS", () => {
  // 4ct-only flavor at 30 pieces: 30 % 4 ≠ 0 → no boxes allowed at all.
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: {
      ...SAMPLE_VARIANT,
      composition: [{ qty: 30, product_name: "Smucker's Uncrustables Frozen PB Sandwich - 7.2oz/4ct", brand: "Smucker's" }],
    } as typeof SAMPLE_VARIANT,
    composition_type: "SINGLE_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  assert.match(out, /individually-wrapped sandwiches/i);
  assert.match(out, /NO retail cartons/i);
  assert.match(out, /30 sandwiches/);
});

test("buildImagePrompt (own-brand) — manual individual_wraps mode always wraps", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
    category: "FROZEN_GROCERY",
    uncrustables_image_mode: "individual_wraps",
  });
  assert.match(out, /individually-wrapped sandwiches/i);
  assert.match(out, /WRAPPER COLOUR signals the flavor/i);
  assert.ok(!/EXACTLY .* box/i.test(out));
  assert.match(out, /match its BRAND identity exactly/i);
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
