// Per-rule unit tests for the Phase 2.0 Compliance Gate. Run with:
//   npx tsx --test src/lib/bundle-factory/compliance/__tests__/rules.test.ts
//
// Each rule has 3 cases — pass / fail / edge. Rule 6 (vision) is mocked
// via a flag in the input that the rule honours (`skip_image_check`);
// Rule 7 (permanent blocklist) is mocked via the Prisma client below so
// no DB connection is required.

import { test } from "node:test";
import assert from "node:assert/strict";

// ── Mock Prisma BEFORE importing rule-7 ────────────────────────────────
//
// Rule 7 calls `prisma.brandConflict.findMany`. We can't import the rule
// module first because it caches the prisma module reference; instead we
// stub a global require hook via the @/lib/prisma alias by registering
// the mock on globalThis. The rule reads from this same module via the
// alias, so we monkey-patch `prisma.brandConflict.findMany` directly
// after dynamic import.

import { prisma } from "@/lib/prisma";

import { ruleTitleForeignBrands } from "../rules/rule-1-title-foreign-brands";
import { ruleBrandField } from "../rules/rule-2-brand-field";
import { ruleDisclaimerBullets } from "../rules/rule-3-disclaimer-bullets";
import { ruleDisclaimerDescription } from "../rules/rule-4-disclaimer-description";
import { ruleBrowseNode } from "../rules/rule-5-browse-node";
import { ruleImageVisionCheck } from "../rules/rule-6-image-vision-check";
import { rulePermanentBlocklist } from "../rules/rule-7-permanent-blocklist";
import { rulePromotionalLanguage } from "../rules/rule-8-promotional-language";
import type { ComplianceInput } from "../types";

function baseInput(): ComplianceInput {
  return {
    title: "Salutem Vita Curated Gift Basket",
    brand: "Salutem Vita",
    bullets: [
      "Curated and assembled by Salutem Solutions LLC as a gift basket.",
      "Includes assorted shelf-stable snacks.",
    ],
    description:
      "Salutem Vita gift basket. " +
      "This gift basket is curated and assembled by Salutem Solutions LLC. " +
      "The included items are packaged by their original manufacturers.",
    browse_node: "12011207011",
    main_image_url: null,
    bundle_components: [{ brand: "Salutem Vita", product_name: "Snack mix" }],
    skip_image_check: true,
  };
}

// ── Rule 1: title foreign brands ───────────────────────────────────────

test("rule-1 — clean title passes", () => {
  const r = ruleTitleForeignBrands(baseInput());
  assert.equal(r.passed, true);
});

test("rule-1 — Kraft in title fails", () => {
  const input = baseInput();
  input.title = "Salutem Vita Kraft Mac & Cheese Gift Set";
  const r = ruleTitleForeignBrands(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "title_foreign_brand");
  const brands = (r.details as { foreign_brands_in_title: string[] })
    .foreign_brands_in_title;
  assert.ok(brands.includes("Kraft"));
});

test("rule-1 — Salutem in 'Salutem Vita' doesn't trigger Salutem own-brand false-positive", () => {
  const input = baseInput();
  input.title = "Salutem Vita Premium Curated Gift Basket";
  const r = ruleTitleForeignBrands(input);
  assert.equal(r.passed, true);
});

// ── Rule 2: brand field ────────────────────────────────────────────────

test("rule-2 — 'Salutem Vita' passes", () => {
  const r = ruleBrandField(baseInput());
  assert.equal(r.passed, true);
});

test("rule-2 — 'Kraft' fails", () => {
  const input = baseInput();
  input.brand = "Kraft";
  const r = ruleBrandField(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "brand_not_allowed");
});

test("rule-2 — empty brand fails with brand_field_empty", () => {
  const input = baseInput();
  input.brand = "";
  const r = ruleBrandField(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "brand_field_empty");
});

// ── Rule 3: disclaimer bullets ─────────────────────────────────────────

test("rule-3 — present passes", () => {
  const r = ruleDisclaimerBullets(baseInput());
  assert.equal(r.passed, true);
});

test("rule-3 — missing without autoFix fails", () => {
  const input = baseInput();
  input.bullets = ["Includes snack mix.", "Includes drink mix."];
  const r = ruleDisclaimerBullets(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "missing_disclaimer_bullet");
});

