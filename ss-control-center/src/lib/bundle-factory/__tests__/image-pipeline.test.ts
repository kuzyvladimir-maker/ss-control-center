// Pure-function tests for the image-pipeline prompt builder. The full
// orchestrator (DB + image worker + R2 + compliance gate) is covered by
// scripts/smoke-image-pipeline.ts in mock mode.
//
// Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/image-pipeline.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildImagePrompt, isColdCategory } from "../image-pipeline";

const SAMPLE_VARIANT = {
  idx: 0,
  name: "Uncrustables variety x 6",
  composition: [
    { qty: 4, product_name: "Smucker's Uncrustables PB & Grape Jelly", brand: "Smucker's" },
    { qty: 2, product_name: "Smucker's Uncrustables PB & Strawberry", brand: "Smucker's" },
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

test("buildImagePrompt (cold) — frozen hero: real product + Salutem cooler + gel packs", () => {
  const out = cold();
  assert.match(out, /4× Smucker's Uncrustables PB & Grape Jelly/);
  assert.match(out, /SALUTEM SOLUTIONS/);
  assert.match(out, /cooler/i);
  assert.match(out, /FROZEN GEL PACK/);
  // Salutem branding goes ONLY on cooler/gel packs, never the third-party product.
  assert.match(out, /ONLY to the cooler and the gel packs/i);
  assert.match(out, /NEVER onto the third-party product/i);
  // Real packaging, NOT the old "generic unbranded" approach.
  assert.match(out, /reproduce its actual retail packaging/i);
  assert.ok(!/generic, unbranded/i.test(out), "must not ask for generic unbranded packaging");
  // No loose ice.
  assert.match(out, /NO loose ice/i);
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
