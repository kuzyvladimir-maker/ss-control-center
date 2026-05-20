// Pure-function tests for the image-pipeline prompt builder. The full
// orchestrator (DB + OpenAI + R2 + compliance gate) is covered by
// scripts/smoke-image-pipeline.ts in mock mode.
//
// Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/image-pipeline.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildImagePrompt } from "../image-pipeline";

const SAMPLE_VARIANT = {
  idx: 0,
  name: "Lunchables variety x 9",
  composition: [
    { qty: 3, product_name: "Lunchables Ham + Cheese", brand: "Lunchables" },
    { qty: 3, product_name: "Lunchables Turkey + Cheese", brand: "Lunchables" },
    { qty: 3, product_name: "Lunchables Pizza", brand: "Lunchables" },
  ],
  feasibility_score: 92,
} as unknown as Parameters<typeof buildImagePrompt>[0]["variant"];

test("buildImagePrompt — includes composition + brand", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
  });
  assert.match(out, /Salutem Vita/);
  assert.match(out, /3× Lunchables Ham \+ Cheese/);
  assert.match(out, /multi flavor/i);
});

test("buildImagePrompt — has the strict-negative block including 'no third-party brand logos'", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
  });
  assert.match(out, /STRICT NEGATIVES/);
  assert.match(out, /no third-party brand logos/i);
  assert.match(out, /no retailer marks/i);
  assert.match(out, /generic, unbranded packaging/i);
  assert.match(out, /no emojis/i);
});

test("buildImagePrompt — explicitly requests square / 1:1", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
  });
  assert.match(out, /Square 1:1/);
});

test("buildImagePrompt — no promotional language anywhere", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
  });
  for (const word of [
    "perfect",
    "ultimate",
    "premium",
    "amazing",
    "delicious",
    "delightful",
    "ideal",
    "incredible",
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
  });
  assert.match(out, /Salutem Vita/);
  assert.match(out, /STRICT NEGATIVES/);
});
