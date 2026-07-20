import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLIND_OBSERVATION_SCHEMA,
  WALMART_VISUAL_AUDIT_SCHEMA,
  WALMART_VISUAL_COMPARATOR_VERSION,
  buildBlindObservationPrompt,
  decideBlind,
  parseBlindResponse,
  parseVisibleSizeText,
  parseVisibleSizeTexts,
  shuffledWithSeed,
  validateAuditManifest,
} from "../catalog-visual-audit.ts";

const image = {
  slot: "main",
  url: "https://example.com/main.png",
  buyer_facing_verified: false,
  surface: "last_applied_artifact",
};

const teaCase = {
  case_id: "tea-pass",
  sku: "SKU-1",
  expected: {
    title: "Bigelow Peppermint Tea, 20 Count (Pack of 2)",
    outer_units: 2,
    identity: {
      brand_aliases: ["bigelow"],
      product_marker_groups: [["tea", "herbal tea"]],
      variant_marker_groups: [["peppermint"]],
      forbidden_markers: [],
    },
    package_facts: [
      { kind: "inner_item_count", value: 20, unit: "count", requirement: "required" },
      { kind: "net_content", value: 0.91, unit: "oz", requirement: "if_visible" },
    ],
    truth_source: "manual_verified",
  },
  images: [image],
};

function observation(overrides = {}) {
  return {
    image_id: "i_test",
    visual_role: "tiled_main",
    visible_brand_text: "Bigelow",
    visible_product_text: "Herbal Tea",
    visible_variant_text: "Peppermint",
    visible_size_texts: ["20 tea bags", "0.91 oz"],
    external_package_count: { mode: "exact", value: 2, min: null, max: null },
    outer_package_claims: [],
    inner_contents_claims: ["20 tea bags"],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "single_sellable_package",
    front_visibility: "all",
    background: "white",
    multiple_distinct_products: "no",
    readable_identity: "clear",
    evidence: ["Bigelow", "Peppermint", "20 tea bags"],
    flags: [],
    ...overrides,
  };
}

function caseWith(expectedOverrides) {
  return {
    ...teaCase,
    expected: {
      ...teaCase.expected,
      ...expectedOverrides,
    },
  };
}

function spatialOcr(text, boundingBox, confidence = 1) {
  return {
    text,
    confidence,
    view_role: "full",
    view_sha256: "a".repeat(64),
    bounding_box: boundingBox,
  };
}

function bunCase(netRequirement = "if_visible") {
  return caseWith({
    title: "Sara Lee Artesano Bakery Buns, 8 Count, 19 oz (Pack of 2)",
    identity: {
      brand_aliases: ["sara lee"],
      product_marker_groups: [["bakery buns", "buns"]],
      variant_marker_groups: [["artesano"]],
      forbidden_markers: [
        { role: "product", aliases: ["sliced bread"] },
      ],
    },
    package_facts: [
      { kind: "net_content", value: 19, unit: "oz", requirement: netRequirement },
      { kind: "inner_item_count", value: 8, unit: "count", requirement: "required" },
    ],
  });
}

function bunObservation(overrides = {}) {
  return observation({
    visible_brand_text: "Sara Lee",
    visible_product_text: "Bakery Buns",
    visible_variant_text: "Artesano",
    visible_size_texts: ["NET WT 19 OZ (538 g)", "8 COUNT"],
    inner_contents_claims: ["8 COUNT"],
    ...overrides,
  });
}

test("v3 manifest validation accepts typed truth and rejects ambiguous v2 fields", () => {
  const manifest = {
    schema_version: WALMART_VISUAL_AUDIT_SCHEMA,
    manifest_id: "test-v3",
    purpose: "golden-pilot",
    cases: [teaCase],
    layouts: [{ name: "single", batch_size: 1, shuffle_seed: null }],
  };
  assert.equal(validateAuditManifest(manifest).schema_version, "walmart-visual-audit/v3");
  assert.throws(
    () => validateAuditManifest({ ...manifest, schema_version: "walmart-visual-audit/v2" }),
    /schema_version must be walmart-visual-audit\/v3/,
  );
  const legacyCase = {
    ...teaCase,
    expected: {
      title: teaCase.expected.title,
      outer_units: 2,
      unit_size: { value: 20, unit: "count" },
      required_identity_markers: [["bigelow"], ["tea"]],
      forbidden_identity_markers: [],
      truth_source: "manual_verified",
    },
  };
  assert.throws(() => validateAuditManifest({ ...manifest, cases: [legacyCase] }), /unsupported fields/);
});

