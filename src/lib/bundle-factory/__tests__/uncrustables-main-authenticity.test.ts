import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UNCRUSTABLES_AUTHENTICITY_REGISTRY_SCHEMA,
  UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA,
  evaluateUncrustablesMainAuthenticity,
  sealUncrustablesAuthenticityRegistry,
  sealUncrustablesMainVisualApproval,
  uncrustablesMainReviewSubjectSha256,
  verifyUncrustablesAuthenticityRegistry,
  type AuthenticityEvidence,
  type UncrustablesAuthenticityFailureCode,
  type UncrustablesAuthenticityRegistry,
  type UncrustablesMainAuthenticityInput,
  type UncrustablesMainVisualApproval,
} from "../audit/uncrustables-main-authenticity";

const evidence = (
  locator: string,
  character: string,
): AuthenticityEvidence => ({
  kind: "retailer-source-image",
  locator,
  sha256: character.repeat(64),
});

const STRAWBERRY_CARTON = evidence(
  "https://target.scene7.com/is/image/Target/STRAWBERRY_CARTON_4CT",
  "a",
);
const STRAWBERRY_WRAPPER = evidence(
  "artifact://reviewed-sources/strawberry-wrapper.png",
  "b",
);
const GRAPE_CARTON = evidence(
  "https://target.scene7.com/is/image/Target/GRAPE_CARTON_4CT",
  "c",
);
const BLUEBERRY_CARTON = evidence(
  "artifact://reviewed-sources/blueberry-carton.png",
  "d",
);

function registry(): UncrustablesAuthenticityRegistry {
  return sealUncrustablesAuthenticityRegistry({
    schema_version: UNCRUSTABLES_AUTHENTICITY_REGISTRY_SCHEMA,
    immutable: true,
    registry_id: "uncrustables-us-test-registry-2026-07-18",
    reviewed_at: "2026-07-18T01:00:00.000Z",
    reviewed_by: "human-reviewer@example.test",
    review_method: "human-visual-with-source-evidence",
    brand: {
      product_brand: "Uncrustables",
      owner: "The J.M. Smucker Company",
      market: "US",
      allowed_marks: ["Smucker's", "Uncrustables"],
    },
    flavors: [
      {
        flavor_id: "pb-strawberry",
        display_name: "Peanut Butter & Strawberry Jam",
        aliases: [
          "Smucker's Uncrustables Peanut Butter & Strawberry Jam",
          "Peanut Butter and Strawberry Jam",
        ],
        art: [
          {
            art_id: "pb-strawberry-carton-us-4ct-v1",
            pack_mode: "retail-carton",
            retail_pack_size: 4,
            market: "US",
            brand_marks: ["Smucker's", "Uncrustables"],
            evidence: [STRAWBERRY_CARTON],
          },
          {
            art_id: "pb-strawberry-wrapper-us-v1",
            pack_mode: "individual-wrapper",
            retail_pack_size: 1,
            market: "US",
            brand_marks: ["Smucker's", "Uncrustables"],
            evidence: [STRAWBERRY_WRAPPER],
          },
        ],
      },
      {
        flavor_id: "pb-grape",
        display_name: "Peanut Butter & Grape Jelly",
        aliases: ["Smucker's Uncrustables Peanut Butter & Grape Jelly"],
        art: [
          {
            art_id: "pb-grape-carton-us-4ct-v1",
            pack_mode: "retail-carton",
            retail_pack_size: 4,
            market: "US",
            brand_marks: ["Smucker's", "Uncrustables"],
            evidence: [GRAPE_CARTON],
          },
        ],
      },
      {
        flavor_id: "pb-blueberry",
        display_name: "Peanut Butter & Blueberry Spread",
        aliases: ["Burstin' Blueberry"],
        art: [
          {
            art_id: "pb-blueberry-carton-us-8ct-v1",
            pack_mode: "retail-carton",
            retail_pack_size: 8,
            market: "US",
            brand_marks: ["Smucker's", "Uncrustables"],
            evidence: [BLUEBERRY_CARTON],
          },
        ],
      },
    ],
  });
}

