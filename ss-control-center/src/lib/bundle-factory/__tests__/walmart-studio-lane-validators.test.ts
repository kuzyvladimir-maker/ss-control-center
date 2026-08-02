import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "@/lib/sourcing/canonical-product-match-provenance";
import type { ChannelSKU } from "@/generated/prisma/client";
import type { ValidatorInput } from "@/lib/bundle-factory/validation/types";
import {
  WALMART_STUDIO_LISTING_ATTRIBUTE_KEY,
  WALMART_STUDIO_LISTING_EVIDENCE_SCHEMA,
  WALMART_STUDIO_LISTING_LANE,
} from "@/lib/bundle-factory/walmart-studio-listing";
import { validatorInventory } from "@/lib/bundle-factory/validation/validators/validator-inventory";
import { validatorWalmartItemType } from "@/lib/bundle-factory/validation/validators/validator-walmart-item-type";
import { validatorWalmartPrepublication } from "@/lib/bundle-factory/validation/validators/validator-walmart-prepublication";
import { validatorWalmartProductTruth } from "@/lib/bundle-factory/validation/validators/validator-walmart-product-truth";

const MAIN_IMAGE_URL = "https://pub-6394.r2.dev/walmart-new-sku/draft-main/main.png";

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
}

function studioEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: WALMART_STUDIO_LISTING_EVIDENCE_SCHEMA,
    lane: WALMART_STUDIO_LISTING_LANE,
    listing_scope: {
      channel: "WALMART",
      store_index: 1,
      sku: "CM-WM04-AB12",
      pack_count: 8,
    },
    verified_at: hoursAgo(1),
    identity: {
      canonical_variant_id: "cpv1:f44ab538",
      variant_decision_id: "dpvd:91ea2030",
      donor_product_id: "925b3e13",
      matcher_version: CANONICAL_PRODUCT_MATCHER_VERSION,
      matcher_implementation_sha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
      matcher_release_sha256: CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    },
    content: {
      role: "EXACT",
      observation_id: "pco:6bab6d4a",
      source_url: "https://www.walmart.com/ip/10321387",
      captured_at: hoursAgo(500),
    },
    price: {
      eligibility: "FACT",
      observation_id: "doo:185ef269",
      donor_offer_id: "do:walmart:10321387",
      retailer: "walmart",
      observed_at: hoursAgo(6),
      locality_evidence: "zip_scoped",
      zip: "33765",
      price_per_unit: 2.26,
    },
    images: [{
      role: "MAIN",
      url: MAIN_IMAGE_URL,
      output_sha256: "b".repeat(64),
      source_asset_sha256s: ["a".repeat(64)],
      represented_unit_count: 8,
      construction_method: "DETERMINISTIC_EXACT_PIXEL_MULTIPACK",
      exact_source_url: "https://i5.walmartimages.com/seo/campbells.jpeg",
      generative_model_used: false,
      added_graphics_or_text_overlay: false,
    }],
    ...overrides,
  };
}

function input(overrides: {
  evidence?: Record<string, unknown> | null;
  itemType?: string;
} = {}): ValidatorInput {
  const attributes: Record<string, unknown> = {
    listing_lane: WALMART_STUDIO_LISTING_LANE,
  };
  if (overrides.evidence !== null) {
    attributes[WALMART_STUDIO_LISTING_ATTRIBUTE_KEY] =
      overrides.evidence ?? studioEvidence();
  }
  const sku = {
    id: "channel-sku-studio",
    sku: "CM-WM04-AB12",
    channel: "WALMART",
    title: "Campbell's Chunky Soup … (Pack of 8)",
    bullets: JSON.stringify(["Includes 8 identical retail packages"]),
    description: "Eight identical retail packages.",
    attributes: JSON.stringify(attributes),
    main_image_url: MAIN_IMAGE_URL,
    item_type: overrides.itemType ?? "Prepared & Packaged Soups",
    country_of_origin: "US",
    price_cents: 5158,
    upc: "756441906004",
  } as unknown as ChannelSKU;
  return {
    sku,
    master_bundle: {
      id: "master-studio",
      brand: "campbells",
      category: "SHELF_STABLE",
      packaging_spec: "{}",
      cost_breakdown: "{}",
      pack_count: 8,
      suggested_price_cents: 5158,
      total_weight_oz: 173,
      main_image_url: MAIN_IMAGE_URL,
      estimated_cost_cents: 1808,
    },
    bundle_components: [{
      product_name: "Campbell's Chunky Soup, 18.8 oz Can",
      manufacturer_brand: "campbells",
      manufacturer_upc: "051000128423",
      flavor: "baked potato with steak and cheese",
      qty: 8,
      ingredients: "Water, Potatoes, Beef Stock…",
    }],
    draft_brand: "campbells",
    margin_floor_pct: 0.3,
  };
}

