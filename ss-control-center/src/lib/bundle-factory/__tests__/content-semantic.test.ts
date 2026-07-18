import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSemanticOutput } from "@/lib/bundle-factory/content-generation";
import type { Variant } from "@/lib/bundle-factory/variation-matrix";

function variant(): Variant {
  return {
    idx: 0,
    name: "Strawberry + Grape — 45 ct",
    composition: [
      {
        research_pool_id: "strawberry",
        product_name: "Uncrustables Peanut Butter & Strawberry Jam",
        brand: "Uncrustables",
        flavor: "Peanut Butter & Strawberry Jam",
        qty: 23,
        unit_price_cents: 100,
      },
      {
        research_pool_id: "grape",
        product_name: "Uncrustables Peanut Butter & Grape Jelly",
        brand: "Uncrustables",
        flavor: "Peanut Butter & Grape Jelly",
        qty: 22,
        unit_price_cents: 100,
      },
    ],
    cost_cents: 4500,
    suggested_price_cents: 13099,
    margin_cents: 5000,
    margin_pct: 0.38,
    feasibility_score: 90,
    notes: "test",
  };
}

const base = {
  title: "Uncrustables Peanut Butter Strawberry Jam and Grape Jelly, 45 Count",
  bullets: [
    "Includes 23 peanut butter and strawberry jam sandwiches.",
    "Includes 22 peanut butter and grape jelly sandwiches.",
    "Ships frozen.",
    "Keep frozen until ready to eat.",
  ],
  description: "A 45-count mix of the two stated flavors.",
};

test("semantic content gate accepts exact count, flavors, and allocation", () => {
  assert.equal(
    validateSemanticOutput(base, {
      brand: "Uncrustables",
      pack_count: 45,
      selected_variant: variant(),
    }),
    null,
  );
});

test("semantic content gate rejects retail-count multiplication", () => {
  const error = validateSemanticOutput(
    { ...base, title: "Uncrustables Strawberry and Grape, 4 ct, Pack of 45" },
    { brand: "Uncrustables", pack_count: 45, selected_variant: variant() },
  );
  assert.match(error ?? "", /title count 180|multiplication/);
});

test("semantic content gate rejects a second retail-carton count claim", () => {
  const error = validateSemanticOutput(
    {
      ...base,
      title: "Uncrustables Strawberry and Grape, 10 Count, 45 Count",
    },
    { brand: "Uncrustables", pack_count: 45, selected_variant: variant() },
  );
  assert.match(error ?? "", /exactly one count claim|title count/);
});

test("semantic content gate rejects malformed packaging punctuation", () => {
  const error = validateSemanticOutput(
    {
      ...base,
      title: "Uncrustables Peanut Butter Strawberry Jam and Grape Jelly (2 oz, individually wrapped, ), 45 Count",
    },
    { brand: "Uncrustables", pack_count: 45, selected_variant: variant() },
  );
  assert.match(error ?? "", /malformed packaging punctuation/);
});

test("semantic content gate rejects omitted flavor and wrong allocation", () => {
  const error = validateSemanticOutput(
    {
      ...base,
      bullets: [
        "Includes 45 peanut butter and strawberry jam sandwiches.",
        "Ships frozen.",
        "Keep frozen.",
        "Individually wrapped.",
      ],
      description: "A 45-count strawberry assortment.",
    },
    { brand: "Uncrustables", pack_count: 45, selected_variant: variant() },
  );
  assert.match(error ?? "", /grape|23 pieces/);
});

test("semantic content gate does not multiply title count by a matching Pack of total in another field", () => {
  const output = {
    ...base,
    bullets: [
      "Pack of 45 individually wrapped frozen sandwiches.",
      ...base.bullets.slice(0, 3),
    ],
  };
  assert.equal(
    validateSemanticOutput(output, {
      brand: "Uncrustables",
      pack_count: 45,
      selected_variant: variant(),
    }),
    null,
  );
});

test("semantic content gate allows ordinary lunch boxes wording", () => {
  const output = {
    ...base,
    bullets: [
      ...base.bullets.slice(0, 2),
      "Each sandwich is individually wrapped for packing in lunch boxes or bags.",
      "Keep frozen until ready to eat.",
    ],
  };
  assert.equal(
    validateSemanticOutput(output, {
      brand: "Uncrustables",
      pack_count: 45,
      selected_variant: variant(),
    }),
    null,
  );
});