function approvalFor(
  input: UncrustablesMainAuthenticityInput,
  overrides: Partial<UncrustablesMainVisualApproval> = {},
): UncrustablesMainVisualApproval {
  const sealed = sealUncrustablesMainVisualApproval({
    schema_version: UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA,
    immutable: true,
    approval_id: "approval-test-001",
    approval_locator: "artifact://main-approvals/approval-test-001.json",
    reviewer: "visual-reviewer@example.test",
    reviewed_at: "2026-07-18T02:10:00.000Z",
    review_method: "human-visual",
    decision: "APPROVED",
    subject_sha256: uncrustablesMainReviewSubjectSha256(input),
    checklist: {
      image_opened_and_compared_to_registry_evidence: true,
      all_required_flavors_present: true,
      only_reviewed_brand_art_present: true,
      pack_modes_and_sizes_match_recipe: true,
      no_foreign_or_fictional_items: true,
      exact_per_variant_package_counts_match_recipe: true,
      frozen_kit_geometry_and_branding_match_anchor: true,
      exactly_two_inside_and_two_outside_gel_packs: true,
      products_physically_seated_without_floating_or_paste: true,
      pure_white_square_amazon_main_background: true,
      no_loose_ice_water_overlays_or_extra_props: true,
    },
  });
  return { ...sealed, ...overrides };
}

function validMixedInput(): UncrustablesMainAuthenticityInput {
  const input: UncrustablesMainAuthenticityInput = {
    sku: "TEST-MIX-24",
    image: {
      kind: "generated-main",
      locator: "artifact://generated-main/TEST-MIX-24.png",
      sha256: "1".repeat(64),
    },
    generation_manifest: {
      kind: "generation-manifest",
      locator: "data/audits/generation-test.json#/rows/TEST-MIX-24",
      sha256: "2".repeat(64),
    },
    recipe: {
      recipe_id: "recipe-test-mix-24",
      components: [
        {
          flavor: "Smucker's Uncrustables Peanut Butter & Strawberry Jam",
          quantity: 12,
          expected_pack_mode: "retail-carton",
          expected_retail_pack_size: 4,
        },
        {
          flavor: "pb-grape",
          quantity: 12,
          expected_pack_mode: "retail-carton",
          expected_retail_pack_size: 4,
        },
      ],
    },
    registry: registry(),
    visual_observation: {
      observer: "visual-observer@example.test",
      observed_at: "2026-07-18T02:00:00.000Z",
      method: "human-visual",
      items: [
        {
          observation_id: "visible-strawberry-carton",
          flavor: "Peanut Butter and Strawberry Jam",
          art_id: "pb-strawberry-carton-us-4ct-v1",
          pack_mode: "retail-carton",
          retail_pack_size: 4,
          visible_package_count: 3,
          brand_marks: ["Smucker's", "Uncrustables"],
          classification: "reviewed-real-uncrustables",
          reference_evidence: [STRAWBERRY_CARTON],
        },
        {
          observation_id: "visible-grape-carton",
          flavor: "Peanut Butter & Grape Jelly",
          art_id: "pb-grape-carton-us-4ct-v1",
          pack_mode: "retail-carton",
          retail_pack_size: 4,
          visible_package_count: 3,
          brand_marks: ["Smucker's", "Uncrustables"],
          classification: "reviewed-real-uncrustables",
          reference_evidence: [GRAPE_CARTON],
        },
      ],
      foreign_items: [],
      fictional_or_unknown_items: [],
      scene: {
        background_is_pure_white: true,
        square_one_to_one: true,
        cooler_is_white_textured_eps: true,
        cooler_lid_leans_behind: true,
        salutem_cooler_branding_matches_anchor: true,
        gel_packs_total: 4,
        gel_packs_inside: 2,
        gel_packs_outside: 2,
        gel_packs_all_match_anchor: true,
        products_all_seated_inside_behind_front_rim: true,
        product_perspective_contact_and_shadows_believable: true,
        floating_pasted_halo_or_wall_intersection_items: [],
        loose_ice_snow_or_water_items: [],
        forbidden_overlay_or_extra_prop_items: [],
      },
    },
    human_approval: null,
  };
  input.human_approval = approvalFor(input);
  return input;
}

