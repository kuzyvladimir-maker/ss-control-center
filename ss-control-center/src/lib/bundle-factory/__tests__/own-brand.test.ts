// Own-brand passthrough + canonical brand casing.
//   npx tsx --test src/lib/bundle-factory/__tests__/own-brand.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { isOwnBrandPassthrough, resolveListingBrand } from "@/lib/bundle-factory/own-brand";

test("isOwnBrandPassthrough — allowlist matches loosely, others don't", () => {
  assert.ok(isOwnBrandPassthrough("Smucker's"));
  assert.ok(isOwnBrandPassthrough("Uncrustables"));
  assert.ok(isOwnBrandPassthrough("Smucker's Uncrustables"));
  assert.ok(!isOwnBrandPassthrough("Ghirardelli"));
  assert.ok(!isOwnBrandPassthrough(null));
});

test("resolveListingBrand — CANONICAL spelling, never raw donor casing (prod leak: Smucker'S)", () => {
  assert.equal(resolveListingBrand("Smucker'S", "Salutem Vita"), "Uncrustables");
  assert.equal(resolveListingBrand("SMUCKERS", "Salutem Vita"), "Uncrustables");
  assert.equal(resolveListingBrand("Uncrustables", "Salutem Vita"), "Uncrustables");
  assert.equal(resolveListingBrand("smucker's uncrustables", "Salutem Vita"), "Uncrustables");
});

test("resolveListingBrand — non-allowlisted donor falls back to the house brand", () => {
  assert.equal(resolveListingBrand("Ghirardelli", "Salutem Vita"), "Salutem Vita");
  assert.equal(resolveListingBrand(null, "Salutem Vita"), "Salutem Vita");
  assert.equal(resolveListingBrand("  ", "Starfit"), "Starfit");
});
