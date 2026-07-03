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
  // Real packaging reproduced exactly, NOT the old "generic unbranded" approach.
  assert.match(out, /reproduce that packaging exactly/i);
  assert.ok(!/generic, unbranded/i.test(out), "must not ask for generic unbranded packaging");
  // No loose ice.
  assert.match(out, /NO loose ice/i);
});

test("buildImagePrompt (own-brand) — default is count-accurate RETAIL BOXES", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  assert.match(out, /real retail product boxes/i);
  assert.match(out, /boxes of 4, 10 or 15/i);
  assert.ok(!/individually-wrapped sandwiches/i.test(out));
});

test("buildImagePrompt (own-brand) — individual_wraps mode shows flavor-coloured wrappers", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
    category: "FROZEN_GROCERY",
    uncrustables_image_mode: "individual_wraps",
  });
  assert.match(out, /individually-wrapped sandwiches/i);
  assert.match(out, /WRAPPER COLOUR signals the flavor/i);
  // Not the retail-carton language in this mode.
  assert.ok(!/real retail product boxes/i.test(out));
  // Still branded correctly (match the donor brand, render as wrappers).
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
