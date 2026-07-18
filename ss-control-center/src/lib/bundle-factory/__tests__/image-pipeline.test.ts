// Pure-function tests for the image-pipeline prompt builder. The full
// orchestrator (DB + image worker + R2 + compliance gate) is covered by
// scripts/smoke-image-pipeline.ts in mock mode.
//
// Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/image-pipeline.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildImagePrompt,
  composeRetailBoxes,
  isColdCategory,
  planReviewedUncrustablesImage,
  referenceBytesMatchReviewedArt,
  shouldUseExperimentalDeterministicCoolerHero,
} from "../image-pipeline";

// Owner-approved v2 MIX class: 12 + 12, each from genuine 4-count cartons.
const SAMPLE_VARIANT = {
  idx: 0,
  name: "Uncrustables Peanut Butter + Blackberry x 24",
  composition: [
    {
      research_pool_id: "donor-pb-4ct",
      qty: 12,
      product_name: "Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct",
      flavor: "Peanut Butter",
      brand: "Smucker's",
    },
    {
      research_pool_id: "donor-blackberry-4ct",
      qty: 12,
      product_name: "Smucker's Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwich - 8oz/4ct",
      flavor: "Blackberry Boom",
      brand: "Smucker's",
    },
  ],
  feasibility_score: 92,
} as unknown as Parameters<typeof buildImagePrompt>[0]["variant"];

// Owner-approved v2 SINGLE class: 24 = six genuine 4-count cartons.
const SINGLE_VARIANT = {
  idx: 0,
  name: "Uncrustables Peanut Butter x 24",
  composition: [{
    research_pool_id: "donor-pb-4ct",
    qty: 24,
    product_name: "Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct",
    flavor: "Peanut Butter",
    brand: "Smucker's",
  }],
  feasibility_score: 92,
} as unknown as Parameters<typeof buildImagePrompt>[0]["variant"];

const WRAPS_VARIANT = {
  idx: 0,
  name: "Uncrustables Hazelnut + Morning Protein Berry x 24",
  composition: [
    {
      research_pool_id: "donor-hazelnut-wrapper",
      qty: 12,
      product_name: "Chocolate Flavored Hazelnut Spread",
      flavor: "chocolate-hazelnut",
      brand: "Smucker's",
    },
    {
      research_pool_id: "donor-morning-protein-wrapper",
      qty: 12,
      product_name: "Morning Protein Peanut Butter & Mixed Berry Spread",
      flavor: "morning-protein-mixed-berry",
      brand: "Smucker's",
    },
  ],
  feasibility_score: 92,
} as unknown as Parameters<typeof buildImagePrompt>[0]["variant"];

function cold() {
  return buildImagePrompt({
    brand: "Salutem Vita",
    variant: SINGLE_VARIANT,
    composition_type: "SINGLE_FLAVOR",
    category: "FROZEN_GROCERY",
  });
}

test("isColdCategory — frozen + refrigerated are cold, shelf-stable is not", () => {
  assert.ok(isColdCategory("FROZEN_GROCERY"));
  assert.ok(isColdCategory("REFRIGERATED"));
  assert.ok(!isColdCategory("SHELF_STABLE"));
});

test("Uncrustables hero strategy — approved reference flow is the fail-closed default", () => {
  for (const explicit_opt_in of [undefined, "", "0", "true", "yes"]) {
    assert.equal(
      shouldUseExperimentalDeterministicCoolerHero({
        category: "FROZEN_GROCERY",
        composite_eligible: true,
        explicit_opt_in,
      }),
      false,
    );
  }
});

test("Uncrustables hero strategy — rejected empty-cooler compositor requires exact experimental opt-in", () => {
  assert.equal(
    shouldUseExperimentalDeterministicCoolerHero({
      category: "FROZEN_GROCERY",
      composite_eligible: true,
      explicit_opt_in: "1",
    }),
    true,
  );
  assert.equal(
    shouldUseExperimentalDeterministicCoolerHero({
      category: "SHELF_STABLE",
      composite_eligible: true,
      explicit_opt_in: "1",
    }),
    false,
  );
  assert.equal(
    shouldUseExperimentalDeterministicCoolerHero({
      category: "FROZEN_GROCERY",
      composite_eligible: false,
      explicit_opt_in: "1",
    }),
    false,
  );
});

test("composeRetailBoxes — exact decompositions only (owner rule 2026-07-07)", () => {
  assert.deepEqual(composeRetailBoxes(45, [15, 10, 4]), [15, 15, 15]);
  assert.deepEqual(composeRetailBoxes(30, [15, 10, 4]), [15, 15]);
  assert.deepEqual(composeRetailBoxes(24, [15, 10, 4]), [10, 10, 4]); // greedy 15 would strand 9
  assert.deepEqual(composeRetailBoxes(24, [8]), [8, 8, 8]); // protein line: 8ct boxes
  assert.equal(composeRetailBoxes(30, [8]), null);
  assert.equal(composeRetailBoxes(30, [4]), null);
  assert.equal(composeRetailBoxes(2, [15, 10, 4]), null);
  assert.deepEqual(composeRetailBoxes(90, [15, 10, 4]), [15, 15, 15, 15, 15, 15]);
});