test("rule-3 — missing with autoFix appends disclaimer + marks applied", () => {
  const input = baseInput();
  input.bullets = ["Includes snack mix.", "Includes drink mix."];
  const r = ruleDisclaimerBullets(input, { autoFix: true });
  assert.equal(r.passed, true);
  assert.equal(r.auto_fix_applied, true);
  assert.equal(input.bullets.length, 3);
  // The appended bullet contains the disclaimer marker.
  assert.match(input.bullets[2], /curated and assembled by salutem/i);
});

// ── Rule 4: disclaimer description ─────────────────────────────────────

test("rule-4 — present passes", () => {
  const r = ruleDisclaimerDescription(baseInput());
  assert.equal(r.passed, true);
});

test("rule-4 — missing without autoFix fails", () => {
  const input = baseInput();
  input.description = "Just a plain description with no disclaimer text.";
  const r = ruleDisclaimerDescription(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "missing_disclaimer_description");
});

test("rule-4 — missing with autoFix appends paragraph", () => {
  const input = baseInput();
  input.description = "Plain description.";
  const r = ruleDisclaimerDescription(input, { autoFix: true });
  assert.equal(r.passed, true);
  assert.equal(r.auto_fix_applied, true);
  assert.match(input.description, /curated and assembled by salutem/i);
  // Separator preserved.
  assert.match(input.description, /Plain description\.\n\n/);
});

// ── Rule 5: browse node ────────────────────────────────────────────────

test("rule-5 — single-brand bundle passes regardless of node", () => {
  const input = baseInput();
  input.browse_node = "16310091"; // arbitrary non-exception node
  const r = ruleBrowseNode(input);
  assert.equal(r.passed, true);
});

test("rule-5 — multi-brand under exception node passes", () => {
  const input = baseInput();
  input.bundle_components = [
    { brand: "Salutem Vita" },
    { brand: "Hershey's" },
  ];
  input.browse_node = "12011207011";
  const r = ruleBrowseNode(input);
  assert.equal(r.passed, true);
});

test("rule-5 — multi-brand outside exception node fails", () => {
  const input = baseInput();
  input.bundle_components = [
    { brand: "Salutem Vita" },
    { brand: "Hershey's" },
  ];
  input.browse_node = "16310091";
  const r = ruleBrowseNode(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "multi_brand_wrong_category");
});

// ── Rule 6: image vision check ─────────────────────────────────────────

test("rule-6 — skip_image_check flag passes with details.skipped=true", async () => {
  const input = baseInput();
  input.skip_image_check = true;
  const r = await ruleImageVisionCheck(input);
  assert.equal(r.passed, true);
  assert.equal((r.details as { skipped?: boolean }).skipped, true);
});

test("rule-6 — no main_image_url passes with details.skipped=true", async () => {
  const input = baseInput();
  input.skip_image_check = false;
  input.main_image_url = null;
  const r = await ruleImageVisionCheck(input);
  assert.equal(r.passed, true);
  assert.equal((r.details as { skipped?: boolean }).skipped, true);
});

test("rule-6 — vision error fail-CLOSED (passed=false)", async (t) => {
  // Force the vision call to error by feeding an URL when no ANTHROPIC_API_KEY
  // is set — the underlying function returns { error: "ANTHROPIC_API_KEY not set" }.
  const hadKey = !!process.env.ANTHROPIC_API_KEY;
  if (hadKey) {
    t.skip("ANTHROPIC_API_KEY is set; skip the error-path test");
    return;
  }
  const input = baseInput();
  input.skip_image_check = false;
  input.main_image_url = "https://example.com/img.jpg";
  const r = await ruleImageVisionCheck(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "image_vision_error");
});

// ── Rule 7: permanent blocklist ────────────────────────────────────────

test("rule-7 — no matches passes", async () => {
  // Stub findMany to return empty.
  const orig = prisma.brandConflict.findMany;
  (prisma.brandConflict as { findMany: unknown }).findMany = async () => [];
  try {
    const r = await rulePermanentBlocklist(baseInput());
    assert.equal(r.passed, true);
  } finally {
    (prisma.brandConflict as { findMany: unknown }).findMany = orig;
  }
});

