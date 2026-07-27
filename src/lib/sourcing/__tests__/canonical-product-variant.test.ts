import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANONICAL_PRODUCT_VARIANT_KEY_VERSION,
  CanonicalProductVariantKeyError,
  buildCanonicalProductVariantKey,
} from "../canonical-product-variant";

test("variant key is deterministic from explicit normalized identity", () => {
  const first = buildCanonicalProductVariantKey({
    brand: "Smucker's",
    productLine: "Uncrustables Sandwiches",
    flavor: "Peanut Butter & Strawberry Jam",
    form: "Frozen Sandwich",
    size: "8 oz",
  });
  const reordered = buildCanonicalProductVariantKey({
    brand: "SMUCKERS",
    productLine: "Sandwiches Uncrustables",
    flavor: "Strawberry Jam and Peanut Butter",
    form: "sandwich frozen",
    size: "8 ounces",
    title: "retailer copy is deliberately excluded",
  });

  assert.equal(first.variantKey, reordered.variantKey);
  assert.equal(
    first.variantKey,
    "cpv1:13ddfa3d79ee8142661f59fd4e188baf652d34d1d306af982047c0aee58bfd17",
  );
  assert.equal(first.canonicalVariantId, first.variantKey);
  assert.equal(first.identityHash, first.variantKey.slice("cpv1:".length));
  assert.equal(first.keyVersion, CANONICAL_PRODUCT_VARIANT_KEY_VERSION);
  assert.deepEqual(first.db, {
    id: first.variantKey,
    variantKey: first.variantKey,
    identityHash: first.identityHash,
    keyVersion: CANONICAL_PRODUCT_VARIANT_KEY_VERSION,
    normalizedBrand: "smuckers",
    normalizedProductLine: "sandwiches uncrustables",
    normalizedFlavor: "and butter jam peanut strawberry",
    normalizedModifiersJson: "[]",
    normalizedForm: "frozen sandwich",
    sizeDimension: "MASS",
    sizeBaseAmount: 226.796185,
    sizeBaseUnit: "g",
    outerPackCount: 1,
    identityJson: first.identityJson,
  });
});

test("equivalent explicit units share a key while real variants do not", () => {
  const base = {
    brand: "Acme",
    productLine: "Bread Flour",
    flavor: "Unbleached",
    form: "Flour",
  } as const;
  const pound = buildCanonicalProductVariantKey({ ...base, size: "1 lb" });
  const ounces = buildCanonicalProductVariantKey({ ...base, size: "16 oz" });
  const twoPack = buildCanonicalProductVariantKey({
    ...base,
    size: "1 lb",
    outerPackCount: 2,
  });
  const wholeWheat = buildCanonicalProductVariantKey({
    ...base,
    flavor: "Whole Wheat",
    size: "1 lb",
  });

  assert.equal(pound.variantKey, ounces.variantKey);
  assert.notEqual(pound.variantKey, twoPack.variantKey);
  assert.notEqual(pound.variantKey, wholeWheat.variantKey);
});

test("unproven canonical identities fail closed", () => {
  assert.throws(
    () => buildCanonicalProductVariantKey({ productLine: "Chips", size: "8 oz" }),
    (error) =>
      error instanceof CanonicalProductVariantKeyError
      && error.code === "VARIANT_BRAND_REQUIRED",
  );
  assert.throws(
    () => buildCanonicalProductVariantKey({ brand: "Acme", size: "8 oz" }),
    (error) =>
      error instanceof CanonicalProductVariantKeyError
      && error.code === "VARIANT_DISCRIMINATOR_REQUIRED",
  );
  assert.throws(
    () => buildCanonicalProductVariantKey({ brand: "Acme", productLine: "Chips" }),
    (error) =>
      error instanceof CanonicalProductVariantKeyError
      && error.code === "VARIANT_SIZE_REQUIRED",
  );
  assert.throws(
    () => buildCanonicalProductVariantKey({
      brand: "Acme",
      productLine: "Chips",
      size: "8 oz",
      outerPackCount: 0,
    }),
    (error) =>
      error instanceof CanonicalProductVariantKeyError
      && error.code === "VARIANT_OUTER_PACK_INVALID",
  );
});
