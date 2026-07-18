import assert from "node:assert/strict";
import test from "node:test";

import {
  WALMART_TRUTH_PREFLIGHT_COVERAGE_SCHEMA,
  WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA,
  extractTitleOuterCountEvidence,
  parseTruthPreflightInput,
  preflightWalmartAuditTruth,
  summarizeTruthPreflightCoverage,
} from "../catalog-visual-truth-preflight.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function identity(overrides = {}) {
  return {
    brand_aliases: ["Pepperidge Farm"],
    product_marker_groups: [["Thin Sliced Bread", "Whole Grain Bread"]],
    variant_marker_groups: [["15 Grain"]],
    forbidden_markers: [{ role: "variant", aliases: ["Oatmeal"] }],
    ...overrides,
  };
}

function facts() {
  return [
    { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
  ];
}

function source(source_ref_id, source_kind, payload_sha256, supports) {
  return {
    source_ref_id,
    source_kind,
    locator: `fixture://${source_ref_id}`,
    captured_at: "2026-07-18T12:30:00Z",
    payload_sha256,
    supports,
  };
}

function validInput() {
  return {
    schema_version: WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA,
    sku: "PF-BREAD-6",
    item_id: "123456789",
    listing_kind: "multipack",
    current_title: "Pepperidge Farm 15 Grain Thin Sliced Bread, 22 oz, Pack of 6",
    current_title_source_ref_ids: ["live-title"],
    recipe: {
      recipe_id: "recipe-PF-BREAD-6-v2",
      composition: "same_product",
      outer_units: 6,
      components: [{
        component_id: "PF-15GRAIN-22OZ",
        quantity: 6,
        identity: identity(),
        package_facts: facts(),
        source_ref_ids: ["recipe"],
      }],
      source_ref_ids: ["recipe"],
    },
    structured_record: {
      outer_units: 6,
      components: [{ component_id: "PF-15GRAIN-22OZ", quantity: 6 }],
      source_ref_ids: ["structured"],
    },
    proposed_truth: {
      outer_units: 6,
      identity: identity(),
      package_facts: facts(),
      truth_source: "manual_verified",
      source_ref_ids: ["truth"],
    },
    source_evidence: [
      source("live-title", "buyer_pdp", SHA_A, ["current_title"]),
      source("recipe", "recipe_record", SHA_B, ["outer_units", "component_truth"]),
      source("structured", "seller_catalog", SHA_C, ["outer_units", "component_truth"]),
      source("truth", "sku_reference_catalog", SHA_D, ["outer_units", "identity", "package_facts"]),
    ],
  };
}

function codes(result) {
  return new Set(result.reasons.map((reason) => reason.code));
}

test("valid same-product truth becomes comparator-ready v3 truth without image input", () => {
  const result = preflightWalmartAuditTruth(validInput());
  assert.equal(result.status, "AUDITABLE");
  assert.equal(result.reasons.length, 0);
  assert.match(result.input_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.expected, {
    title: "Pepperidge Farm 15 Grain Thin Sliced Bread, 22 oz, Pack of 6",
    outer_units: 6,
    identity: identity(),
    package_facts: facts(),
    truth_source: "manual_verified",
  });
  assert.deepEqual(result.evidence_bindings.map((item) => item.source_ref_id), [
    "live-title", "recipe", "structured", "truth",
  ]);
});

test("brand-equals-product truth may explicitly have no separate product marker", () => {
  const input = validInput();
  const brandProduct = {
    brand_aliases: ["Dr Pepper"],
    product_marker_groups: [],
    variant_marker_groups: [],
    forbidden_markers: [{ role: "product", aliases: ["Diet", "Zero Sugar"] }],
  };
  input.sku = "DR-PEPPER-4";
  input.item_id = "987654321";
  input.current_title = "Dr Pepper Soda Pop, 2 L Bottle, Pack of 4";
  input.recipe.outer_units = 4;
  input.recipe.components[0].quantity = 4;
  input.recipe.components[0].identity = structuredClone(brandProduct);
  input.recipe.components[0].package_facts = [
    { kind: "net_content", value: 2, unit: "l", requirement: "required" },
  ];
  input.structured_record.outer_units = 4;
  input.structured_record.components[0].quantity = 4;
  input.proposed_truth.outer_units = 4;
  input.proposed_truth.identity = structuredClone(brandProduct);
  input.proposed_truth.package_facts = [
    { kind: "net_content", value: 2, unit: "l", requirement: "required" },
  ];
  const result = preflightWalmartAuditTruth(input);
  assert.equal(result.status, "AUDITABLE");
  assert.deepEqual(result.expected.identity.product_marker_groups, []);
});

test("outer quantity must agree across recipe, structured record, proposed truth, title, and component sums", () => {
  const input = validInput();
  input.structured_record.outer_units = 4;
  input.structured_record.components[0].quantity = 5;
  const result = preflightWalmartAuditTruth(input);
  assert.equal(result.status, "TRUTH_REVIEW");
  assert.equal(result.expected, null);
  assert(codes(result).has("OUTER_COUNT_DISAGREEMENT"));
  assert(codes(result).has("STRUCTURED_COMPONENT_DISAGREEMENT"));
});

test("title parser distinguishes bare inner count and blocks conflicting explicit pack claims", () => {
  assert.deepEqual(
    extractTitleOuterCountEvidence("Hamburger Buns, 8 Count, Pack of 6"),
    {
      status: "EXACT",
      value: 6,
      claims: [{ value: 6, phrase: "Pack of 6", syntax: "pack_of" }],
    },
  );
  const nested = extractTitleOuterCountEvidence("Soda Cans, 12-Pack, Pack of 4");
  assert.equal(nested.status, "AMBIGUOUS");
  assert.deepEqual(nested.claims.map((claim) => claim.value), [12, 4]);
  assert.deepEqual(
    extractTitleOuterCountEvidence("Gatorade Cool Blue, 28 fl oz, Quantity of 6"),
    {
      status: "EXACT",
      value: 6,
      claims: [{ value: 6, phrase: "Quantity of 6", syntax: "quantity_of" }],
    },
  );

  const input = validInput();
  input.current_title = "Pepperidge Farm 15 Grain Thin Sliced Bread, 12-Pack, Pack of 6";
  const result = preflightWalmartAuditTruth(input);
  assert.equal(result.status, "TRUTH_REVIEW");
  assert(codes(result).has("TITLE_OUTER_COUNT_AMBIGUOUS"));
});

test("net content cannot be silently conflated with inner item count", () => {
  const input = validInput();
  const ambiguous = [
    { kind: "net_content", value: 8, unit: "count", requirement: "required" },
  ];
  input.proposed_truth.package_facts = ambiguous;
  input.recipe.components[0].package_facts = structuredClone(ambiguous);
  const result = preflightWalmartAuditTruth(input);
  assert.equal(result.status, "TRUTH_REVIEW");
  assert(codes(result).has("NET_CONTENT_INNER_COUNT_AMBIGUITY"));
  assert.equal(result.expected, null);
});

test("component identity and package truth are required independently", () => {
  const input = validInput();
  input.recipe.components[0].identity = null;
  input.recipe.components[0].package_facts = null;
  const result = preflightWalmartAuditTruth(input);
  assert.equal(result.status, "TRUTH_REVIEW");
  assert(codes(result).has("MISSING_COMPONENT_TRUTH"));
  assert(codes(result).has("PACKAGE_FACTS_MISSING"));
});

test("declared mixed/variety truth is unsupported by the single-product comparator", () => {
  const input = validInput();
  input.listing_kind = "variety";
  input.recipe.composition = "variety_pack";
  const result = preflightWalmartAuditTruth(input);
  assert.equal(result.status, "UNSUPPORTED");
  assert.equal(result.expected, null);
  assert(codes(result).has("MIXED_BUNDLE_UNSUPPORTED"));
});

test("same_product declaration with divergent component truth is review, never guessed", () => {
  const input = validInput();
  input.recipe.outer_units = 6;
  input.recipe.components = [
    {
      ...input.recipe.components[0],
      component_id: "PF-15GRAIN-22OZ",
      quantity: 3,
    },
    {
      ...structuredClone(input.recipe.components[0]),
      component_id: "PF-OATMEAL-24OZ",
      quantity: 3,
      identity: identity({ variant_marker_groups: [["Oatmeal"]] }),
      package_facts: [{ kind: "net_content", value: 24, unit: "oz", requirement: "required" }],
    },
  ];
  input.structured_record.components = input.recipe.components.map(({ component_id, quantity }) => ({
    component_id,
    quantity,
  }));
  const result = preflightWalmartAuditTruth(input);
  assert.equal(result.status, "TRUTH_REVIEW");
  assert(codes(result).has("MIXED_BUNDLE_AMBIGUOUS"));
  assert(codes(result).has("COMPONENT_TRUTH_CONTRADICTION"));
});

test("current title must positively match identity and must not contain explicit forbidden identity", () => {
  const input = validInput();
  input.current_title = "Pepperidge Farm Oatmeal Bread, 22 oz, Pack of 6";
  const result = preflightWalmartAuditTruth(input);
  assert.equal(result.status, "TRUTH_REVIEW");
  assert(codes(result).has("TITLE_IDENTITY_CONTRADICTION"));
  assert.match(
    result.reasons.find((reason) => reason.code === "TITLE_IDENTITY_CONTRADICTION").message,
    /missing product group 1, variant group 1; contains forbidden variant:Oatmeal/,
  );
});

test("missing, malformed, unscoped, and unknown source evidence all fail closed", () => {
  const missing = validInput();
  missing.source_evidence.find((item) => item.source_ref_id === "truth").payload_sha256 = null;
  let result = preflightWalmartAuditTruth(missing);
  assert(codes(result).has("MISSING_SOURCE_SHA256"));

  const malformed = validInput();
  malformed.source_evidence.find((item) => item.source_ref_id === "truth").payload_sha256 = "sha256:nope";
  result = preflightWalmartAuditTruth(malformed);
  assert(codes(result).has("INVALID_SOURCE_SHA256"));

  const unscoped = validInput();
  unscoped.source_evidence.find((item) => item.source_ref_id === "truth").supports = ["identity"];
  result = preflightWalmartAuditTruth(unscoped);
  assert(codes(result).has("SOURCE_SCOPE_MISSING"));

  const unknown = validInput();
  unknown.proposed_truth.source_ref_ids = ["does-not-exist"];
  result = preflightWalmartAuditTruth(unknown);
  assert(codes(result).has("UNKNOWN_SOURCE_REFERENCE"));
});

test("donor image cannot become product truth and legacy donor fields are rejected", () => {
  const donorOnly = validInput();
  donorOnly.proposed_truth.source_ref_ids = ["donor"];
  donorOnly.source_evidence.push(source(
    "donor",
    "donor_image",
    "e".repeat(64),
    ["outer_units", "identity", "package_facts"],
  ));
  const result = preflightWalmartAuditTruth(donorOnly);
  assert.equal(result.status, "TRUTH_REVIEW");
  assert(codes(result).has("DONOR_IMAGE_NOT_AUTHORITATIVE"));
  assert(codes(result).has("SOURCE_SCOPE_MISSING"));

  const legacy = validInput();
  legacy.proposed_truth.donor_image_url = "https://example.test/donor.jpg";
  assert.throws(() => parseTruthPreflightInput(legacy), /unsupported fields: donor_image_url/);
});

test("missing source references and missing proposed truths do not reach vision", () => {
  const input = validInput();
  input.current_title_source_ref_ids = [];
  input.proposed_truth.source_ref_ids = [];
  input.proposed_truth.identity = null;
  input.proposed_truth.package_facts = null;
  const result = preflightWalmartAuditTruth(input);
  assert.equal(result.status, "TRUTH_REVIEW");
  assert.equal(result.expected, null);
  assert(codes(result).has("MISSING_SOURCE_EVIDENCE"));
  assert(codes(result).has("IDENTITY_TRUTH_MISSING"));
  assert(codes(result).has("PACKAGE_FACTS_MISSING"));
});

test("parser requires exact keys, exact schema, and exact numeric item identity", () => {
  const extra = validInput();
  extra.untrusted_guess = true;
  assert.throws(() => parseTruthPreflightInput(extra), /unsupported fields: untrusted_guess/);

  const missing = validInput();
  delete missing.structured_record;
  assert.throws(() => parseTruthPreflightInput(missing), /missing required fields: structured_record/);

  const badItem = validInput();
  badItem.item_id = "items[0]";
  assert.throws(() => parseTruthPreflightInput(badItem), /item_id must contain digits only/);
});

test("coverage helper counts only AUDITABLE cases as vision eligible and counts reasons per case", () => {
  const auditable = preflightWalmartAuditTruth(validInput());
  const reviewInput = validInput();
  reviewInput.sku = "REVIEW-SKU";
  reviewInput.item_id = "222222222";
  reviewInput.proposed_truth.outer_units = 4;
  const review = preflightWalmartAuditTruth(reviewInput);
  const unsupportedInput = validInput();
  unsupportedInput.sku = "UNSUPPORTED-SKU";
  unsupportedInput.item_id = "333333333";
  unsupportedInput.listing_kind = "bundle";
  unsupportedInput.recipe.composition = "mixed_bundle";
  const unsupported = preflightWalmartAuditTruth(unsupportedInput);
  const coverage = summarizeTruthPreflightCoverage([auditable, review, unsupported]);
  assert.equal(coverage.schema_version, WALMART_TRUTH_PREFLIGHT_COVERAGE_SCHEMA);
  assert.deepEqual(coverage, {
    schema_version: WALMART_TRUTH_PREFLIGHT_COVERAGE_SCHEMA,
    total_cases: 3,
    auditable_cases: 1,
    truth_review_cases: 1,
    unsupported_cases: 1,
    vision_eligible_cases: 1,
    vision_blocked_cases: 2,
    reason_counts: {
      MIXED_BUNDLE_UNSUPPORTED: 1,
      OUTER_COUNT_DISAGREEMENT: 1,
    },
  });
  assert.throws(
    () => summarizeTruthPreflightCoverage([auditable, auditable]),
    /duplicate preflight result/,
  );
});