test("rule-7 — Kraft + spongebob match fails", async () => {
  const orig = prisma.brandConflict.findMany;
  (prisma.brandConflict as { findMany: unknown }).findMany = async () => [
    {
      id: "c1",
      asin: "B0FBML98G3",
      foreign_brand: "Kraft",
      product_keywords: JSON.stringify([
        "spongebob mac & cheese",
        "spongebob shapes",
      ]),
      incident_date: new Date("2026-05-17"),
    },
  ];
  try {
    const input = baseInput();
    input.title = "Salutem Vita Kraft Spongebob Mac & Cheese Gift Set";
    const r = await rulePermanentBlocklist(input);
    assert.equal(r.passed, false);
    assert.equal(r.reason, "permanent_blocklist_match");
    const matches = (r.details as { matches: unknown[] }).matches;
    assert.equal(matches.length, 1);
  } finally {
    (prisma.brandConflict as { findMany: unknown }).findMany = orig;
  }
});

test("rule-7 — brand without keyword match passes (avoids over-firing)", async () => {
  const orig = prisma.brandConflict.findMany;
  (prisma.brandConflict as { findMany: unknown }).findMany = async () => [
    {
      id: "c1",
      asin: "B0FBML98G3",
      foreign_brand: "Kraft",
      product_keywords: JSON.stringify(["spongebob mac & cheese"]),
      incident_date: new Date("2026-05-17"),
    },
  ];
  try {
    const input = baseInput();
    // Brand word in title via a coincidence, but no keyword match.
    input.title = "Salutem Vita Artisan Kraft Paper Gift Set";
    const r = await rulePermanentBlocklist(input);
    assert.equal(r.passed, true);
  } finally {
    (prisma.brandConflict as { findMany: unknown }).findMany = orig;
  }
});

// ── Rule 8: promotional / health language ──────────────────────────────

test("rule-8 — clean text passes", () => {
  const r = rulePromotionalLanguage(baseInput());
  assert.equal(r.passed, true);
});

test("rule-8 — 'ultimate' in title fails with promotional_language", () => {
  const input = baseInput();
  input.title = "Salutem Vita Ultimate Gift Basket";
  const r = rulePromotionalLanguage(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "promotional_language");
});

// Amazon 99300 has two halves: promotional adjectives AND sale/shipping claims.
// "sold and shipped frozen" in a bullet was empirically confirmed (2026-07-09)
// to make SP-API VALIDATION_PREVIEW return 99300; dropping just that phrase
// flipped the listing to VALID.
test("rule-8 — 'sold and shipped' bullet fails with sale_shipping_claims", () => {
  const input = baseInput();
  input.bullets = [
    "Contains 30 individually wrapped sandwiches, 2.8 oz each, sold and shipped frozen.",
  ];
  const r = rulePromotionalLanguage(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "sale_shipping_claims");
  assert.ok(
    (r.details as { sale_shipping_claims: string[] }).sale_shipping_claims.some(
      (s) => /sold and shipped/i.test(s),
    ),
  );
});

test("rule-8 — inflected frozen-delivery claims fail closed", () => {
  for (const claim of [
    "The sandwiches are shipped frozen.",
    "The sandwiches are delivered frozen.",
    "The sandwiches arrive frozen.",
  ]) {
    const input = baseInput();
    input.bullets = [claim, "Keep frozen until ready to thaw."];
    const r = rulePromotionalLanguage(input);
    assert.equal(r.passed, false, claim);
    assert.equal(r.reason, "sale_shipping_claims", claim);
  }
});

test("rule-8 — 'Ships frozen' and 'limited time' are caught too", () => {
  for (const bad of [
    "Ships frozen in an insulated cooler.",
    "Available for a limited time only.",
  ]) {
    const input = baseInput();
    input.bullets = [bad];
    assert.equal(rulePromotionalLanguage(input).passed, false, bad);
  }
});

test("rule-8 — 'Keep frozen' storage instruction still passes", () => {
  const input = baseInput();
  input.bullets = ["Keep frozen until ready to eat. Do not refreeze."];
  assert.equal(rulePromotionalLanguage(input).passed, true);
});

test("rule-8 — health claim 'boost immune' fails", () => {
  const input = baseInput();
  input.description = input.description + " Boost immune health daily.";
  const r = rulePromotionalLanguage(input);
  assert.equal(r.passed, false);
  // Both promotional ('boost') and health ('immune') tripped — combined reason.
  assert.ok(
    r.reason === "promotional_and_health_claims" ||
      r.reason === "health_claim_language" ||
      r.reason === "promotional_language",
  );
});

