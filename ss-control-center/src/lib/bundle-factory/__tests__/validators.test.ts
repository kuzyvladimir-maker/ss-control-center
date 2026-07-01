// Phase 2.4 Stage 6 — pure-function unit tests for validators that
// don't hit the DB / external APIs. The DB-touching ones
// (compliance-rerun, inventory, upc-format pool/uniqueness, image-format
// HEAD) are exercised by scripts/smoke-validation-pipeline.ts against a
// throwaway fixture.
//
// Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/validators.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChannelSKU } from "@/generated/prisma/client";
import type { ValidatorInput } from "@/lib/bundle-factory/validation/types";
import { validatorTitle } from "@/lib/bundle-factory/validation/validators/validator-title";
import { validatorBullets } from "@/lib/bundle-factory/validation/validators/validator-bullets";
import { validatorDescription } from "@/lib/bundle-factory/validation/validators/validator-description";
import { validatorBrandField } from "@/lib/bundle-factory/validation/validators/validator-brand-field";
import { validatorAmazonBrowseNode } from "@/lib/bundle-factory/validation/validators/validator-amazon-browse-node";
import { validatorWalmartItemType } from "@/lib/bundle-factory/validation/validators/validator-walmart-item-type";
import { validatorSkuPattern } from "@/lib/bundle-factory/validation/validators/validator-sku-pattern";
import { validatorPackagingDims } from "@/lib/bundle-factory/validation/validators/validator-packaging-dims";
import { validatorWeight } from "@/lib/bundle-factory/validation/validators/validator-weight";
import { validatorCountryOfOrigin } from "@/lib/bundle-factory/validation/validators/validator-country-of-origin";
import { validatorImageDimensions } from "@/lib/bundle-factory/validation/validators/validator-image-dimensions";
import { validatorImageFormat } from "@/lib/bundle-factory/validation/validators/validator-image-format";
import { validatorMarginFloor } from "@/lib/bundle-factory/validation/validators/validator-margin-floor";

// ── Fixture builder ─────────────────────────────────────────────────────