test("manifest validation enforces role and package-fact semantics", () => {
  const base = {
    schema_version: WALMART_VISUAL_AUDIT_SCHEMA,
    manifest_id: "strict-v3",
    purpose: "golden-pilot",
    cases: [teaCase],
    layouts: [{ name: "single", batch_size: 1, shuffle_seed: null }],
  };
  const badRole = structuredClone(teaCase);
  badRole.expected.identity.forbidden_markers = [{ role: "any", aliases: ["diet"] }];
  assert.throws(() => validateAuditManifest({ ...base, cases: [badRole] }), /role is unsupported/);
  const badFact = structuredClone(teaCase);
  badFact.expected.package_facts = [
    { kind: "inner_item_count", value: 8.5, unit: "count", requirement: "required" },
  ];
  assert.throws(() => validateAuditManifest({ ...base, cases: [badFact] }), /positive integer count/);
  const logoAlias = structuredClone(teaCase);
  logoAlias.expected.identity.brand_aliases = ["G"];
  assert.throws(() => validateAuditManifest({ ...base, cases: [logoAlias] }), /full lexical brand names/);
});

test("strict blind schema requires every opaque image id exactly once", () => {
  const row = observation();
  const raw = { schema_version: BLIND_OBSERVATION_SCHEMA, observations: [row] };
  assert.deepEqual(parseBlindResponse(raw, ["i_test"]), [row]);
  assert.throws(() => parseBlindResponse(raw, ["i_other"]), /every supplied image_id/);
  assert.throws(
    () => parseBlindResponse({ ...raw, unexpected: true }, ["i_test"]),
    /unsupported fields/,
  );
});

test("strict blind schema enforces external-count invariants", () => {
  const bad = observation({
    external_package_count: { mode: "exact", value: 2, min: 1, max: null },
  });
  assert.throws(
    () => parseBlindResponse({ schema_version: BLIND_OBSERVATION_SCHEMA, observations: [bad] }, ["i_test"]),
    /exact invariant failed/,
  );
});

test("typed identity and package facts can auto-pass", () => {
  const decision = decideBlind(teaCase, image, observation());
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.checks.identity, "MATCH");
  assert.equal(decision.checks.package_facts.inner_item_count, "MATCH");
  assert.equal(decision.checks.package_facts.net_content, "MATCH");
});

test("an explicitly empty product-marker list supports brand-equals-product truth", () => {
  const drPepperCase = caseWith({
    identity: {
      brand_aliases: ["dr pepper"],
      product_marker_groups: [],
      variant_marker_groups: [],
      forbidden_markers: [
        { role: "variant", aliases: ["diet", "zero"] },
      ],
    },
  });
  const decision = decideBlind(drPepperCase, image, observation({
    visible_brand_text: "Dr Pepper",
    visible_product_text: "Soda",
    visible_variant_text: null,
  }));
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.checks.identity, "MATCH");
});

