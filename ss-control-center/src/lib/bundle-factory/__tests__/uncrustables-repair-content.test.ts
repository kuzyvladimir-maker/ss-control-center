import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasExcessiveAmazonTitleWordFrequency,
  renderUncrustablesCommercialRepairContent,
  renderUncrustablesRepairContent,
  uncrustablesFlavorLabel,
} from "../repair/uncrustables-content";
import {
  validateOutput,
  validateSemanticOutput,
} from "../content-generation";
import { rulePromotionalLanguage } from "../compliance/rules/rule-8-promotional-language";
import type { Variant } from "../variation-matrix";

function mixedVariant(): Variant {
  return {
    idx: 0,
    name: "Protein Strawberry + Mixed Berry — 24 ct",
    composition: [
      {
        research_pool_id: "strawberry",
        product_name: "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich – 12g Protein 22.4oz/8ct",
        brand: "Uncrustables",
        flavor: null,
        qty: 12,
        unit_price_cents: 124,
      },
      {
        research_pool_id: "mixed",
        product_name: "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct",
        brand: "Uncrustables",
        flavor: null,
        qty: 12,
        unit_price_cents: 124,
      },
    ],
    cost_cents: 2976,
    suggested_price_cents: 7699,
    margin_cents: 4023,
    margin_pct: 0.52,
    feasibility_score: 100,
    notes: "test",
  };
}

test("flavor label removes brand, format, and retail-carton size only", () => {
  assert.equal(
    uncrustablesFlavorLabel("Smucker's Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwich - 8oz/4ct"),
    "Peanut Butter & Blackberry Spread",
  );
  assert.equal(
    uncrustablesFlavorLabel("Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich – 12g Protein 22.4oz/8ct"),
    "Peanut Butter & Strawberry Jam – 12g Protein",
  );
  assert.equal(
    uncrustablesFlavorLabel("Smuckers Uncrustables Peanut Butter & Chocolate Flavored Spread Sandwiches, 10 Count, 2 oz Each (Frozen)"),
    "Peanut Butter & Chocolate Flavored Spread",
  );
  assert.equal(
    uncrustablesFlavorLabel("Smucker's Uncrustables Peanut Butter & Strawberry Jam Sandwich (2 oz, individually wrapped, frozen)"),
    "Peanut Butter & Strawberry Jam",
  );
  assert.equal(
    uncrustablesFlavorLabel("Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwiches, 2 oz, 4 Count (Frozen)"),
    "Peanut Butter & Grape Jelly",
  );
});

test("deterministic repair copy passes format, recipe, and claim gates", () => {
  const variant = mixedVariant();
  const content = renderUncrustablesRepairContent({ variant, total: 24 });
  assert.equal(validateOutput(content, "amazon"), null);
  assert.equal(
    validateSemanticOutput(content, {
      brand: "Uncrustables",
      pack_count: 24,
      selected_variant: variant,
    }),
    null,
  );
  assert.equal(
    rulePromotionalLanguage({
      ...content,
      brand: "Uncrustables",
      bundle_components: variant.composition.map((component) => ({
        brand: component.brand,
        product_name: component.product_name,
      })),
      skip_image_check: true,
    }).passed,
    true,
  );
});

test("renderer refuses a recipe/count mismatch", () => {
  assert.throws(
    () => renderUncrustablesRepairContent({ variant: mixedVariant(), total: 45 }),
    /does not equal intended count/,
  );
});

test("commercial renderer stays concrete without unsupported claims or gift framing", () => {
  const variant = mixedVariant();
  const content = renderUncrustablesCommercialRepairContent({
    variant,
    total: 24,
  });
  assert.equal(content.bullets.length, 5);
  assert.match(content.bullets[0], /^Exact assortment:/);
  assert.match(content.bullets[0], /12 Peanut Butter & Strawberry Jam – 12g Protein/);
  assert.match(content.bullets[0], /12 Morning Protein Peanut Butter & Mixed Berry Spread/);
  assert.match(content.bullets[1], /insulated foam cooler and frozen gel packs/i);
  assert.ok(content.bullets.every((bullet) => !/^[A-Z][A-Z -]+:/.test(bullet)));
  assert.ok(content.bullets.every((bullet) => bullet.length < 255));
  assert.equal(validateOutput(content, "amazon"), null);
  assert.equal(
    validateSemanticOutput(content, {
      brand: "Uncrustables",
      pack_count: 24,
      selected_variant: variant,
    }),
    null,
  );
  assert.equal(
    rulePromotionalLanguage({
      ...content,
      brand: "Uncrustables",
      bundle_components: variant.composition.map((component) => ({
        brand: component.brand,
        product_name: component.product_name,
      })),
      own_brand: true,
      skip_image_check: true,
    }).passed,
    true,
  );
  const corpus = [content.title, ...content.bullets, content.description].join("\n");
  assert.doesNotMatch(
    corpus,
    /\b(?:\d+(?:\.\d+)?\s*(?:oz|ounces?)|calories?|fat|sodium|sugar|preservatives?|allergen-free|ships?|shipped|shipping|delivered|arrives?|\d+\s*(?:minutes?|hours?|days?)|0\s*degrees|microwave|refreeze|curated|gift\s+(?:set|basket)|affiliated|authorized)\b/i,
  );
  assert.doesNotMatch(corpus, /Salutem/i);
  assert.equal(hasExcessiveAmazonTitleWordFrequency(content.title), false);
});

test("commercial title falls back to flavor count before a substantive word appears three times", () => {
  const base = mixedVariant();
  const repeated: Variant = {
    ...base,
    name: "Three peanut butter varieties",
    composition: [
      { ...base.composition[0], research_pool_id: "one", qty: 8 },
      { ...base.composition[1], research_pool_id: "two", qty: 8 },
      {
        ...base.composition[0],
        research_pool_id: "three",
        product_name:
          "Smucker's Uncrustables Frozen Peanut Butter & Grape Jelly Sandwich - 8oz/4ct",
        qty: 8,
      },
    ],
  };
  const content = renderUncrustablesCommercialRepairContent({
    variant: repeated,
    total: 24,
  });
  assert.match(content.title, /3 Flavors, Individually Wrapped, 24 Count$/);
  assert.doesNotMatch(content.title, /Peanut Butter/);
  assert.equal(hasExcessiveAmazonTitleWordFrequency(content.title), false);
  assert.match(content.bullets[0], /8 Peanut Butter & Strawberry Jam/);
  assert.match(content.bullets[0], /8 Morning Protein Peanut Butter & Mixed Berry Spread/);
  assert.match(content.bullets[0], /8 Peanut Butter & Grape Jelly/);
});
