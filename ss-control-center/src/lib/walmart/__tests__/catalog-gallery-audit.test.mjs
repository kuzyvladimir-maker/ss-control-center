import { test } from "node:test";
import assert from "node:assert/strict";

import sharp from "sharp";

import {
  auditGallerySlot,
  detectGalleryDuplicates,
  fingerprintGalleryImage,
  galleryDhashDistance,
} from "../catalog-gallery-audit.ts";

const expected = {
  title: "Bigelow Peppermint Herbal Tea, 8 Count, 20 oz (Pack of 2)",
  outer_units: 2,
  identity: {
    brand_aliases: ["bigelow"],
    product_marker_groups: [["herbal tea", "tea"]],
    variant_marker_groups: [["peppermint"]],
    forbidden_markers: [
      { role: "variant", aliases: ["diet", "earl grey"] },
      { role: "product", aliases: ["coffee"] },
    ],
  },
  package_facts: [
    { kind: "net_content", value: 20, unit: "oz", requirement: "if_visible" },
    { kind: "inner_item_count", value: 8, unit: "count", requirement: "if_visible" },
  ],
  truth_source: "manual_verified",
};

function observation(overrides = {}) {
  return {
    image_id: "i_gallery",
    visual_role: "lifestyle",
    visible_brand_text: "Bigelow",
    visible_product_text: "Herbal Tea",
    visible_variant_text: "Peppermint",
    visible_size_texts: [],
    external_package_count: { mode: "exact", value: 99, min: null, max: null },
    outer_package_claims: [],
    inner_contents_claims: [],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "multi_package_case",
    front_visibility: "none",
    background: "lifestyle",
    multiple_distinct_products: "no",
    readable_identity: "clear",
    evidence: ["Bigelow", "Herbal Tea", "Peppermint"],
    flags: [],
    ...overrides,
  };
}

function observedInput(overrides = {}, auxiliary_ocr) {
  return {
    slot: "gallery-2",
    expected,
    source: {
      state: "observed",
      observation: observation(overrides),
      ...(auxiliary_ocr ? { auxiliary_ocr } : {}),
    },
  };
}

test("correct lifestyle ignores all main-image count, grid, front, and background rules", () => {
  const decision = auditGallerySlot(observedInput());
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.checks.identity, "MATCH");
  assert.equal(decision.checks.package_facts.net_content, "NOT_VISIBLE");
  assert.deepEqual(decision.hard_failures, []);
});

test("correct back and nutrition gallery observations pass with or without visible package facts", () => {
  const back = auditGallerySlot(observedInput({
    visual_role: "back",
    background: "colored",
    visible_size_texts: [],
  }));
  assert.equal(back.verdict, "PASS");
  assert.equal(back.checks.package_facts.net_content, "NOT_VISIBLE");

  const nutrition = auditGallerySlot(observedInput({
    visual_role: "nutrition",
    visible_size_texts: ["NET WT 20 OZ", "8 COUNT"],
    inner_contents_claims: ["8 COUNT"],
    background: "mixed",
  }));
  assert.equal(nutrition.verdict, "PASS");
  assert.equal(nutrition.checks.package_facts.net_content, "MATCH");
  assert.equal(nutrition.checks.package_facts.inner_item_count, "MATCH");
});

test("a nutrition panel without enough product identity is REVIEW", () => {
  const decision = auditGallerySlot(observedInput({
    visual_role: "nutrition",
    visible_brand_text: null,
    visible_product_text: null,
    visible_variant_text: null,
    readable_identity: "none",
    evidence: ["Nutrition Facts"],
  }));
  assert.equal(decision.verdict, "REVIEW");
  assert.equal(decision.checks.identity, "UNKNOWN");
  assert.match(decision.review_reasons.join(" "), /brand evidence missing/);
});

test("synthetic injected foreign brand, product, and variant are each BAD", () => {
  const adversarial = [
    ["brand", { visible_brand_text: "Twinings" }],
    ["product", { visible_product_text: "Ground Coffee" }],
    ["variant", { visible_variant_text: "Earl Grey" }],
  ];
  for (const [role, injected] of adversarial) {
    const decision = auditGallerySlot(observedInput(injected));
    assert.equal(decision.verdict, "BAD", role);
    assert.equal(decision.checks.identity, "MISMATCH", role);
    assert.match(decision.hard_failures.join(" "), new RegExp(role), role);
  }
});

test("forbidden markers are role scoped and blind evidence cannot be erased by OCR", () => {
  const allowedRole = auditGallerySlot(observedInput({
    visible_product_text: "Diet Herbal Tea",
    visible_variant_text: "Peppermint",
  }));
  assert.equal(allowedRole.verdict, "PASS");

  const forbiddenRole = auditGallerySlot(observedInput({
    visible_variant_text: "Diet Peppermint",
  }, {
    ocr_texts: [{ text: "BIGELOW PEPPERMINT", confidence: 1 }],
  }));
  assert.equal(forbiddenRole.verdict, "BAD");
  assert.match(forbiddenRole.hard_failures.join(" "), /variant:diet/);
});