test("semantic content gate treats 12g Protein as nutrition, not flavor allocation", () => {
  const proteinVariant: Variant = {
    ...variant(),
    name: "Protein mix — 24 ct",
    composition: [
      {
        research_pool_id: "apple-protein",
        product_name:
          "Smucker's Uncrustables Frozen Peanut Butter & Apple Cinnamon Jelly Sandwich – 12g Protein 22.4oz/8ct",
        brand: "Uncrustables",
        flavor: null,
        qty: 12,
        unit_price_cents: 124,
      },
      {
        research_pool_id: "grape",
        product_name:
          "Smucker's Uncrustables Frozen Peanut Butter & Grape Jelly Sandwich - 8oz/4ct",
        brand: "Uncrustables",
        flavor: null,
        qty: 12,
        unit_price_cents: 97,
      },
    ],
  };
  const output = {
    title:
      "Uncrustables Peanut Butter Apple Cinnamon Protein and Grape Jelly, 24 Count",
    bullets: [
      "Includes 12 Peanut Butter and Apple Cinnamon Jelly Protein sandwiches and 12 Peanut Butter and Grape Jelly sandwiches.",
      "The Apple Cinnamon variety provides 12g of protein per serving.",
      "Each sandwich is individually wrapped.",
      "Keep frozen until ready to eat.",
    ],
    description:
      "A 24-count frozen variety with Apple Cinnamon Jelly Protein and Grape Jelly sandwiches.",
  };
  assert.equal(
    validateSemanticOutput(output, {
      brand: "Uncrustables",
      pack_count: 24,
      selected_variant: proteinVariant,
    }),
    null,
  );
});

test("semantic content gate rejects explicit retail carton multiplication in a bullet", () => {
  const output = {
    ...base,
    bullets: [
      "Includes 15-count retail cartons, with 3 cartons included for 45 sandwiches total.",
      ...base.bullets.slice(0, 3),
    ],
  };
  const error = validateSemanticOutput(output, {
    brand: "Uncrustables",
    pack_count: 45,
    selected_variant: variant(),
  });
  assert.match(error ?? "", /multiplication|retail boxes/);
});

test("semantic content gate accepts Pack of total when no retail-count claim competes", () => {
  const single: Variant = {
    ...variant(),
    name: "Peanut Butter — 90",
    composition: [
      {
        research_pool_id: "pb",
        product_name: "Uncrustables Peanut Butter Sandwich",
        brand: "Uncrustables",
        flavor: "Peanut Butter",
        qty: 90,
        unit_price_cents: 100,
      },
    ],
  };
  assert.equal(
    validateSemanticOutput(
      {
        title: "Uncrustables Frozen Peanut Butter Sandwich, Pack of 90",
        bullets: [
          "Includes 90 individually wrapped peanut butter sandwiches.",
          "Keep frozen.",
          "Thaw before eating.",
          "Each sandwich is wrapped separately.",
        ],
        description: "A frozen pack containing 90 peanut butter sandwiches.",
      },
      { brand: "Uncrustables", pack_count: 90, selected_variant: single },
    ),
    null,
  );
});

test("semantic content gate accepts total followed by individually wrapped sandwiches", () => {
  assert.equal(
    validateSemanticOutput(
      {
        ...base,
        title:
          "Uncrustables Strawberry Jam and Grape Jelly, 45 Individually Wrapped Sandwiches",
      },
      { brand: "Uncrustables", pack_count: 45, selected_variant: variant() },
    ),
    null,
  );
});

test("semantic flavor matching does not require Morning Protein line descriptor", () => {
  const morningVariant: Variant = {
    ...variant(),
    name: "Mixed Berry + Grape — 24",
    composition: [
      {
        research_pool_id: "mixed-berry",
        product_name:
          "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct",
        brand: "Uncrustables",
        flavor: null,
        qty: 12,
        unit_price_cents: 124,
      },
      {
        research_pool_id: "grape",
        product_name:
          "Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwich - 8oz/4ct",
        brand: "Uncrustables",
        flavor: null,
        qty: 12,
        unit_price_cents: 97,
      },
    ],
  };
  assert.equal(
    validateSemanticOutput(
      {
        title:
          "Uncrustables Peanut Butter Mixed Berry and Grape Jelly Sandwiches, 24 Count",
        bullets: [
          "Includes 12 Peanut Butter and Mixed Berry sandwiches.",
          "Includes 12 Peanut Butter and Grape Jelly sandwiches.",
          "Each sandwich is individually wrapped.",
          "Keep frozen until ready to eat.",
        ],
        description:
          "A 24-count frozen mix of Peanut Butter Mixed Berry and Peanut Butter Grape Jelly sandwiches.",
      },
      { brand: "Uncrustables", pack_count: 24, selected_variant: morningVariant },
    ),
    null,
  );
});
