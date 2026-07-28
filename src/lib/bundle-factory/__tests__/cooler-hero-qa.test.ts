import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCoolerHeroQaObservation,
  type CoolerHeroQaInput,
} from "../audit/cooler-hero-qa";

const input: CoolerHeroQaInput = {
  image_buffer: Buffer.from("fixture"),
  expected_flavors: ["Peanut Butter", "Blackberry Boom"],
  expected_visible_boxes: 6,
  expected_flavor_box_counts: {
    "Peanut Butter": 3,
    "Blackberry Boom": 3,
  },
};

function passingObservation(): Record<string, unknown> {
  return {
    is_real_uncrustables_retail_boxes: true,
    background_is_pure_white: true,
    salutem_cooler_visible_and_branded: true,
    frozen_gel_packs_visible_and_branded: true,
    salutem_branding_only_on_kit: true,
    all_expected_flavors_visible: true,
    only_expected_flavors_visible: true,
    fabricated_or_garbled_product_text: false,
    retailer_ui_overlay_or_watermark: false,
    genuine_retailer_exclusive_mark_on_carton: false,
    unrelated_product_or_lifestyle_panel: false,
    loose_ice_or_loose_sandwich: false,
    products_physically_seated_inside_cooler: true,
    floating_pasted_or_impossibly_intersecting_product: false,
    inside_gel_pack_count: 2,
    outside_gel_pack_count: 2,
    visible_box_count: 6,
    boxes_by_expected_flavor: {
      "Peanut Butter": 3,
      "Blackberry Boom": 3,
    },
  };
}

test("exact compliant cooler observation passes", () => {
  assert.deepEqual(evaluateCoolerHeroQaObservation(passingObservation(), input), {
    hard_fails: [],
    warnings: [],
  });
});

test("total visible carton mismatch is a hard failure", () => {
  const observation = passingObservation();
  observation.visible_box_count = 5;
  const result = evaluateCoolerHeroQaObservation(observation, input);
  assert.ok(result.hard_fails.some((reason) => reason.includes("exact recipe presentation requires 6")));
});

test("per-flavor carton mismatch is a hard failure even when total matches", () => {
  const observation = passingObservation();
  observation.boxes_by_expected_flavor = {
    "Peanut Butter": 4,
    "Blackberry Boom": 2,
  };
  const result = evaluateCoolerHeroQaObservation(observation, input);
  assert.ok(result.hard_fails.some((reason) => reason.startsWith("Peanut Butter visible box count")));
  assert.ok(result.hard_fails.some((reason) => reason.startsWith("Blackberry Boom visible box count")));
});

test("gel-pack layout, loose ice, and floating products fail closed", () => {
  const observation = passingObservation();
  observation.inside_gel_pack_count = 3;
  observation.outside_gel_pack_count = 1;
  observation.loose_ice_or_loose_sandwich = true;
  observation.products_physically_seated_inside_cooler = false;
  observation.floating_pasted_or_impossibly_intersecting_product = true;
  const result = evaluateCoolerHeroQaObservation(observation, input);
  assert.ok(result.hard_fails.some((reason) => reason.includes("inside gel-pack count")));
  assert.ok(result.hard_fails.some((reason) => reason.includes("outside gel-pack count")));
  assert.ok(result.hard_fails.includes("loose ice or loose sandwich visible"));
  assert.ok(result.hard_fails.includes("products are not physically seated behind the cooler rim"));
  assert.ok(result.hard_fails.includes("floating, pasted, unsupported, or intersecting product visible"));
});

test("genuine printed retailer mark is a warning, not a defect", () => {
  const observation = passingObservation();
  observation.genuine_retailer_exclusive_mark_on_carton = true;
  const result = evaluateCoolerHeroQaObservation(observation, input);
  assert.equal(result.hard_fails.length, 0);
  assert.deepEqual(result.warnings, [
    "genuine retailer-exclusive mark is printed on a source carton",
  ]);
});