test("logo-only brand is REVIEW, never an inferred brand match", () => {
  const gatoradeCase = caseWith({
    title: "Gatorade Cool Blue Sports Drink, 28 Fl Oz Bottle, Quantity of 6",
    outer_units: 6,
    identity: {
      brand_aliases: ["gatorade"],
      product_marker_groups: [["advanced rehydration", "sports drink"]],
      variant_marker_groups: [["cool blue"]],
      forbidden_markers: [
        { role: "product", aliases: ["zero"] },
        { role: "variant", aliases: ["glacier cherry"] },
      ],
    },
    package_facts: [
      { kind: "net_content", value: 28, unit: "fl_oz", requirement: "if_visible" },
    ],
  });
  const decision = decideBlind(gatoradeCase, image, observation({
    visible_brand_text: "G",
    visible_product_text: "Advanced Rehydration",
    visible_variant_text: "Cool Blue",
    visible_size_texts: [],
    inner_contents_claims: [],
    external_package_count: { mode: "exact", value: 6, min: null, max: null },
  }));
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.identity, "UNKNOWN");
  assert.deepEqual(decision.hard_failures, []);
});

test("OCR can recover a logo wordmark only after blind product and variant match", () => {
  const gatoradeCase = caseWith({
    title: "Gatorade Cool Blue Sports Drink, 28 Fl Oz Bottle, Quantity of 6",
    outer_units: 6,
    identity: {
      brand_aliases: ["gatorade"],
      product_marker_groups: [["advanced rehydration", "sports drink"]],
      variant_marker_groups: [["cool blue"]],
      forbidden_markers: [
        { role: "product", aliases: ["zero"] },
        { role: "variant", aliases: ["glacier cherry"] },
      ],
    },
    package_facts: [
      { kind: "net_content", value: 28, unit: "fl_oz", requirement: "if_visible" },
    ],
  });
  const decision = decideBlind(gatoradeCase, image, observation({
    visible_brand_text: "G",
    visible_product_text: "Advanced Rehydration",
    visible_variant_text: "COOL BLUE",
    visible_size_texts: [],
    inner_contents_claims: [],
    external_package_count: { mode: "exact", value: 6, min: null, max: null },
    readable_identity: "partial",
  }), {
    ocr_texts: [
      { text: "GATORADE", confidence: 1 },
    ],
  });
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.checks.identity, "MATCH");
});

test("only spatially adjacent OCR badge words can support a multiword allowed marker", () => {
  const familyCase = caseWith({
    identity: {
      ...teaCase.expected.identity,
      variant_marker_groups: [["family size"]],
    },
  });
  const decision = decideBlind(familyCase, image, observation({
    visible_variant_text: null,
  }), {
    ocr_texts: [
      spatialOcr("FAMILY", { x: 0.1, y: 0.1, width: 0.1, height: 0.08 }),
      spatialOcr("20", { x: 0.8, y: 0.8, width: 0.05, height: 0.03 }),
      spatialOcr("SIZE", { x: 0.1, y: 0.185, width: 0.1, height: 0.03 }),
    ],
  });
  assert.equal(decision.verdict, "PASS");

  const unlocated = decideBlind(familyCase, image, observation({
    visible_variant_text: null,
  }), {
    ocr_texts: [
      { text: "FAMILY", confidence: 1 },
      { text: "SIZE", confidence: 1 },
    ],
  });
  assert.equal(unlocated.verdict, "REVIEW");
  assert.match(unlocated.unknowns.join(" "), /required variant markers missing/);
});

test("OCR cannot be the sole source of product identity", () => {
  const decision = decideBlind(teaCase, image, observation({
    visible_brand_text: null,
    visible_product_text: null,
    visible_variant_text: null,
    readable_identity: "none",
  }), {
    ocr_texts: [
      { text: "BIGELOW", confidence: 1 },
      { text: "HERBAL TEA", confidence: 1 },
      { text: "PEPPERMINT", confidence: 1 },
    ],
  });
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.identity, "UNKNOWN");
});

test("an explicit wrong brand is BAD", () => {
  const decision = decideBlind(teaCase, image, observation({
    visible_brand_text: "Twinings",
  }));
  assert.equal(decision.verdict, "BAD");
  assert.equal(decision.checks.identity, "MISMATCH");
  assert.match(decision.hard_failures.join(" "), /visible brand is not an allowed alias: Twinings/);
});

