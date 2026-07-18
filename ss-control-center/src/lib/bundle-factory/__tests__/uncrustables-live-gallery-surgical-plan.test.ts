// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-live-gallery-surgical-plan.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIVE_GALLERY_FIXED_CARD,
  buildLiveGallerySurgicalRowPlan,
  buildReplacementLiveGallery,
  validateLiveGalleryPlanSequence,
  type LiveGallerySkuConclusion,
  type LiveGalleryVisualAsset,
  type PlannedGalleryAsset,
} from "../repair/uncrustables-live-gallery-surgical-plan";

function digest(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function asset(
  sha256: string,
  classification: LiveGalleryVisualAsset["classification"],
  recipeKeys: string[],
  ordinal: number,
  policyIssues: string[] = [],
): LiveGalleryVisualAsset {
  return {
    sha256,
    exact_urls: [`https://m.media-amazon.com/images/I/test-${ordinal}.jpg`],
    local_path: `assets/${sha256}.jpg`,
    bytes: 100_000 + ordinal,
    format: "jpeg",
    width: 2000,
    height: 2000,
    classification,
    visual_subject: `${classification}:${recipeKeys.join("+")}`,
    source_primary_recipe_keys: recipeKeys,
    policy_issues: policyIssues,
    quality_warnings: [],
    mapping_count: 1,
    mappings: [
      {
        mapping_ordinal: ordinal,
        sku: `SKU-${ordinal}`,
        asin: `B000000${String(ordinal).padStart(3, "0")}`.slice(-10),
        slot: `GALLERY_${ordinal}`,
      },
    ],
  };
}

function fixedCard(): LiveGalleryVisualAsset {
  const fixed = asset(
    LIVE_GALLERY_FIXED_CARD.sha256,
    "KEEP_SHARED",
    ["A", "B"],
    1,
  );
  fixed.exact_urls = [LIVE_GALLERY_FIXED_CARD.url];
  fixed.visual_subject = "OWNER_APPROVED_FIXED_PRICE_THANK_YOU_COLD_CHAIN_CARD";
  return fixed;
}

function sharedFallback(): LiveGalleryVisualAsset {
  return asset(
    "09e96cd0c9e270c588d480e2232a5d69115f0b75748edfc5278873044831ef3e",
    "KEEP_SHARED",
    ["A", "B"],
    20,
  );
}

function componentAssets(key: string, start: number, count: number) {
  return Array.from({ length: count }, (_, index) =>
    asset(
      digest(start + index),
      "RECIPE_SPECIFIC_NEEDS_MAPPING",
      [key],
      index + 2,
    ),
  );
}

function row(
  recipeKeys: string[],
  current: LiveGallerySkuConclusion["secondary_assets"],
): LiveGallerySkuConclusion {
  return {
    ordinal: 1,
    sku: "TEST-SKU",
    asin: "B000000001",
    title: "Test",
    expected_total_units: 24,
    expected_total_source: "CANONICAL",
    recipe_keys: recipeKeys,
    recipe_components: [],
    secondary_image_count: current.length,
    product_image_count_excluding_approved_card: Math.max(0, current.length - 1),
    secondary_assets: current,
    conclusion: "KEEP",
    defects: [],
  };
}

test("replacement mix is exact, unique, and round-robin balanced", () => {
  const assets = [
    fixedCard(),
    sharedFallback(),
    ...componentAssets("A", 100, 4),
    ...componentAssets("B", 200, 4),
    // A visually ambiguous two-flavor creative cannot enter a component pool.
    asset(digest(300), "RECIPE_SPECIFIC_NEEDS_MAPPING", ["A", "B"], 2),
    // A policy-flagged exact flavor asset also cannot enter the pool.
    asset(digest(301), "RECIPE_SPECIFIC_NEEDS_MAPPING", ["A"], 2, ["BAD"]),
  ];
  const gallery = buildReplacementLiveGallery(["A", "B"], assets);
  assert.equal(gallery[0].sha256, LIVE_GALLERY_FIXED_CARD.sha256);
  assert.equal(gallery.length, 7);
  assert.deepEqual(
    gallery.slice(1).map((item) => item.component_key),
    ["A", "B", "A", "B", "A", "B"],
  );
  assert.equal(new Set(gallery.map((item) => item.sha256)).size, gallery.length);
  assert.equal(validateLiveGalleryPlanSequence(["A", "B"], gallery).pass, true);
});

test("single recipe with three exact assets gets one neutral audited fallback", () => {
  const gallery = buildReplacementLiveGallery(
    ["A"],
    [fixedCard(), sharedFallback(), ...componentAssets("A", 100, 3)],
  );
  assert.equal(gallery.length, 5);
  assert.deepEqual(
    gallery.map((item) => item.role),
    [
      "FIXED_PRICE_THANK_YOU_CARD",
      "EXACT_RECIPE_COMPONENT",
      "EXACT_RECIPE_COMPONENT",
      "EXACT_RECIPE_COMPONENT",
      "FLAVOR_NEUTRAL_SHARED_CONTEXT",
    ],
  );
});

test("strictly valid current gallery is kept without a write", () => {
  const assets = [fixedCard(), sharedFallback(), ...componentAssets("A", 100, 4)];
  const current = [fixedCard(), ...assets.slice(2)].map((entry, index) => ({
    slot: `GALLERY_${index + 1}`,
    url: entry.exact_urls[0],
    sha256: entry.sha256,
  }));
  const plan = buildLiveGallerySurgicalRowPlan(row(["A"], current), assets);
  assert.equal(plan.action, "KEEP");
  assert.equal(plan.write_required, false);
  assert.equal(plan.before.validation.pass, true);
  assert.deepEqual(
    plan.after.secondary_assets.map((entry) => entry.sha256),
    current.map((entry) => entry.sha256),
  );
});

test("multi-key creative on a single-flavor row is rebuilt", () => {
  const exact = componentAssets("A", 100, 4);
  const ambiguous = asset(
    digest(500),
    "RECIPE_SPECIFIC_NEEDS_MAPPING",
    ["A", "UNSOLD_B"],
    6,
  );
  const assets = [fixedCard(), sharedFallback(), ...exact, ambiguous];
  const currentAssets = [fixedCard(), exact[0], exact[1], exact[2], ambiguous].map(
    (entry, index) => ({
      slot: `GALLERY_${index + 1}`,
      url: entry.exact_urls[0],
      sha256: entry.sha256,
    }),
  );
  const plan = buildLiveGallerySurgicalRowPlan(row(["A"], currentAssets), assets);
  assert.equal(plan.action, "REBUILD_GALLERY");
  assert.ok(plan.reason_codes.includes("UNAPPROVED_SHARED_CONTEXT_ASSET"));
  assert.equal(plan.after.validation.pass, true);
  assert.ok(
    !plan.after.secondary_assets.some((entry) => entry.sha256 === ambiguous.sha256),
  );
});

test("validator fails a wrong slot-one card and a non-round-robin mix", () => {
  const badGallery: PlannedGalleryAsset[] = [
    {
      slot: "GALLERY_1",
      slot_index: 1,
      role: "EXACT_RECIPE_COMPONENT",
      component_index: 0,
      component_key: "A",
      represented_recipe_keys: ["A"],
      source_url: "https://m.media-amazon.com/images/I/a.jpg",
      sha256: digest(1),
      local_path: "a.jpg",
      bytes: 1,
      width: 2000,
      height: 2000,
      format: "jpeg",
      classification: "RECIPE_SPECIFIC_NEEDS_MAPPING",
      visual_subject: "A",
      policy_issues: [],
      quality_warnings: [],
    },
    ...componentAssets("A", 10, 3).map((entry, index) => ({
      ...({
        slot: `GALLERY_${index + 2}` as `GALLERY_${number}`,
        slot_index: index + 2,
        role: "EXACT_RECIPE_COMPONENT" as const,
        component_index: 0,
        component_key: "A",
        represented_recipe_keys: ["A"],
        source_url: entry.exact_urls[0],
        sha256: entry.sha256,
        local_path: entry.local_path,
        bytes: entry.bytes,
        width: entry.width,
        height: entry.height,
        format: entry.format,
        classification: entry.classification,
        visual_subject: entry.visual_subject,
        policy_issues: [],
        quality_warnings: [],
      }),
    })),
    {
      slot: "GALLERY_5",
      slot_index: 5,
      role: "EXACT_RECIPE_COMPONENT",
      component_index: 1,
      component_key: "B",
      represented_recipe_keys: ["B"],
      source_url: "https://m.media-amazon.com/images/I/b.jpg",
      sha256: digest(20),
      local_path: "b.jpg",
      bytes: 1,
      width: 2000,
      height: 2000,
      format: "jpeg",
      classification: "RECIPE_SPECIFIC_NEEDS_MAPPING",
      visual_subject: "B",
      policy_issues: [],
      quality_warnings: [],
    },
  ];
  const result = validateLiveGalleryPlanSequence(["A", "B"], badGallery);
  assert.equal(result.pass, false);
  assert.ok(result.errors.includes("FIXED_CARD_NOT_EXACT_GALLERY_1"));
  assert.ok(result.errors.includes("NOT_RECIPE_COMPONENT_ROUND_ROBIN"));
});