function codes(input: UncrustablesMainAuthenticityInput): Set<UncrustablesAuthenticityFailureCode> {
  return new Set(
    evaluateUncrustablesMainAuthenticity(input).hard_fails.map((item) => item.code),
  );
}

test("sealed reviewed registry models both cartons and individual wrappers", () => {
  const value = registry();
  assert.doesNotThrow(() => verifyUncrustablesAuthenticityRegistry(value));
  assert.match(value.sha256, /^[a-f0-9]{64}$/);
});

test("passes exact mixed recipe, pack art, evidence, and bound human approval", () => {
  const result = evaluateUncrustablesMainAuthenticity(validMixedInput());
  assert.equal(result.pass, true);
  assert.equal(result.verified, true);
  assert.equal(result.decision, "CAN_USE_MAIN");
  assert.equal(result.cost_cents, 0);
  assert.deepEqual(result.hard_fails, []);
  assert.deepEqual(result.observed.required_flavor_ids, ["pb-grape", "pb-strawberry"]);
});

test("supports an exact reviewed individual-wrapper presentation", () => {
  const input = validMixedInput();
  input.recipe.components = [
    {
      flavor: "pb-strawberry",
      quantity: 6,
      expected_pack_mode: "individual-wrapper",
      expected_retail_pack_size: 1,
    },
  ];
  input.visual_observation.items = [
    {
      observation_id: "visible-strawberry-wrapper",
      flavor: "pb-strawberry",
      art_id: "pb-strawberry-wrapper-us-v1",
      pack_mode: "individual-wrapper",
      retail_pack_size: 1,
      visible_package_count: 6,
      brand_marks: ["Smucker's", "Uncrustables"],
      classification: "reviewed-real-uncrustables",
      reference_evidence: [STRAWBERRY_WRAPPER],
    },
  ];
  input.human_approval = approvalFor(input);

  assert.equal(evaluateUncrustablesMainAuthenticity(input).pass, true);
});

test("fails closed without human visual approval", () => {
  const input = validMixedInput();
  input.human_approval = null;
  const result = evaluateUncrustablesMainAuthenticity(input);
  assert.equal(result.pass, false);
  assert.equal(result.verified, false);
  assert.ok(codes(input).has("HUMAN_APPROVAL_REQUIRED"));
});

test("approval becomes stale after the generated MAIN hash changes", () => {
  const input = validMixedInput();
  input.image.sha256 = "9".repeat(64);
  assert.ok(codes(input).has("HUMAN_APPROVAL_STALE"));
});

test("rejects unknown recipe flavors instead of fuzzy-matching fiction", () => {
  const input = validMixedInput();
  input.recipe.components[0].flavor = "Peanut Butter & Galactic Berry Jam";
  input.human_approval = approvalFor(input);
  assert.ok(codes(input).has("UNKNOWN_FLAVOR"));
});

test("rejects a missing required flavor", () => {
  const input = validMixedInput();
  input.visual_observation.items = [input.visual_observation.items[0]];
  input.human_approval = approvalFor(input);
  assert.ok(codes(input).has("MISSING_REQUIRED_FLAVOR"));
});

test("rejects a real but recipe-foreign extra flavor", () => {
  const input = validMixedInput();
  input.visual_observation.items.push({
    observation_id: "visible-blueberry-carton",
    flavor: "Burstin' Blueberry",
    art_id: "pb-blueberry-carton-us-8ct-v1",
    pack_mode: "retail-carton",
    retail_pack_size: 8,
    visible_package_count: 1,
    brand_marks: ["Smucker's", "Uncrustables"],
    classification: "reviewed-real-uncrustables",
    reference_evidence: [BLUEBERRY_CARTON],
  });
  input.human_approval = approvalFor(input);
  assert.ok(codes(input).has("UNEXPECTED_FLAVOR"));
});