function mkSku(overrides: Partial<ChannelSKU> = {}): ChannelSKU {
  const now = new Date();
  return {
    id: "sku_test",
    master_bundle_id: "mb_test",
    channel: "AMAZON_SALUTEM",
    brand_account_id: null,
    sku: "SV-AS01-A1B2",
    upc: "012345678905",
    upc_pool_id: null,
    asin: null,
    walmart_item_id: null,
    ebay_item_id: null,
    tiktok_product_id: null,
    title: "Salutem Vita Curated Refrigerated Lunch Variety Gift Basket Pack of 9",
    bullets: JSON.stringify([
      "Includes nine single-serve refrigerated lunch trays in original retail packaging.",
      "Refrigerator-stable until the printed use-by date on each tray.",
      "Curated and assembled by Salutem Solutions LLC as a gift basket.",
    ]),
    description:
      "Variety pack of nine single-serve lunches in retail packaging.\n\nCurated and assembled by Salutem Solutions LLC.",
    search_terms: null,
    attributes: "{}",
    channel_category: null,
    channel_browse_node: "12011207011", // gift basket exception node
    price_cents: 0,
    business_price_cents: null,
    lifecycle_status: "DRAFT",
    submitted_at: null,
    processing_at: null,
    live_at: null,
    live_url: null,
    last_error_at: null,
    errors: null,
    units_sold_30d: 0,
    revenue_30d_cents: 0,
    compliance_status: "CAN_PUBLISH",
    compliance_check_id: null,
    compliance_blocked_at: null,
    compliance_blocked_reasons: null,
    main_image_url: "https://example.com/img.png",
    validation_status: "PENDING",
    validation_errors: null,
    validated_at: null,
    validation_check_id: null,
    validation_attempt_count: 0,
    package_length_in: 12,
    package_width_in: 8,
    package_height_in: 6,
    package_weight_oz: 32,
    country_of_origin: "US",
    item_type: null,
    // Phase 2.5 distribution fields (default PENDING — fixture-friendly)
    listing_status: "PENDING",
    submission_id: null,
    published_at: null,
    distribution_errors: null,
    distribution_attempt_count: 0,
    last_status_check_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function mkInput(sku: ChannelSKU): ValidatorInput {
  return {
    sku,
    master_bundle: {
      id: "mb_test",
      brand: "Salutem Vita",
      category: "REFRIGERATED",
      packaging_spec: "{}",
      total_weight_oz: 32,
      main_image_url: "https://example.com/img.png",
      estimated_cost_cents: 1200,
    },
    bundle_components: [
      { product_name: "Cheez-It Original", manufacturer_brand: "Cheez-It", manufacturer_upc: "024100109838", qty: 3 },
    ],
    draft_brand: "Salutem Vita",
    margin_floor_pct: 0.2,
  };
}

// ── validator-title ───────────────────────────────────────────────────

test("validator-title passes clean Amazon title", async () => {
  const out = await validatorTitle(mkInput(mkSku()));
  assert.equal(out.passed, true);
});

test("validator-title fails on empty", async () => {
  const out = await validatorTitle(mkInput(mkSku({ title: "" })));
  assert.equal(out.passed, false);
  assert.equal(out.severity, "error");
});

test("validator-title fails over 200 chars on Amazon", async () => {
  const out = await validatorTitle(mkInput(mkSku({ title: "X".repeat(201) })));
  assert.equal(out.passed, false);
  assert.match(out.message ?? "", /201 chars/);
});

test("validator-title catches foreign brand", async () => {
  const out = await validatorTitle(
    mkInput(mkSku({ title: "Lunchables Variety Pack of 9 by Salutem Vita" })),
  );
  assert.equal(out.passed, false);
  assert.match(out.message ?? "", /Lunchables/i);
});

// ── validator-bullets ─────────────────────────────────────────────────

test("validator-bullets passes clean bullets", async () => {
  const out = await validatorBullets(mkInput(mkSku()));
  assert.equal(out.passed, true);
});

test("validator-bullets fails on emoji", async () => {
  const out = await validatorBullets(
    mkInput(
      mkSku({
        bullets: JSON.stringify(["Includes 9 trays 🎉", "Curated and assembled by Salutem Solutions LLC."]),
      }),
    ),
  );
  assert.equal(out.passed, false);
  assert.match(out.message ?? "", /emoji/);
});

test("validator-bullets fails on overlong bullet (Amazon 500)", async () => {
  const out = await validatorBullets(
    mkInput(
      mkSku({
        bullets: JSON.stringify(["A".repeat(501), "Curated and assembled by Salutem Solutions LLC."]),
      }),
    ),
  );
  assert.equal(out.passed, false);
  assert.match(out.message ?? "", /501 chars/);
});

test("validator-bullets fails on >5 bullets for Walmart", async () => {
  const out = await validatorBullets(
    mkInput(
      mkSku({
        channel: "WALMART",
        bullets: JSON.stringify(["a", "b", "c", "d", "e", "f"]),
      }),
    ),
  );
  assert.equal(out.passed, false);
  assert.match(out.message ?? "", /6 items/);
});

// ── validator-description ─────────────────────────────────────────────

test("validator-description passes plain text", async () => {
  const out = await validatorDescription(mkInput(mkSku()));
  assert.equal(out.passed, true);
});

test("validator-description rejects HTML", async () => {
  const out = await validatorDescription(
    mkInput(mkSku({ description: "<p>Variety pack</p>" })),
  );
  assert.equal(out.passed, false);
  assert.match(out.message ?? "", /HTML/i);
});

test("validator-description rejects empty", async () => {
  const out = await validatorDescription(mkInput(mkSku({ description: "" })));
  assert.equal(out.passed, false);
});

// ── validator-brand-field ─────────────────────────────────────────────

test("validator-brand-field passes Salutem Vita", async () => {
  const out = await validatorBrandField(mkInput(mkSku()));
  assert.equal(out.passed, true);
});

test("validator-brand-field rejects foreign brand on MasterBundle.brand", async () => {
  const input = mkInput(mkSku());
  input.master_bundle = { ...input.master_bundle!, brand: "Kraft" };
  const out = await validatorBrandField(input);
  assert.equal(out.passed, false);
});

test("validator-brand-field reports missing master bundle", async () => {
  const input = mkInput(mkSku());
  input.master_bundle = null;
  const out = await validatorBrandField(input);
  assert.equal(out.passed, false);
  assert.match(out.message ?? "", /MasterBundle/);
});

// ── own-brand passthrough (Uncrustables) across the validation layer ───

test("validator-brand-field passes own-brand donor brand (Uncrustables)", async () => {
  const input = mkInput(mkSku());
  input.master_bundle = { ...input.master_bundle!, brand: "Uncrustables" };
  const out = await validatorBrandField(input);
  assert.equal(out.passed, true);
});

test("validator-title allows the own donor brand in title (own-brand mode)", async () => {
  const input = mkInput(
    mkSku({ title: "Uncrustables Chocolate Hazelnut Frozen Sandwich, 18 oz, Pack of 6" }),
  );
  input.master_bundle = { ...input.master_bundle!, brand: "Uncrustables" };
  const out = await validatorTitle(input);
  assert.equal(out.passed, true);
});

test("validator-title still fails a DIFFERENT foreign brand in own-brand mode", async () => {
  const input = mkInput(
    mkSku({ title: "Uncrustables with Kraft Cheese, Pack of 6" }),
  );
  input.master_bundle = { ...input.master_bundle!, brand: "Uncrustables" };
  const out = await validatorTitle(input);
  assert.equal(out.passed, false);
  assert.match(out.message ?? "", /Kraft/i);
});

// ── validator-amazon-browse-node ──────────────────────────────────────

test("validator-amazon-browse-node skips non-Amazon", async () => {
  const out = await validatorAmazonBrowseNode(
    mkInput(mkSku({ channel: "WALMART", channel_browse_node: null })),
  );
  assert.equal(out.passed, true);
  assert.equal(out.details?.skipped, true);
});

test("validator-amazon-browse-node fails multi-brand without exception node", async () => {
  const input = mkInput(
    mkSku({ channel: "AMAZON_SALUTEM", channel_browse_node: "1234567" }),
  );
  input.bundle_components = [
    { product_name: "A", manufacturer_brand: "Kraft", manufacturer_upc: null, qty: 1 },
    { product_name: "B", manufacturer_brand: "Hormel", manufacturer_upc: null, qty: 1 },
  ];
  const out = await validatorAmazonBrowseNode(input);
  assert.equal(out.passed, false);
  assert.match(out.message ?? "", /Gift Basket Exception/);
});

test("validator-amazon-browse-node passes multi-brand WITH exception node", async () => {
  const input = mkInput(
    mkSku({ channel: "AMAZON_SALUTEM", channel_browse_node: "12011207011" }),
  );
  input.bundle_components = [
    { product_name: "A", manufacturer_brand: "Kraft", manufacturer_upc: null, qty: 1 },
    { product_name: "B", manufacturer_brand: "Hormel", manufacturer_upc: null, qty: 1 },
  ];
  const out = await validatorAmazonBrowseNode(input);
  assert.equal(out.passed, true);
});

// ── validator-walmart-item-type ───────────────────────────────────────

test("validator-walmart-item-type skips non-Walmart", async () => {
  const out = await validatorWalmartItemType(
    mkInput(mkSku({ channel: "AMAZON_SALUTEM", item_type: null })),
  );
  assert.equal(out.passed, true);
});

test("validator-walmart-item-type rejects empty on Walmart", async () => {
  const out = await validatorWalmartItemType(
    mkInput(mkSku({ channel: "WALMART", item_type: null })),
  );
  assert.equal(out.passed, false);
});

test("validator-walmart-item-type accepts valid taxonomy", async () => {
  const out = await validatorWalmartItemType(
    mkInput(mkSku({ channel: "WALMART", item_type: "Refrigerated Lunches" })),
  );
  assert.equal(out.passed, true);
});

// ── validator-sku-pattern ─────────────────────────────────────────────

test("validator-sku-pattern accepts canonical SKU", async () => {
  const out = await validatorSkuPattern(mkInput(mkSku({ sku: "SV-AS01-A1B2" })));
  assert.equal(out.passed, true);
});

test("validator-sku-pattern rejects malformed", async () => {
  const out = await validatorSkuPattern(mkInput(mkSku({ sku: "bad-sku" })));
  assert.equal(out.passed, false);
});

// ── validator-packaging-dims ──────────────────────────────────────────

test("validator-packaging-dims passes with all dims set", async () => {
  const out = await validatorPackagingDims(mkInput(mkSku()));
  assert.equal(out.passed, true);
});

test("validator-packaging-dims fails on missing length", async () => {
  const out = await validatorPackagingDims(
    mkInput(mkSku({ package_length_in: null })),
  );
  assert.equal(out.passed, false);
});

test("validator-packaging-dims warns on oversized", async () => {
  const out = await validatorPackagingDims(
    mkInput(mkSku({ package_length_in: 150 })),
  );
  assert.equal(out.passed, false);
  assert.equal(out.severity, "warning");
});

// ── validator-weight ──────────────────────────────────────────────────

test("validator-weight passes positive weight", async () => {
  const out = await validatorWeight(mkInput(mkSku()));
  assert.equal(out.passed, true);
});

test("validator-weight fails on missing", async () => {
  const out = await validatorWeight(mkInput(mkSku({ package_weight_oz: null })));
  assert.equal(out.passed, false);
});

// ── validator-country-of-origin ──────────────────────────────────────

test("validator-country-of-origin passes US", async () => {
  const out = await validatorCountryOfOrigin(mkInput(mkSku()));
  assert.equal(out.passed, true);
});

test("validator-country-of-origin fails on empty", async () => {
  const out = await validatorCountryOfOrigin(
    mkInput(mkSku({ country_of_origin: null })),
  );
  assert.equal(out.passed, false);
});

test("validator-country-of-origin warns on non-canonical", async () => {
  const out = await validatorCountryOfOrigin(
    mkInput(mkSku({ country_of_origin: "Atlantis" })),
  );
  assert.equal(out.passed, false);
  assert.equal(out.severity, "warning");
});

// ── validator-image-dimensions — header byte parsing ─────────────────

// Hand-crafted PNG: 89 50 4E 47 0D 0A 1A 0A | IHDR (offset 8): length
// (00 00 00 0D) + type "IHDR" + width(4) + height(4) + …
function buildPngWithDims(w: number, h: number): string {
  const buf = Buffer.alloc(24);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, 4, "binary");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

test("validator-image-dimensions passes 2000×2000 PNG on Amazon", async () => {
  const out = await validatorImageDimensions(
    mkInput(mkSku({ main_image_url: buildPngWithDims(2000, 2000) })),
  );
  assert.equal(out.passed, true);
});

test("validator-image-dimensions fails 800×800 PNG on Amazon", async () => {
  const out = await validatorImageDimensions(
    mkInput(mkSku({ main_image_url: buildPngWithDims(800, 800) })),
  );
  assert.equal(out.passed, false);
  assert.equal(out.severity, "error");
});

test("validator-image-dimensions warns on unmeasurable URL", async () => {
  // 'data:' URL with garbage payload — parsePngDims + parseJpegDims
  // both return null → warning.
  const out = await validatorImageDimensions(
    mkInput(mkSku({ main_image_url: "data:image/png;base64,garbage===" })),
  );
  assert.equal(out.passed, false);
  assert.equal(out.severity, "warning");
});

// ── validator-image-format — dataURL inspection path ─────────────────

test("validator-image-format accepts data:image/png", async () => {
  const out = await validatorImageFormat(
    mkInput(mkSku({ main_image_url: buildPngWithDims(1024, 1024) })),
  );
  assert.equal(out.passed, true);
});

test("validator-image-format rejects data:image/webp", async () => {
  const out = await validatorImageFormat(
    mkInput(mkSku({ main_image_url: "data:image/webp;base64,xx==" })),
  );
  assert.equal(out.passed, false);
  assert.equal(out.severity, "error");
});

test("validator-image-format fails on missing URL", async () => {
  const out = await validatorImageFormat(
    mkInput(mkSku({ main_image_url: null })),
  );
  assert.equal(out.passed, false);
});

// ── validator-margin-floor (Phase 7) ────────────────────────────────────

test("validator-margin-floor warns when price not set (awaiting economics)", async () => {
  // mkSku defaults price_cents to 0 → price not yet provided by economics.
  const out = await validatorMarginFloor(mkInput(mkSku()));
  assert.equal(out.passed, false);
  assert.equal(out.severity, "warning");
});

test("validator-margin-floor warns when COGS basis unknown", async () => {
  const input = mkInput(mkSku({ price_cents: 1500 }));
  input.master_bundle = { ...input.master_bundle!, estimated_cost_cents: null };
  const out = await validatorMarginFloor(input);
  assert.equal(out.passed, false);
  assert.equal(out.severity, "warning");
});

test("validator-margin-floor errors when margin below 20%", async () => {
  // price $14.00 vs COGS $12.00 → 14.3% margin < 20% floor.
  const input = mkInput(mkSku({ price_cents: 1400 }));
  input.master_bundle = { ...input.master_bundle!, estimated_cost_cents: 1200 };
  const out = await validatorMarginFloor(input);
  assert.equal(out.passed, false);
  assert.equal(out.severity, "error");
});

test("validator-margin-floor passes at exactly 20% margin", async () => {
  // price $15.00 vs COGS $12.00 → exactly 20% margin → at the floor.
  const input = mkInput(mkSku({ price_cents: 1500 }));
  input.master_bundle = { ...input.master_bundle!, estimated_cost_cents: 1200 };
  const out = await validatorMarginFloor(input);
  assert.equal(out.passed, true);
});

test("validator-margin-floor floor is a variable (10% floor passes 14.3% margin)", async () => {
  // Same $14.00/$12.00 (14.3% margin) that FAILS at the 20% default now PASSES
  // when the per-run floor is lowered to 10% — proves the floor is a variable.
  const input = mkInput(mkSku({ price_cents: 1400 }));
  input.master_bundle = { ...input.master_bundle!, estimated_cost_cents: 1200 };
  input.margin_floor_pct = 0.1;
  const out = await validatorMarginFloor(input);
  assert.equal(out.passed, true);
});