test("reviewed Uncrustables planner — exact SINGLE and MIX carton counts come from registry", () => {
  const single = planReviewedUncrustablesImage({
    variant: SINGLE_VARIANT,
    image_mode: "retail_boxes",
  });
  assert.equal(single.ok, true);
  if (single.ok) {
    assert.equal(single.components[0].retail_pack_size, 4);
    assert.equal(single.components[0].visible_package_count, 6);
  }

  const mix = planReviewedUncrustablesImage({
    variant: SAMPLE_VARIANT,
    image_mode: "retail_boxes",
  });
  assert.equal(mix.ok, true);
  if (mix.ok) {
    assert.deepEqual(
      mix.components.map((component) => [
        component.flavor_id,
        component.retail_pack_size,
        component.visible_package_count,
      ]),
      [
        ["peanut-butter", 4, 3],
        ["peanut-butter-blackberry", 4, 3],
      ],
    );
  }
});

test("reviewed Uncrustables planner — non-divisible cartons and carton-only wrappers fail closed", () => {
  const nonDivisible = planReviewedUncrustablesImage({
    variant: {
      ...SINGLE_VARIANT,
      composition: [{ ...SINGLE_VARIANT.composition[0], qty: 30 }],
    } as typeof SINGLE_VARIANT,
    image_mode: "retail_boxes",
  });
  assert.equal(nonDivisible.ok, false);
  if (!nonDivisible.ok) {
    assert.match(nonDivisible.errors.join("; "), /not divisible by reviewed 4-count carton/i);
  }

  const cartonOnlyWrapper = planReviewedUncrustablesImage({
    variant: SINGLE_VARIANT,
    image_mode: "individual_wraps",
  });
  assert.equal(cartonOnlyWrapper.ok, false);
  if (!cartonOnlyWrapper.ok) {
    assert.match(cartonOnlyWrapper.errors.join("; "), /individual-wrapper art is missing/i);
  }
});

test("reviewed Uncrustables planner — wrappers require exact reviewed wrapper art", () => {
  const plan = planReviewedUncrustablesImage({
    variant: WRAPS_VARIANT,
    image_mode: "individual_wraps",
  });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.pack_mode, "individual-wrapper");
    assert.deepEqual(
      plan.components.map((component) => component.visible_package_count),
      [12, 12],
    );
    assert.ok(plan.components.every((component) => component.retail_pack_size === 1));
  }
});

test("reviewed Uncrustables planner — PB chocolate never aliases to chocolate hazelnut", () => {
  const plan = planReviewedUncrustablesImage({
    variant: {
      ...SINGLE_VARIANT,
      composition: [{
        ...SINGLE_VARIANT.composition[0],
        product_name:
          "Smuckers Uncrustables Peanut Butter & Chocolate Flavored Spread Sandwiches, 10 Count, 2 oz Each (Frozen)",
        flavor: "Peanut Butter & Chocolate Flavored Spread",
      }],
    } as typeof SINGLE_VARIANT,
    image_mode: "retail_boxes",
  });
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.match(plan.errors.join("; "), /reviewed retail-carton art is missing/i);
    assert.doesNotMatch(plan.errors.join("; "), /chocolate-hazelnut-carton/i);
  }
});

test("reviewed reference byte matcher — exact SHA passes and drift fails", () => {
  const genuine = Buffer.from("reviewed-wrapper-bytes");
  const sha256 = createHash("sha256").update(genuine).digest("hex");
  const evidence = [{
    kind: "reviewed-artifact" as const,
    locator: "data/audits/reviewed-wrapper.png",
    sha256,
  }];
  assert.equal(referenceBytesMatchReviewedArt(genuine, evidence), true);
  assert.equal(referenceBytesMatchReviewedArt(Buffer.from("different"), evidence), false);
});

test("buildImagePrompt (cold single) — frozen hero: real product + Salutem cooler + gel packs", () => {
  const out = cold();
  assert.match(out, /SALUTEM SOLUTIONS/);
  assert.match(out, /cooler/i);
  assert.match(out, /FROZEN GEL PACK/);
  assert.match(out, /ONLY to the cooler and the gel packs/i);
  assert.match(out, /NEVER onto the third-party product/i);
  assert.match(out, /NO loose ice/i);
  assert.match(out, /EXACTLY 4 white sealed branded gel packs/i);
  assert.match(out, /two inside.*left.*right.*two standing outside/i);
  assert.match(out, /BLUE "FROZEN GEL PACK" header/i);
  assert.match(out, /lower edges occluded behind the front inner rim/i);
  assert.match(out, /No floating products/i);
});

test("buildImagePrompt (single) — exact genuine carton count is preserved; listing total is not printed", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: SINGLE_VARIANT, // 24 = 6×4
    composition_type: "SINGLE_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  assert.match(out, /EXACTLY 6 real Uncrustables retail cartons/i);
  assert.match(out, /genuine printed 4-count badge/i);
  assert.match(out, /preserve only the genuine retail pack count/i);
  assert.match(out, /NEVER add 24 as a carton badge/i);
  assert.doesNotMatch(out, /NO printed quantity numbers or count badges/i);
  assert.doesNotMatch(out, /no digit in any corner|NO numbers on wrappers/i);
  assert.doesNotMatch(out, /about \d+ real Uncrustables retail/i);
});

