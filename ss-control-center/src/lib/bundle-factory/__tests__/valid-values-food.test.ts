// Tests for the FOOD valid-value enums + temperature_rating wiring.
//   npx tsx --test src/lib/bundle-factory/__tests__/valid-values-food.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  temperatureRatingForCategory,
  TEMPERATURE_RATING,
} from "@/lib/bundle-factory/attributes/valid-values-food";
import {
  buildRichAmazonAttributes,
} from "@/lib/bundle-factory/attributes/build-amazon-attributes";
import {
  amazonAllergenFamily,
  amazonAllergensFromStoredDeclarations,
  amazonContainedAllergenToken,
  amazonMayContainAllergenToken,
  serializeAllergenDeclaration,
} from "@/lib/bundle-factory/allergen-declaration";

test("temperatureRatingForCategory — frozen → 'Frozen: 0 degree'", () => {
  assert.equal(temperatureRatingForCategory("FROZEN_SINGLE"), TEMPERATURE_RATING.FROZEN);
  assert.equal(temperatureRatingForCategory("FROZEN_GROCERY"), "Frozen: 0 degree");
});

test("temperatureRatingForCategory — refrigerated → 'Chilled: 33 to 38 degrees'", () => {
  assert.equal(temperatureRatingForCategory("REFRIGERATED"), TEMPERATURE_RATING.CHILLED);
});

test("temperatureRatingForCategory — dry/unknown → 'Ambient: Room Temperature'", () => {
  assert.equal(temperatureRatingForCategory("DRY_SNACKS"), TEMPERATURE_RATING.AMBIENT);
  assert.equal(temperatureRatingForCategory(null), TEMPERATURE_RATING.AMBIENT);
});

test("buildRichAmazonAttributes sets temperature_rating from category (exact enum)", () => {
  const a = buildRichAmazonAttributes({
    ingredients: "Enriched wheat flour, chocolate hazelnut spread.",
    packCount: 6,
    category: "FROZEN_GROCERY",
  }) as Record<string, Array<{ value: unknown }>>;
  assert.ok(Array.isArray(a.temperature_rating));
  assert.equal(a.temperature_rating[0].value, "Frozen: 0 degree");
  // sanity: existing fields still populated
  assert.ok(Array.isArray(a.ingredients));
  assert.equal(a.number_of_items[0].value, 6);
  assert.equal(a.allergen_information, undefined);
  // extra recommended food attributes now filled (exact FOOD valid values)
  assert.equal(a.condition_type[0].value, "new_new");
  assert.equal(a.is_expiration_dated_product, undefined);
  assert.equal(a.product_expiration_type, undefined);
  assert.equal(a.is_heat_sensitive[0].value, true); // frozen → heat sensitive
  assert.equal(a.contains_liquid_contents[0].value, false); // solid by default
});

test("food boolean attributes use schema booleans", () => {
  const dry = buildRichAmazonAttributes({ category: "DRY_SNACKS" }) as Record<
    string,
    Array<{ value: unknown }>
  >;
  assert.equal(dry.is_heat_sensitive[0].value, false);
  const drink = buildRichAmazonAttributes({
    category: "DRY_SNACKS",
    containsLiquid: true,
  }) as Record<string, Array<{ value: unknown }>>;
  assert.equal(drink.contains_liquid_contents[0].value, true);
});

test("ingredient keywords never become authoritative marketplace allergens", () => {
  const attrs = buildRichAmazonAttributes({
    ingredients: "Shrimp, wheat flour, peanuts, soy lecithin, sesame oil.",
  });
  assert.equal(attrs.allergen_information, undefined);
});

test("explicit reviewed allergens are preserved without adding ingredient matches", () => {
  const attrs = buildRichAmazonAttributes({
    ingredients: "Wheat flour, peanuts, soybean oil.",
    allergens: ["peanuts", "wheat"],
  }) as Record<string, Array<{ value: unknown }>>;
  assert.deepEqual(
    attrs.allergen_information.map((row) => row.value),
    ["peanuts", "wheat"],
  );
});

test("expiration attributes require explicit reviewed evidence", () => {
  const absent = buildRichAmazonAttributes({ category: "FROZEN_GROCERY" });
  assert.equal(absent.is_expiration_dated_product, undefined);
  assert.equal(absent.product_expiration_type, undefined);

  const reviewed = buildRichAmazonAttributes({
    category: "FROZEN_GROCERY",
    verifiedExpiration: {
      source: "MANUFACTURER_LABEL",
      is_expiration_dated_product: true,
      product_expiration_type: "Expiration Date Required",
    },
  }) as Record<string, Array<{ value: unknown }>>;
  assert.equal(reviewed.is_expiration_dated_product[0].value, true);
  assert.equal(
    reviewed.product_expiration_type[0].value,
    "Expiration Date Required",
  );

  assert.throws(
    () => buildRichAmazonAttributes({
      verifiedExpiration: {
        source: "OPERATOR_REVIEW",
        is_expiration_dated_product: false,
        product_expiration_type: "Expiration Date Required",
      },
    }),
    /non-expiring product cannot use an expiration-required/i,
  );
  assert.throws(
    () => buildRichAmazonAttributes({
      verifiedExpiration: {
        source: "CATEGORY_DEFAULT",
        is_expiration_dated_product: true,
      } as never,
    }),
    /unsupported expiration evidence source/i,
  );
});

test("manufacturer ingredients are exact and fail closed above PTD byte limit", () => {
  const exact = "Wheat flour, peanuts; keep punctuation exactly.";
  const attrs = buildRichAmazonAttributes({ ingredients: exact }) as Record<
    string,
    Array<{ value: unknown }>
  >;
  assert.equal(attrs.ingredients[0].value, exact);
  assert.throws(
    () => buildRichAmazonAttributes({ ingredients: "é".repeat(3001) }),
    /6002 UTF-8 bytes.*allows 6000/,
  );
});

test("hazelnut uses exact contains token and broader precautionary token", () => {
  assert.equal(amazonContainedAllergenToken("Hazelnut"), "hazelnut");
  assert.equal(
    amazonMayContainAllergenToken("Hazelnut"),
    "tree_nuts_may_contain",
  );
  assert.equal(amazonAllergenFamily("Hazelnut"), "tree_nuts");
  const attrs = buildRichAmazonAttributes({
    ingredients: "Hazelnuts, wheat flour.",
    allergens: ["hazelnut", "wheat"],
  }) as Record<string, Array<{ value: unknown }>>;
  assert.deepEqual(
    attrs.allergen_information.map((row) => row.value),
    ["hazelnut", "wheat"],
  );
});

test("persisted contains/may-contain schema feeds future live reconciliation", () => {
  const stored = serializeAllergenDeclaration({
    contains: ["Peanut", "Wheat"],
    may_contain: ["Hazelnut", "Milk"],
  });
  assert.deepEqual(amazonAllergensFromStoredDeclarations([stored]), [
    "peanuts",
    "wheat",
  ]);
  assert.ok(stored.includes('"may_contain":["Hazelnut","Milk"]'));
});

test("legacy flat allergen arrays are not accepted as reviewed declarations", () => {
  assert.throws(
    () => amazonAllergensFromStoredDeclarations([
      JSON.stringify(["peanuts", "wheat", "soy"]),
    ]),
    /no structured allergen declaration/i,
  );
});