test("allowed-brand OCR conflicting with an explicit blind wrong brand yields REVIEW", () => {
  const decision = decideBlind(teaCase, image, observation({
    visible_brand_text: "Twinings",
  }), {
    ocr_texts: [{ text: "BIGELOW", confidence: 1 }],
  });
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.identity, "UNKNOWN");
  assert.deepEqual(decision.hard_failures, []);
  assert.match(decision.unknowns.join(" "), /blind vision and OCR conflict for identity/);
});

test("a visible role-scoped forbidden marker is BAD", () => {
  const regularCase = caseWith({
    identity: {
      brand_aliases: ["dr pepper"],
      product_marker_groups: [["soda"]],
      variant_marker_groups: [],
      forbidden_markers: [{ role: "variant", aliases: ["diet", "zero"] }],
    },
  });
  const decision = decideBlind(regularCase, image, observation({
    visible_brand_text: "Dr Pepper",
    visible_product_text: "Soda",
    visible_variant_text: "Diet",
    readable_identity: "partial",
  }));
  assert.equal(decision.verdict, "BAD");
  assert.match(decision.hard_failures.join(" "), /variant:diet\|zero/);
});

test("a blind forbidden marker remains BAD when vision assigns it to the wrong identity field", () => {
  const guardedTea = caseWith({
    identity: {
      ...teaCase.expected.identity,
      forbidden_markers: [{ role: "variant", aliases: ["chamomile"] }],
    },
  });
  const decision = decideBlind(guardedTea, image, observation({
    visible_product_text: "Herbal Tea Chamomile",
    visible_variant_text: null,
  }), {
    ocr_texts: [{ text: "PEPPERMINT", confidence: 1 }],
  });
  assert.equal(decision.verdict, "BAD");
  assert.equal(decision.checks.identity, "MISMATCH");
  assert.match(decision.hard_failures.join(" "), /variant:chamomile/);
});

test("OCR-only forbidden text forces REVIEW and cannot create BAD", () => {
  const guardedTea = caseWith({
    identity: {
      ...teaCase.expected.identity,
      forbidden_markers: [{ role: "variant", aliases: ["chamomile"] }],
    },
  });
  const decision = decideBlind(guardedTea, image, observation(), {
    ocr_texts: [{ text: "CHAMOMILE", confidence: 1 }],
  });
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.identity, "UNKNOWN");
  assert.deepEqual(decision.hard_failures, []);
  assert.match(decision.unknowns.join(" "), /OCR-only forbidden identity markers/);
});

test("OCR-supported generic identity cannot erase a visible forbidden marker", () => {
  const guardedTea = caseWith({
    identity: {
      ...teaCase.expected.identity,
      forbidden_markers: [{ role: "variant", aliases: ["chamomile"] }],
    },
  });
  const decision = decideBlind(guardedTea, image, observation({
    visible_variant_text: "Chamomile",
  }), {
    ocr_texts: [{ text: "PEPPERMINT", confidence: 1 }],
  });
  assert.equal(decision.verdict, "BAD");
  assert.equal(decision.checks.identity, "MISMATCH");
  assert.match(decision.hard_failures.join(" "), /forbidden identity markers visible/);
});

test("a required product or variant marker missing is REVIEW, not BAD", () => {
  const decision = decideBlind(teaCase, image, observation({
    visible_product_text: "Tea",
    visible_variant_text: "Caffeine Free",
  }));
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.identity, "UNKNOWN");
  assert.deepEqual(decision.hard_failures, []);
  assert.match(decision.unknowns.join(" "), /required variant markers missing: peppermint/);
});

test("8 count and 19 oz are independent facts and both can match", () => {
  const decision = decideBlind(bunCase(), image, bunObservation());
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.checks.package_facts.net_content, "MATCH");
  assert.equal(decision.checks.package_facts.inner_item_count, "MATCH");
});

test("a hidden if_visible package fact does not block PASS", () => {
  const decision = decideBlind(bunCase("if_visible"), image, bunObservation({
    visible_size_texts: ["8 COUNT"],
  }));
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.checks.package_facts.net_content, "NOT_APPLICABLE");
  assert.equal(decision.checks.package_facts.inner_item_count, "MATCH");
});