test("buildImagePrompt (single) — NON-composable carton count blocks instead of rounding", () => {
  assert.throws(
    () => buildImagePrompt({
      brand: "Smucker's",
      variant: {
        ...SINGLE_VARIANT,
        composition: [{ ...SINGLE_VARIANT.composition[0], qty: 30 }],
      } as typeof SINGLE_VARIANT,
      composition_type: "SINGLE_FLAVOR",
      category: "FROZEN_GROCERY",
    }),
    /not divisible by reviewed 4-count carton/i,
  );
});

test("buildImagePrompt (retail_boxes_mix) — every flavor and exact donor carton decomposition", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: SAMPLE_VARIANT,
    composition_type: "MIXED_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  assert.match(out, /of Smucker's Uncrustables Frozen Peanut Butter Sandwich.*reference #2/);
  assert.match(out, /of Smucker's Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwich.*reference #3/);
  assert.match(out, /EXACTLY 3 genuine 4-count cartons.*reference #2/i);
  assert.match(out, /EXACTLY 3 genuine 4-count cartons.*reference #3/i);
  assert.match(out, /Reference images #2\.\.#3 are SHA-verified reviewed retail-carton art/i);
  assert.match(out, /visible carton plan reconciles exactly to 24 sandwiches/i);
  assert.doesNotMatch(out, /ABOUT this quantity|roughly 24|Math\.round/i);
  assert.doesNotMatch(out, /NO printed quantity numbers/i);
});

test("buildImagePrompt (individual_wraps) — exact wrapper refs/counts, never carton-derived art", () => {
  const out = buildImagePrompt({
    brand: "Smucker's",
    variant: WRAPS_VARIANT,
    composition_type: "MIXED_FLAVOR",
    category: "FROZEN_GROCERY",
    uncrustables_image_mode: "individual_wraps",
  });
  assert.match(out, /EXACTLY 24 individually wrapped/i);
  assert.match(out, /EXACTLY 12 wrappers of Chocolate Flavored Hazelnut/i);
  assert.match(out, /EXACTLY 12 wrappers of Morning Protein/i);
  assert.match(out, /reviewed individual-wrapper art/i);
  assert.match(out, /Do not derive wrapper art from a carton/i);
  assert.match(out, /no retail cartons, bare sandwiches, plain wrappers, generic wrappers/i);
  assert.doesNotMatch(out, /about 24|NO numbers/i);
});

test("buildImagePrompt (individual_wraps) — carton-only donor cannot authorize wrappers", () => {
  assert.throws(
    () => buildImagePrompt({
      brand: "Smucker's",
      variant: SINGLE_VARIANT,
      composition_type: "SINGLE_FLAVOR",
      category: "FROZEN_GROCERY",
      uncrustables_image_mode: "individual_wraps",
    }),
    /individual-wrapper art is missing/i,
  );
});

test("buildImagePrompt — wraps mode is IGNORED for a real gift set (non-own-brand)", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: {
      ...SAMPLE_VARIANT,
      composition: [{ qty: 3, product_name: "Ghirardelli Squares", brand: "Ghirardelli" }],
    } as unknown as Parameters<typeof buildImagePrompt>[0]["variant"],
    composition_type: "MULTI_FLAVOR",
    category: "FROZEN_GROCERY",
    uncrustables_image_mode: "individual_wraps",
  });
  // Non-own-brand → always the gift-set carton framing, never wrappers.
  assert.ok(!/individually-wrapped sandwiches/i.test(out));
  assert.match(out, /arranged as a gift set/i);
});

test("buildImagePrompt (shelf-stable) — clean product on white, no cooler", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: SAMPLE_VARIANT,
    composition_type: "MULTI_FLAVOR",
    category: "SHELF_STABLE",
  });
  assert.match(out, /pure white background/i);
  assert.match(out, /No cooler/i);
  assert.match(out, /reproduce the actual retail packaging/i);
});

test("buildImagePrompt — square / 1:1 on both paths", () => {
  assert.match(cold(), /1:1/);
});

test("buildImagePrompt — no promotional language anywhere", () => {
  const out = cold();
  for (const word of [
    "perfect", "ultimate", "premium", "amazing",
    "delicious", "delightful", "ideal", "incredible",
  ]) {
    assert.ok(
      !new RegExp(`\\b${word}\\b`, "i").test(out),
      `prompt contains promo word "${word}"`,
    );
  }
});

test("buildImagePrompt — handles empty composition gracefully (no crash)", () => {
  const out = buildImagePrompt({
    brand: "Salutem Vita",
    variant: { ...SAMPLE_VARIANT, composition: [] },
    composition_type: "SINGLE_FLAVOR",
    category: "FROZEN_GROCERY",
  });
  assert.match(out, /SALUTEM SOLUTIONS/);
});
