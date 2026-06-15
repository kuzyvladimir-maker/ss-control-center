// Pure-function unit tests for parsePackSize — the regex pack-multiplier
// extractor that feeds the Procurement "Купить: N шт" calculation.
//
// Run with:
//   npx tsx --test src/lib/procurement/__tests__/pack-size.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePackSize } from "@/lib/procurement/pack-size";

test("plain 'Pack of N' → N, confident", () => {
  const p = parsePackSize("Del Monte Peaches Sliced 8.5 oz (Pack of 6)");
  assert.equal(p?.size, 6);
  assert.equal(p?.ambiguous ?? false, false);
});

test("'N ct (Pack of M)' uses the pack count, NOT ct × pack", () => {
  // The bug report: "10 ct" is bagels inside ONE bag (contents), "Pack of 6"
  // is six bags. You buy 6 bags per listing, so size must be 6 — never 60.
  const p = parsePackSize("Thomas' Plain Mini Bagels, 10 ct (Pack of 6)");
  assert.equal(p?.size, 6);
  assert.equal(p?.label, "Pack of 6");
  // Must be confident so the UI does NOT escalate to the AI endpoint
  // (which historically multiplied 10 × 6 = 60).
  assert.equal(p?.ambiguous ?? false, false);
});

test("'N count (Pack of M)' behaves the same as ct", () => {
  const p = parsePackSize("Snack Bars 12 Count (Pack of 4)");
  assert.equal(p?.size, 4);
  assert.equal(p?.ambiguous ?? false, false);
});

test("no pack pattern → null", () => {
  assert.equal(parsePackSize("Salutem Vita Pork Loin Roast 4.2 lb"), null);
});

test("genuine second package count still flags ambiguous", () => {
  // Two distinct package-level counts (not a 'ct' contents token) → ambiguous,
  // so the UI asks the AI endpoint to multiply the compound expression.
  const p = parsePackSize("Maruchan Cup - 12 Pack | Bundle of 2");
  assert.equal(p?.ambiguous, true);
});