test("a hidden required package fact produces REVIEW", () => {
  const decision = decideBlind(bunCase("required"), image, bunObservation({
    visible_size_texts: ["8 COUNT"],
  }));
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.package_facts.net_content, "UNKNOWN");
  assert.match(decision.unknowns.join(" "), /required package fact net_content is not visible/);
});

test("conflicting same-fact sizes produce REVIEW", () => {
  const decision = decideBlind(bunCase(), image, bunObservation({
    visible_size_texts: ["19 OZ", "20 OZ", "8 COUNT"],
  }));
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.package_facts.net_content, "UNKNOWN");
  assert.match(decision.unknowns.join(" "), /conflicting net_content values/);
});

test("blind-vision package mismatch is BAD", () => {
  const decision = decideBlind(bunCase(), image, bunObservation({
    visible_size_texts: ["20 OZ", "8 COUNT"],
  }));
  assert.equal(decision.verdict, "BAD");
  assert.equal(decision.checks.package_facts.net_content, "MISMATCH");
});

test("high-confidence OCR can support a required package fact match", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const decision = decideBlind(breadCase, image, observation({
    visible_size_texts: [],
    inner_contents_claims: [],
  }), {
    ocr_texts: [{ text: "NET WT 22 OZ (1 LB 6 OZ) 624g", confidence: 1 }],
  });
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.checks.package_facts.net_content, "MATCH");
});

test("an OCR expected size mixed with a conflicting package size forces REVIEW", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const decision = decideBlind(breadCase, image, observation({
    visible_size_texts: [],
    inner_contents_claims: [],
  }), {
    ocr_texts: [
      { text: "NET WT 22 OZ (624g)", confidence: 1 },
      { text: "NET WT 24 OZ", confidence: 1 },
    ],
  });
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.package_facts.net_content, "UNKNOWN");
  assert.match(decision.unknowns.join(" "), /conflicting OCR values/);
});

test("OCR-only mismatch can produce only REVIEW", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const decision = decideBlind(breadCase, image, observation({
    visible_size_texts: [],
    inner_contents_claims: [],
  }), {
    ocr_texts: [{ text: "NET WT 24 OZ", confidence: 1 }],
  });
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.package_facts.net_content, "UNKNOWN");
  assert.deepEqual(decision.hard_failures, []);
  assert.match(decision.unknowns.join(" "), /OCR-only mismatch/);
});

test("blind vision and OCR disagreement produces REVIEW", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const decision = decideBlind(breadCase, image, observation({
    visible_size_texts: ["22 OZ"],
    inner_contents_claims: [],
  }), {
    ocr_texts: [{ text: "NET WT 24 OZ", confidence: 1 }],
  });
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.package_facts.net_content, "UNKNOWN");
  assert.match(decision.unknowns.join(" "), /blind vision and OCR conflict/);
});

test("OCR cannot mask an independently corroborated blind mismatch", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const decision = decideBlind(breadCase, image, observation({
    visible_size_texts: ["24 OZ"],
    inner_contents_claims: [],
  }), {
    ocr_texts: [{ text: "NET WT 24 OZ", confidence: 1 }],
  });
  assert.equal(decision.verdict, "BAD");
  assert.equal(decision.checks.package_facts.net_content, "MISMATCH");
  assert.match(decision.hard_failures.join(" "), /blind vision contradicts net_content/);
});

test("noisy conflicting OCR cannot erase a blind package mismatch", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const decision = decideBlind(breadCase, image, observation({
    visible_size_texts: ["24 OZ"],
    inner_contents_claims: [],
  }), {
    ocr_texts: [
      { text: "WET WT 24 OZ (680g)", confidence: 1 },
      { text: "48g", confidence: 1 },
    ],
  });
  assert.equal(decision.verdict, "BAD");
  assert.equal(decision.checks.package_facts.net_content, "MISMATCH");
});

