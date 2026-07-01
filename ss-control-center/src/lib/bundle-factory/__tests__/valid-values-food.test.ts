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
  extractAllergens,
} from "@/lib/bundle-factory/attributes/build-amazon-attributes";

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
  assert.ok(Array.isArray(a.allergen_information)); // wheat → Wheat
  // extra recommended food attributes now filled (exact FOOD valid values)
  assert.equal(a.condition_type[0].value, "new_new");
  assert.equal(a.product_expiration_type[0].value, "Expiration Date Required");
  assert.equal(a.is_heat_sensitive[0].value, "Yes"); // frozen → heat sensitive
  assert.equal(a.contains_liquid_contents[0].value, "No"); // solid by default
});

test("is_heat_sensitive is 'No' for dry, 'Yes' when containsLiquid drink", () => {
  const dry = buildRichAmazonAttributes({ category: "DRY_SNACKS" }) as Record<
    string,
    Array<{ value: unknown }>
  >;
  assert.equal(dry.is_heat_sensitive[0].value, "No");
  const drink = buildRichAmazonAttributes({
    category: "DRY_SNACKS",
    containsLiquid: true,
  }) as Record<string, Array<{ value: unknown }>>;
  assert.equal(drink.contains_liquid_contents[0].value, "Yes");
});

test("allergen canonicals match Amazon FOOD valid values (not FDA labels)", () => {
  // shrimp → 'Crustacean' (not 'Shellfish')
  assert.deepEqual(extractAllergens("Shrimp, salt."), ["Crustacean"]);
  // soy → 'Soy' (not 'Soybeans'); sesame → 'Sesame Seeds' (not 'Sesame')
  assert.deepEqual(extractAllergens("Soy lecithin, sesame oil."), [
    "Soy",
    "Sesame Seeds",
  ]);
});
