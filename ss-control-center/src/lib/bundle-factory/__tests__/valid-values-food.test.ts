// Tests for the FOOD valid-value enums + temperature_rating wiring.
//   npx tsx --test src/lib/bundle-factory/__tests__/valid-values-food.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  temperatureRatingForCategory,
  TEMPERATURE_RATING,
} from "@/lib/bundle-factory/attributes/valid-values-food";
import { buildRichAmazonAttributes } from "@/lib/bundle-factory/attributes/build-amazon-attributes";

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
});