test("low-confidence OCR is ignored", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const decision = decideBlind(breadCase, image, observation({
    visible_size_texts: [],
    inner_contents_claims: [],
  }), {
    ocr_texts: [{ text: "NET WT 22 OZ", confidence: 0.94 }],
  });
  assert.equal(decision.verdict, "REVIEW");
  assert.match(decision.unknowns.join(" "), /required package fact net_content is not visible/);
});

test("all sizes in a literal are parsed, compound pounds are aggregated, and duplicates are removed", () => {
  assert.deepEqual(
    parseVisibleSizeTexts("NET WT 22 OZ (1 LB 6 OZ) 624 g; 20 count; 22 oz"),
    [
      { value: 22, unit: "oz" },
      { value: 624, unit: "g" },
      { value: 20, unit: "count" },
    ],
  );
  assert.deepEqual(parseVisibleSizeText("64 fl_oz (2 L)"), { value: 64, unit: "fl_oz" });
  assert.deepEqual(parseVisibleSizeText("240Z11 5 LBS 680g"), { value: 24, unit: "oz" });
  assert.deepEqual(parseVisibleSizeText("NET WT 22.0Z (624g)"), { value: 22, unit: "oz" });
  assert.equal(parseVisibleSizeText("10z"), null);
});

test("same-unit values are exact while cross-unit rounding tolerance is at most 0.5%", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const exactUnitMismatch = decideBlind(breadCase, image, observation({
    visible_size_texts: ["22.0001 OZ"],
    inner_contents_claims: [],
  }));
  assert.equal(exactUnitMismatch.verdict, "BAD");
  const exactHalfPercentBoundary = 22 * 28.349523125 * 1.005;
  const roundedMetricMatch = decideBlind(breadCase, image, observation({
    visible_size_texts: [`${exactHalfPercentBoundary} g`],
    inner_contents_claims: [],
  }));
  assert.equal(roundedMetricMatch.verdict, "PASS");
  const outsideTolerance = decideBlind(breadCase, image, observation({
    visible_size_texts: [`${exactHalfPercentBoundary + 0.001} g`],
    inner_contents_claims: [],
  }));
  assert.equal(outsideTolerance.verdict, "BAD");
});

test("nutrition grams cannot become a package-size contradiction", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const decision = decideBlind(breadCase, image, observation({
    visible_size_texts: ["6g Protein", "4g Fiber", "27g Whole Grains"],
    inner_contents_claims: [],
  }));
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.package_facts.net_content, "UNKNOWN");
  assert.deepEqual(decision.hard_failures, []);
});

test("OCR-split small nutrition grams cannot conflict with a real net weight", () => {
  const breadCase = caseWith({
    package_facts: [
      { kind: "net_content", value: 22, unit: "oz", requirement: "required" },
    ],
  });
  const decision = decideBlind(breadCase, image, observation({
    visible_size_texts: [],
    inner_contents_claims: [],
  }), {
    ocr_texts: [
      { text: "NET WT 22 OZ (624g)", confidence: 1 },
      { text: "6g", confidence: 1 },
      { text: "4g", confidence: 1 },
      { text: "27g", confidence: 1 },
    ],
  });
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.checks.package_facts.net_content, "MATCH");
});

test("blind prompt and observation schema remain independent of comparator v4", () => {
  const prompt = buildBlindObservationPrompt(["i_a", "i_b"]);
  assert.equal(BLIND_OBSERVATION_SCHEMA, "wm_visual_observation_batch/v3");
  assert.equal(WALMART_VISUAL_COMPARATOR_VERSION, "walmart-visual-comparator/v4");
  assert.match(prompt, /i_a/);
  assert.match(prompt, /inner_contents_claims/);
  assert.doesNotMatch(prompt, /Bigelow|SKU-1|Peppermint/);
});

test("seeded shuffle is reproducible and seed-sensitive", () => {
  const input = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(shuffledWithSeed(input, 42), shuffledWithSeed(input, 42));
  assert.notDeepEqual(shuffledWithSeed(input, 42), shuffledWithSeed(input, 43));
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6]);
});