test("rejects unknown pack sizes and invented brand-art ids", () => {
  const input = validMixedInput();
  input.recipe.components[0].expected_retail_pack_size = 6;
  input.visual_observation.items[0].retail_pack_size = 6;
  input.visual_observation.items[0].art_id = "pb-strawberry-carton-us-6ct-invented";
  input.human_approval = approvalFor(input);
  const found = codes(input);
  assert.ok(found.has("UNKNOWN_PACK_SIZE"));
  assert.ok(found.has("UNKNOWN_BRAND_ART"));
});

test("rejects a visible product count that does not equal recipe quantity divided by pack size", () => {
  const input = validMixedInput();
  input.visual_observation.items[0].visible_package_count = 2;
  input.human_approval = approvalFor(input);
  assert.ok(codes(input).has("PRODUCT_COUNT_MISMATCH"));
});

test("rejects wrong gel-pack arithmetic and layout", () => {
  const input = validMixedInput();
  input.visual_observation.scene.gel_packs_total = 5;
  input.visual_observation.scene.gel_packs_inside = 3;
  input.human_approval = approvalFor(input);
  assert.ok(codes(input).has("GEL_PACK_LAYOUT_MISMATCH"));
});

test("rejects loose ice and physically floating or pasted products", () => {
  const input = validMixedInput();
  input.visual_observation.scene.loose_ice_snow_or_water_items = [
    "blue crushed ice beneath the cartons",
  ];
  input.visual_observation.scene.products_all_seated_inside_behind_front_rim = false;
  input.visual_observation.scene.floating_pasted_halo_or_wall_intersection_items = [
    "front-right carton has a visible gap beneath it",
  ];
  input.human_approval = approvalFor(input);
  const found = codes(input);
  assert.ok(found.has("LOOSE_ICE_VISIBLE"));
  assert.ok(found.has("PRODUCT_PHYSICAL_SEATING_INVALID"));
});

test("rejects malformed or omitted structured scene evidence", () => {
  const input = validMixedInput();
  delete (input.visual_observation as Partial<typeof input.visual_observation>).scene;
  input.human_approval = approvalFor(input);
  assert.ok(codes(input).has("VISUAL_OBSERVATION_INVALID"));
});

test("rejects foreign, fictional, and unreviewed brand observations", () => {
  const input = validMixedInput();
  input.visual_observation.foreign_items.push("unrelated foreign snack carton");
  input.visual_observation.fictional_or_unknown_items.push("made-up berry package");
  input.visual_observation.items[0].brand_marks.push("Imaginary Foods");
  input.human_approval = approvalFor(input);
  const found = codes(input);
  assert.ok(found.has("FOREIGN_ITEM"));
  assert.ok(found.has("FICTIONAL_ITEM"));
  assert.ok(found.has("FOREIGN_BRAND_MARK"));
});

test("rejects an observation that is not bound to exact registry evidence", () => {
  const input = validMixedInput();
  input.visual_observation.items[0].reference_evidence = [
    { ...STRAWBERRY_CARTON, sha256: "e".repeat(64) },
  ];
  input.human_approval = approvalFor(input);
  assert.ok(codes(input).has("BRAND_ART_EVIDENCE_MISMATCH"));
});

test("rejects a registry whose sealed reviewed art was changed", () => {
  const input = validMixedInput();
  input.registry.flavors[0].art[0].retail_pack_size = 99;
  input.human_approval = approvalFor(input);
  assert.ok(codes(input).has("REGISTRY_INVALID"));
});

test("OCR-only observations cannot satisfy the visual gate", () => {
  const input = validMixedInput();
  (input.visual_observation as { method: string }).method = "ocr";
  input.human_approval = approvalFor(input);
  assert.ok(codes(input).has("VISUAL_OBSERVATION_INVALID"));
});

test("rejects an approval record whose sealed checklist was altered", () => {
  const input = validMixedInput();
  assert.ok(input.human_approval);
  input.human_approval.notes = "changed after approval was sealed";
  assert.ok(codes(input).has("HUMAN_APPROVAL_INVALID"));
});