test("the studio lane passes the truth gate on its own evidence", async () => {
  const result = await validatorWalmartProductTruth(input());
  assert.equal(result.passed, true, result.message);
  assert.equal(result.details?.lane, "WALMART_STUDIO_DRAFT");
});

test("a studio SKU without evidence cannot pass", async () => {
  const result = await validatorWalmartProductTruth(input({ evidence: null }));
  assert.equal(result.passed, false);
  assert.match(String(result.message), /no walmart_studio_listing evidence/);
});

test("a main image that shows the wrong unit count is rejected", async () => {
  // This is the defect class that put wrong-product tiles live; the studio
  // lane must catch it even though it skips the pilot attestation bundle.
  const evidence = studioEvidence();
  (evidence.images as Array<Record<string, unknown>>)[0].represented_unit_count = 6;
  const result = await validatorWalmartProductTruth(input({ evidence }));
  assert.equal(result.passed, false);
  assert.match(String(result.message), /MAIN represents 6 units/);
});

test("a superseded matcher release invalidates the identity", async () => {
  const evidence = studioEvidence();
  (evidence.identity as Record<string, unknown>).matcher_release_sha256 = "0".repeat(64);
  const result = await validatorWalmartProductTruth(input({ evidence }));
  assert.equal(result.passed, false);
  assert.match(String(result.message), /superseded matcher release/);
});

test("price evidence older than the owner's 90-day window fails", async () => {
  const evidence = studioEvidence();
  (evidence.price as Record<string, unknown>).observed_at = hoursAgo(24 * 120);
  const result = await validatorWalmartProductTruth(input({ evidence }));
  assert.equal(result.passed, false);
  assert.match(String(result.message), /older than 90 days/);
});

test("a 60-day-old catalogue price is still usable", async () => {
  // Owner 2026-08-02: a price under three months old is good enough; a few
  // cents of drift is not worth re-buying the observation.
  const evidence = studioEvidence();
  (evidence.price as Record<string, unknown>).observed_at = hoursAgo(24 * 60);
  const result = await validatorWalmartProductTruth(input({ evidence }));
  assert.equal(result.passed, true, result.message);
});

test("the frozen pilot's attestation gate does not run on the studio lane", async () => {
  const result = await validatorWalmartPrepublication(input());
  assert.equal(result.passed, true);
  assert.equal(result.details?.skipped, true);
  assert.equal(result.details?.reason, "walmart_studio_lane");
});

test("item type must be one Walmart's live taxonomy actually lists", async () => {
  const good = await validatorWalmartItemType(input());
  assert.equal(good.passed, true, good.message);
  assert.equal(good.details?.source, "walmart_live_taxonomy");

  const bad = await validatorWalmartItemType(input({ itemType: "Canned Soup" }));
  assert.equal(bad.passed, false);
  assert.match(String(bad.message), /taxonomy-verified studio list/);
});

test("Walmart inventory is declared, not read from Veeqo", async () => {
  // Buy-to-order: there is no warehouse to read. Reaching Veeqo here would
  // fail closed on a stock level that describes nothing we sell.
  const result = await validatorInventory(input());
  assert.equal(result.passed, true);
  assert.equal(result.details?.bundle_available_quantity, 50);
  assert.equal(result.details?.veeqo_checked, false);
});
