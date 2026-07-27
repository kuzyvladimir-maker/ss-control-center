import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCanonicalRecipe,
  recipeSignature,
  selectedVariantFromJson,
  type RepairDonor,
} from "@/lib/bundle-factory/recipe-repair";
import type { Variant } from "@/lib/bundle-factory/variation-matrix";

const variant: Variant = {
  idx: 4,
  name: "45 Count Mix",
  composition: [
    {
      research_pool_id: "strawberry",
      product_name: "stale title",
      brand: "stale brand",
      qty: 23,
      unit_price_cents: 25,
    },
    {
      research_pool_id: "grape",
      product_name: "stale title",
      brand: "stale brand",
      qty: 22,
      unit_price_cents: 25,
    },
  ],
  cost_cents: 1125,
  suggested_price_cents: 0,
  margin_cents: 0,
  margin_pct: 0,
  feasibility_score: 90,
  notes: "",
};

function donor(id: string, flavor: string): RepairDonor {
  return {
    id,
    brand: "Uncrustables",
    flavor,
    title: `Uncrustables ${flavor}`,
    category: "Frozen",
    upc: id === "strawberry" ? "111111111111" : "222222222222",
    ingredients: "Wheat flour, peanuts, sugar.",
    allergenDeclaration: {
      contains: ["Peanut", "Wheat"],
      may_contain: [],
    },
    bestPrice: 1,
    offers: [{ price: 1, packSizeSeen: 1, pricePerUnit: 1 }],
    mainImageUrl: `https://example.com/${id}.jpg`,
    imageUrls: "[]",
    needsReview: false,
  };
}

test("selected variation is authoritative and donor facts repair stale components", () => {
  const selected = selectedVariantFromJson(JSON.stringify([variant]), 4);
  const result = buildCanonicalRecipe({
    variant: selected,
    packCount: 45,
    donors: new Map([
      ["strawberry", donor("strawberry", "Peanut Butter Strawberry")],
      ["grape", donor("grape", "Peanut Butter Grape")],
    ]),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.components.length, 2);
  assert.equal(result.components[0].unit_price_cents, 100);
  assert.equal(result.cost_cents, 4500);
  assert.match(result.components[0].ingredients, /Wheat flour/);
});

test("legacy donor title deterministically supplies a missing structured flavor", () => {
  const legacy = donor("strawberry", "Peanut Butter Strawberry");
  legacy.flavor = null;
  legacy.title =
    "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct";
  const single: Variant = {
    ...variant,
    composition: [
      {
        research_pool_id: "strawberry",
        product_name: legacy.title,
        brand: "Uncrustables",
        qty: 24,
        unit_price_cents: 25,
      },
    ],
  };
  const result = buildCanonicalRecipe({
    variant: single,
    packCount: 24,
    donors: new Map([[legacy.id, legacy]]),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.components[0].flavor, "Peanut Butter & Strawberry Jam");
});

test("recipe repair blocks missing manufacturer facts instead of guessing", () => {
  const bad = donor("grape", "Peanut Butter Grape");
  bad.ingredients = null;
  const result = buildCanonicalRecipe({
    variant,
    packCount: 45,
    donors: new Map([
      ["strawberry", donor("strawberry", "Peanut Butter Strawberry")],
      ["grape", bad],
    ]),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => /ingredients/.test(error)));
});

test("recipe repair blocks missing verified allergen declaration", () => {
  const unreviewed = donor("strawberry", "Peanut Butter Strawberry");
  unreviewed.allergenDeclaration = null;
  const single: Variant = {
    ...variant,
    composition: [{
      ...variant.composition[0],
      research_pool_id: unreviewed.id,
      qty: 24,
    }],
  };
  const result = buildCanonicalRecipe({
    variant: single,
    packCount: 24,
    donors: new Map([[unreviewed.id, unreviewed]]),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => /verified manufacturer allergen/.test(error)));
});

test("reviewed allergen declaration prevents false soy and preserves may-contain", () => {
  const reviewed = donor("strawberry", "Peanut Butter Strawberry");
  reviewed.ingredients =
    "Wheat flour, peanuts, soybean oil, fully hydrogenated soybean oil.";
  reviewed.allergenDeclaration = {
    contains: ["Peanut", "Wheat"],
    may_contain: ["Hazelnut", "Milk"],
  };
  const single: Variant = {
    ...variant,
    composition: [{
      ...variant.composition[0],
      research_pool_id: reviewed.id,
      qty: 24,
    }],
  };
  const result = buildCanonicalRecipe({
    variant: single,
    packCount: 24,
    donors: new Map([[reviewed.id, reviewed]]),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.components[0].allergens, ["peanuts", "wheat"]);
  assert.ok(!result.components[0].allergens.includes("soy"));
  assert.deepEqual(result.components[0].allergen_declaration, {
    contains: ["Peanut", "Wheat"],
    may_contain: ["Hazelnut", "Milk"],
  });
});

test("recipe signature ignores component order but not allocation", () => {
  const a = [
    { manufacturer_upc: "1", flavor: "Strawberry", qty: 23 },
    { manufacturer_upc: "2", flavor: "Grape", qty: 22 },
  ];
  assert.equal(recipeSignature(a), recipeSignature([...a].reverse()));
  assert.notEqual(
    recipeSignature(a),
    recipeSignature([{ ...a[0], qty: 22 }, { ...a[1], qty: 23 }]),
  );
});
