// Tests for the cold-chain brand-story card gallery injection.
//   npx tsx --test src/lib/bundle-factory/__tests__/brand-card.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isColdChainTemperature,
  appendColdChainBrandCard,
} from "@/lib/bundle-factory/attributes/brand-assets";

const M = "ATVPDKIKX0DER";
const URL = "https://img.example/prod/brand/salutem-brand-card-v1.png";

const frozen = () => ({
  temperature_rating: [{ value: "Frozen: 0 degree", marketplace_id: M }],
});
const ambient = () => ({
  temperature_rating: [{ value: "Ambient: Room Temperature", marketplace_id: M }],
});

test("isColdChainTemperature — frozen/chilled true, ambient/null false", () => {
  assert.equal(isColdChainTemperature("Frozen: 0 degree"), true);
  assert.equal(isColdChainTemperature("Chilled: 33 to 38 degrees"), true);
  assert.equal(isColdChainTemperature("Ambient: Room Temperature"), false);
  assert.equal(isColdChainTemperature(null), false);
});

test("appendColdChainBrandCard adds locator_1 for frozen when url set", () => {
  const a: Record<string, unknown> = frozen();
  appendColdChainBrandCard(a, M, URL);
  const loc = a.other_product_image_locator_1 as Array<{ media_location: string }>;
  assert.ok(Array.isArray(loc));
  assert.equal(loc[0].media_location, URL);
});

test("appendColdChainBrandCard is a no-op for ambient (dry) listings", () => {
  const a: Record<string, unknown> = ambient();
  appendColdChainBrandCard(a, M, URL);
  assert.equal(a.other_product_image_locator_1, undefined);
});

test("appendColdChainBrandCard is a no-op when url is empty", () => {
  const a: Record<string, unknown> = frozen();
  appendColdChainBrandCard(a, M, ""); // asset not produced yet
  assert.equal(a.other_product_image_locator_1, undefined);
});

test("appendColdChainBrandCard lands AFTER existing secondary photos", () => {
  const a: Record<string, unknown> = {
    ...frozen(),
    other_product_image_locator_1: [{ media_location: "https://img/donor-1.png" }],
    other_product_image_locator_2: [{ media_location: "https://img/donor-2.png" }],
  };
  appendColdChainBrandCard(a, M, URL);
  const loc = a.other_product_image_locator_3 as Array<{ media_location: string }>;
  assert.ok(Array.isArray(loc));
  assert.equal(loc[0].media_location, URL); // brand card is last
});
