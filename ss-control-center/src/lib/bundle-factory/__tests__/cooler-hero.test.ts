import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allocateVisibleBoxes,
  buildCoolerHeroWithQA,
  packageQaFlavorLabel,
} from "../cooler-hero";
import { sameFlavor } from "../composite-image";

test("allocateVisibleBoxes shows every flavor and stays within capacity", () => {
  const out = allocateVisibleBoxes([9, 3, 1], 6);
  assert.equal(out.reduce((sum, n) => sum + n, 0), 6);
  assert.ok(out.every((n) => n >= 1));
  assert.ok(out[0] > out[1]);
});

test("allocateVisibleBoxes does not invent cartons for a small recipe", () => {
  assert.deepEqual(allocateVisibleBoxes([1, 1], 6), [1, 1]);
  assert.deepEqual(allocateVisibleBoxes([3], 6), [3]);
});

test("allocateVisibleBoxes blocks a recipe with more flavors than visible capacity", () => {
  assert.throws(() => allocateVisibleBoxes([1, 1, 1], 2), /exceed/);
});

test("deterministic empty-cooler builder fails closed without experimental opt-in", async () => {
  const result = await buildCoolerHeroWithQA({
    variant: {
      idx: 0,
      name: "blocked experiment",
      composition: [],
      feasibility_score: 0,
    } as unknown as Parameters<typeof buildCoolerHeroWithQA>[0]["variant"],
    r2_slug: "must-not-generate",
    stamp: "test",
  });
  assert.equal(result.ok, false);
  assert.equal(result.image_url, null);
  assert.equal(result.attempts, 0);
  assert.match(result.error ?? "", /experimental.*blocked.*explicit opt-in/i);
});

test("packageQaFlavorLabel accepts official Morning Protein carton names", () => {
  assert.match(packageQaFlavorLabel("Morning Protein Peanut Butter & Mixed Berry Spread"), /Beamin' Berry Blend/);
  assert.match(packageQaFlavorLabel("Frozen Peanut Butter & Strawberry Jam Sandwich – 12g Protein"), /Bright-Eyed Berry/);
  assert.match(packageQaFlavorLabel("Frozen Peanut Butter & Apple Cinnamon Jelly Sandwich – 12g Protein"), /Up & Apple/);
});

test("packageQaFlavorLabel accepts exact current carton aliases", () => {
  assert.match(
    packageQaFlavorLabel("Frozen Whole Wheat Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct"),
    /Reduced Sugar Peanut Butter & Strawberry Spread/,
  );
  assert.match(
    packageQaFlavorLabel("Frozen Whole Wheat Peanut Butter & Grape Jelly Sandwich - 8oz/4ct"),
    /Reduced Sugar Peanut Butter & Grape Spread/,
  );
  assert.match(packageQaFlavorLabel("Frozen Peanut Butter & Blueberry Sandwich - 22.4oz/8ct"), /Burstin' Blueberry/);
  assert.match(packageQaFlavorLabel("Frozen Peanut Butter & Blackberry Spread Sandwich - 8oz/4ct"), /Blackberry Boom/);
  assert.match(packageQaFlavorLabel("Peanut Butter & Mixed Berry Spread Sandwiches"), /Berry Burst/);
  assert.match(
    packageQaFlavorLabel("Peanut Butter & Chocolate Flavored Spread Sandwiches"),
    /^Peanut Butter & Chocolate Flavored Spread$/,
  );
  assert.match(
    packageQaFlavorLabel("Chocolate Flavored Hazelnut Spread Frozen Sandwich"),
    /^Chocolate Flavored Hazelnut Spread$/,
  );
  assert.match(
    packageQaFlavorLabel("Peanut Butter & Chocolate Flavored Hazelnut Spread Sandwich"),
    /^Peanut Butter & Chocolate Flavored Hazelnut Spread$/,
  );
});

test("sameFlavor matches plain peanut butter but not a flavored sibling", () => {
  assert.equal(
    sameFlavor(
      "Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct",
      "Uncrustables Peanut Butter Sandwiches, 4 Count",
    ),
    true,
  );
  assert.equal(
    sameFlavor(
      "Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct",
      "Uncrustables Peanut Butter & Strawberry Jam Sandwiches, 4 Count",
    ),
    false,
  );
  assert.equal(
    sameFlavor(
      "Peanut Butter & Chocolate Flavored Spread Sandwiches",
      "Chocolate Flavored Hazelnut Spread Frozen Sandwich",
    ),
    false,
  );
  assert.equal(
    sameFlavor(
      "Peanut Butter & Chocolate Flavored Hazelnut Spread Sandwich",
      "Chocolate Flavored Hazelnut Spread Frozen Sandwich",
    ),
    false,
  );
});
