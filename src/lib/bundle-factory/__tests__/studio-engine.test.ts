import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePrompt,
  recipeFingerprint,
} from "@/lib/bundle-factory/studio-engine";

test("recipe fingerprint is order-independent but quantity-sensitive", () => {
  const a = recipeFingerprint("Uncrustables", {
    composition_type: "MIXED_FLAVOR",
    unit_count: 45,
    flavor_labels: ["Strawberry", "Grape"],
    quantities: [23, 22],
  });
  const reordered = recipeFingerprint("uncrustables", {
    composition_type: "MIXED_FLAVOR",
    unit_count: 45,
    flavor_labels: ["Grape", "Strawberry"],
    quantities: [22, 23],
  });
  const different = recipeFingerprint("Uncrustables", {
    composition_type: "MIXED_FLAVOR",
    unit_count: 45,
    flavor_labels: ["Strawberry", "Grape"],
    quantities: [22, 23],
  });
  assert.equal(a, reordered);
  assert.notEqual(a, different);
});

test("parsePrompt keeps explicit listing count separate from pack count", () => {
  assert.deepEqual(parsePrompt("150 Uncrustables listings, pack of 30"), {
    count: 150,
    theme: "Uncrustables",
    pack_count: 30,
  });
  assert.deepEqual(parsePrompt("pack of 45, create 164 Uncrustables listings"), {
    count: 164,
    theme: "Uncrustables",
    pack_count: 45,
  });
  assert.deepEqual(parsePrompt("создай 164 листингов Uncrustables, pack of 30"), {
    count: 164,
    theme: "Uncrustables",
    pack_count: 30,
  });
});