// ── Own-brand passthrough (Uncrustables carve-out) ──────────────────────
//
// When `own_brand` is true the listing publishes UNDER the donor's own brand
// (Smucker's), not Salutem. Rules 1/2/3/4 branch: the donor brand is allowed
// in the title + as the brand field, and NO curator disclaimer is required.

function ownBrandInput(): ComplianceInput {
  return {
    title: "Smucker's Uncrustables Peanut Butter and Grape Jelly Sandwich, 10 Count",
    brand: "Smucker's",
    bullets: [
      "Includes 10 frozen peanut butter and grape jelly sandwiches.",
      "Thaw 30 to 60 minutes before serving.",
    ],
    description:
      "Smucker's Uncrustables frozen sandwiches. Keep frozen until ready to eat.",
    browse_node: "12011207011",
    main_image_url: null,
    bundle_components: [
      { brand: "Smucker's", product_name: "Uncrustables PB&J" },
    ],
    skip_image_check: true,
    own_brand: true,
  };
}

test("rule-1 own-brand — own donor brand in title passes", () => {
  const r = ruleTitleForeignBrands(ownBrandInput());
  assert.equal(r.passed, true);
});

test("rule-1 own-brand — a DIFFERENT foreign brand in title still fails", () => {
  const input = ownBrandInput();
  input.title = "Smucker's Uncrustables with Kraft Cheese, 10 Count";
  const r = ruleTitleForeignBrands(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "title_foreign_brand");
  const brands = (r.details as { foreign_brands_in_title: string[] })
    .foreign_brands_in_title;
  assert.ok(brands.includes("Kraft"));
  // The listing's own brand is NOT reported as a violation.
  assert.ok(!brands.some((b) => /smucker|uncrustable/i.test(b)));
});

test("rule-2 own-brand — donor brand is an allowed brand field", () => {
  const r = ruleBrandField(ownBrandInput());
  assert.equal(r.passed, true);
});

test("rule-2 own-brand — empty brand still fails even in own-brand mode", () => {
  const input = ownBrandInput();
  input.brand = "";
  const r = ruleBrandField(input);
  assert.equal(r.passed, false);
  assert.equal(r.reason, "brand_field_empty");
});

test("rule-3 own-brand — no disclaimer bullet required (passes without it)", () => {
  const input = ownBrandInput();
  const r = ruleDisclaimerBullets(input);
  assert.equal(r.passed, true);
});

test("rule-3 own-brand — autoFix does NOT inject a gift-set disclaimer", () => {
  const input = ownBrandInput();
  const before = input.bullets.length;
  const r = ruleDisclaimerBullets(input, { autoFix: true });
  assert.equal(r.passed, true);
  assert.notEqual(r.auto_fix_applied, true);
  assert.equal(input.bullets.length, before);
});

test("rule-4 own-brand — no disclaimer description required (passes without it)", () => {
  const r = ruleDisclaimerDescription(ownBrandInput());
  assert.equal(r.passed, true);
});

// ── Rule 6 vision — own-brand logo must survive (Smucker's/Uncrustables) ──
//
// The frozen hero for an own-brand Uncrustables listing legitimately shows the
// REAL product logo. The vision model reports both "Uncrustables" and the
// parent "Smucker's" mark; both must be allowed (else the gate blocks and the
// retry strips the genuine logo off the box). This tests the filter Rule 6 uses.

import { filterRealLogos } from "../../audit/vision-check";
import { OWN_BRAND_PASSTHROUGH_BRANDS } from "../../own-brand";

test("filterRealLogos — own-brand allowlist clears Smucker's AND Uncrustables", () => {
  const allowed = ["Uncrustables", ...OWN_BRAND_PASSTHROUGH_BRANDS];
  const out = filterRealLogos(["Smucker's", "Uncrustables"], allowed);
  assert.equal(out.length, 0);
});

test("filterRealLogos — a truly foreign logo still flags in own-brand mode", () => {
  const allowed = ["Uncrustables", ...OWN_BRAND_PASSTHROUGH_BRANDS];
  const out = filterRealLogos(["Smucker's", "Kraft"], allowed);
  assert.deepEqual(out, ["Kraft"]);
});

test("filterRealLogos — WITHOUT the parent mark allowed, Smucker's flags (regression)", () => {
  // The bug: allowedBrands had only the component brand "Uncrustables", so the
  // vision-detected "Smucker's" was treated as foreign and stripped.
  const out = filterRealLogos(["Smucker's"], ["Uncrustables"]);
  assert.deepEqual(out, ["Smucker's"]);
});