test("only blind package contradiction can be BAD; OCR-only mismatch is REVIEW", () => {
  const blindMismatch = auditGallerySlot(observedInput({
    visible_size_texts: ["NET WT 12 OZ"],
  }));
  assert.equal(blindMismatch.verdict, "BAD");
  assert.equal(blindMismatch.checks.package_facts.net_content, "MISMATCH");

  const ocrMismatch = auditGallerySlot(observedInput({}, {
    ocr_texts: [{ text: "NET WT 12 OZ", confidence: 1 }],
  }));
  assert.equal(ocrMismatch.verdict, "REVIEW");
  assert.equal(ocrMismatch.checks.package_facts.net_content, "UNKNOWN");
  assert.match(ocrMismatch.review_reasons.join(" "), /OCR-only mismatch/);

  const conflict = auditGallerySlot(observedInput({
    visible_size_texts: ["NET WT 20 OZ"],
  }, {
    ocr_texts: [{ text: "NET WT 12 OZ", confidence: 1 }],
  }));
  assert.equal(conflict.verdict, "REVIEW");
  assert.match(conflict.review_reasons.join(" "), /vision and OCR conflict/);
});

test("mixed bundles fail closed without explicit components and match an explicit component", () => {
  const unsupported = auditGallerySlot({
    ...observedInput(),
    composition: { kind: "mixed_component_bundle" },
  });
  assert.equal(unsupported.verdict, "UNSUPPORTED");

  const explicit = auditGallerySlot({
    ...observedInput({
      visible_brand_text: "Twinings",
      visible_product_text: "Black Tea",
      visible_variant_text: "Earl Grey",
    }),
    composition: {
      kind: "mixed_component_bundle",
      component_identities: [
        { component_id: "peppermint", identity: expected.identity },
        {
          component_id: "earl-grey",
          identity: {
            brand_aliases: ["twinings"],
            product_marker_groups: [["black tea", "tea"]],
            variant_marker_groups: [["earl grey"]],
            forbidden_markers: [],
          },
        },
      ],
    },
  });
  assert.equal(explicit.verdict, "PASS");
  assert.equal(explicit.matched_component_id, "earl-grey");
});

test("missing and technical image states remain separate from visual verdicts", () => {
  const missing = auditGallerySlot({
    slot: "gallery-1",
    expected,
    source: { state: "missing", reason: "PDP has no slot 1" },
  });
  const technical = auditGallerySlot({
    slot: "gallery-2",
    expected,
    source: { state: "technical_error", error: "decoder timeout" },
  });
  assert.equal(missing.verdict, "MISSING");
  assert.equal(missing.missing_reason, "PDP has no slot 1");
  assert.equal(missing.technical_error, null);
  assert.equal(technical.verdict, "TECH_ERROR");
  assert.equal(technical.technical_error, "decoder timeout");
  assert.equal(technical.missing_reason, null);
});

async function syntheticGradient(reverse = false, oneBitChange = false) {
  const pixels = new Uint8Array(9 * 8);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      pixels[row * 9 + column] = reverse ? (8 - column) * 20 : column * 20;
    }
  }
  if (oneBitChange) pixels[7] = 110;
  return sharp(pixels, { raw: { width: 9, height: 8, channels: 1 } }).png().toBuffer();
}

test("SHA-256 exact and dHash near duplicates are deterministic and separately reported", async () => {
  const base = await syntheticGradient();
  const exactCopy = Buffer.from(base);
  const near = await syntheticGradient(false, true);
  const far = await syntheticGradient(true);

  const baseFingerprint = await fingerprintGalleryImage("gallery-1", base);
  const nearFingerprint = await fingerprintGalleryImage("gallery-3", near);
  const farFingerprint = await fingerprintGalleryImage("gallery-4", far);
  assert.equal(galleryDhashDistance(baseFingerprint.dhash64, nearFingerprint.dhash64), 1);
  assert.equal(galleryDhashDistance(baseFingerprint.dhash64, farFingerprint.dhash64), 64);

  const report = await detectGalleryDuplicates([
    { slot: "gallery-8", state: "technical_error", error: "fetch failed" },
    { slot: "gallery-4", state: "available", bytes: far },
    { slot: "gallery-2", state: "available", bytes: exactCopy },
    { slot: "gallery-7", state: "missing", reason: "not published" },
    { slot: "gallery-6", state: "available", bytes: Buffer.from("not-an-image") },
    { slot: "gallery-3", state: "available", bytes: near },
    { slot: "gallery-1", state: "available", bytes: base },
  ], 5);

  assert.deepEqual(report.fingerprints.map((row) => row.slot), [
    "gallery-1", "gallery-2", "gallery-3", "gallery-4",
  ]);
  assert.equal(report.exact_duplicates.length, 1);
  assert.deepEqual(report.exact_duplicates[0].slots, ["gallery-1", "gallery-2"]);
  assert.deepEqual(report.near_duplicates, [
    { left_slot: "gallery-1", right_slot: "gallery-3", hamming_distance: 1 },
    { left_slot: "gallery-2", right_slot: "gallery-3", hamming_distance: 1 },
  ]);
  assert.deepEqual(report.missing, [{ slot: "gallery-7", reason: "not published" }]);
  assert.equal(report.technical_errors.length, 2);
  assert.deepEqual(report.technical_errors.map((row) => [row.slot, row.stage]), [
    ["gallery-6", "decode"],
    ["gallery-8", "input"],
  ]);
  assert.match(report.technical_errors[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.technical_errors[1].sha256, null);
});
