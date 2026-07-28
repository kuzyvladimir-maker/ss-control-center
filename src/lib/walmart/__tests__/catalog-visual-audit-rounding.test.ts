import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideBlind,
  type AuditCase,
  type AuditImageInput,
  type BlindObservation,
} from "../catalog-visual-audit.ts";

const image: AuditImageInput = {
  slot: "main",
  url: "https://example.test/white-bread-pack-4.png",
  buyer_facing_verified: false,
  surface: "last_applied_artifact",
};

const auditCase: AuditCase = {
  case_id: "white-bread-rounded-metric",
  sku: "FaisalX-1140",
  expected: {
    title: "Pepperidge Farm White Sandwich Bread, 16 oz (Pack of 4)",
    outer_units: 4,
    identity: {
      brand_aliases: ["Pepperidge Farm"],
      product_marker_groups: [["White Sandwich Bread"]],
      variant_marker_groups: [["white"]],
      forbidden_markers: [],
    },
    package_facts: [{
      kind: "net_content",
      value: 453.59237,
      unit: "g",
      requirement: "required",
    }],
    truth_source: "recipe",
  },
  images: [image],
};

const observation: BlindObservation = {
  image_id: "i_1140_main",
  visual_role: "tiled_main",
  visible_brand_text: "PEPPERIDGE FARM",
  visible_product_text: "White SLICED BREAD",
  visible_variant_text: "SANDWICH",
  visible_size_texts: ["NET WT 16 OZ (1 LB) (454g)"],
  external_package_count: {
    mode: "exact",
    value: 4,
    min: null,
    max: null,
  },
  outer_package_claims: [],
  inner_contents_claims: [],
  case_package_claims: [],
  unclear_quantity_claims: [],
  grid_cell_kind: "single_sellable_package",
  front_visibility: "all",
  background: "white",
  multiple_distinct_products: "no",
  readable_identity: "clear",
  evidence: [
    "PEPPERIDGE FARM",
    "White",
    "SANDWICH",
    "NET WT 16 OZ (1 LB) (454g)",
  ],
  flags: [],
};

test("multi-unit package label accepts rounded metric beside exact oz/lb", () => {
  const decision = decideBlind(auditCase, image, observation);
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.checks.package_facts.net_content, "MATCH");
});

test("same-unit-only package fact remains exact", () => {
  const decision = decideBlind(auditCase, image, {
    ...observation,
    visible_size_texts: ["453.6 g"],
  });
  assert.equal(decision.verdict, "BAD");
  assert.equal(decision.checks.package_facts.net_content, "MISMATCH");
});
