import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProductTruthRecipeInputError,
  buildProductTruthRecipeComponentFromRows,
} from "@/lib/bundle-factory/product-truth-recipe-input";
import {
  newSkuCompilerOptions as options,
  validIdentityRow as identity,
  validPriceRow as price,
} from "@/lib/sourcing/__tests__/product-truth-new-sku-fixtures";

test("compiles exact content and separate exact price evidence", () => {
  const component = buildProductTruthRecipeComponentFromRows({
    identity,
    price,
    qty: 2,
    index: 0,
    options,
  });
  assert.equal(component.content_role, "EXACT");
  assert.equal(component.content_observation_id, "content-a");
  assert.equal(component.price_evidence.observation_id, "price-a");
  assert.equal(component.price_evidence.match_tier, "EXACT_IDENTITY");
  assert.equal(component.qty, 2);
  assert.deepEqual(component.facts.attributes._exact_image_urls, [
    "https://images.example/main.jpg",
    "https://images.example/nutrition.jpg",
  ]);
});

test("fails closed when exact ingestible facts are incomplete", () => {
  assert.throws(
    () => buildProductTruthRecipeComponentFromRows({
      identity: {
        ...identity,
        contentJson: JSON.stringify({
          title: "Example Strawberry Snack 1 oz",
          ingredients: "Corn and sugar.",
          nutritionFacts: { calories: 100 },
          mainImageUrl: "https://images.example/main.jpg",
        }),
      },
      price,
      qty: 2,
      index: 0,
      options,
    }),
    (error: unknown) =>
      error instanceof ProductTruthRecipeInputError &&
      error.blockers.includes("donor-a:ALLERGENS_MISSING"),
  );
});

test("rejects unscoped price evidence instead of treating unknown as local", () => {
  assert.throws(
    () => buildProductTruthRecipeComponentFromRows({
      identity,
      price: { ...price, localityEvidence: "national_unscoped" },
      qty: 2,
      index: 0,
      options,
    }),
    (error: unknown) =>
      error instanceof ProductTruthRecipeInputError &&
      error.blockers.includes("donor-a:LOCALITY_EVIDENCE_INVALID"),
  );
});

test("rejects inconsistent price-per-unit arithmetic", () => {
  assert.throws(
    () => buildProductTruthRecipeComponentFromRows({
      identity,
      price: { ...price, pricePerUnit: 0.5 },
      qty: 2,
      index: 0,
      options,
    }),
    /PRICE_PER_UNIT_ARITHMETIC_MISMATCH/,
  );
});

test("rejects store-scoped evidence without an exact ZIP binding", () => {
  assert.throws(
    () => buildProductTruthRecipeComponentFromRows({
      identity,
      price: { ...price, localityEvidence: "store_scoped", zip: null },
      qty: 2,
      index: 0,
      options,
    }),
    /LOCALITY_EVIDENCE_INVALID/,
  );
});
