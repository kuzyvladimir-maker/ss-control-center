import assert from "node:assert/strict";
import test from "node:test";

import { buildWalmartNewSkuOwnerPreviewGallery } from
  "../walmart-new-sku-owner-preview";

test("owner preview emits two deterministic non-publishable Walmart projections", () => {
  const input = {
    generatedAt: "2026-07-23T18:00:00.000Z",
    sourcePlanPath: "/tmp/plan.json",
    sourcePlanSha256: "a".repeat(64),
    donorProductId: "donor-1",
    canonicalVariantId: `cpv1:${"b".repeat(64)}`,
    manufacturerUpc: "044000035457",
    productName:
      "RITZ Bits Cheese Sandwich Crackers Lunch Snacks - 8.8oz",
    brand: "Ritz",
    flavor: null,
    size: "8.8 oz",
    category: "Dry",
    unitNetWeightOz: 8.8,
    unitPriceCents: 397,
    packagingCostCents: 150,
    shippingLabelCents: 878,
    description: "Exact source description.",
    ingredients: "WHEAT FLOUR, CANOLA OIL.",
    mainImageUrl: "https://images.example/main.jpg",
    imageUrls: [
      "https://images.example/main.jpg",
      "https://images.example/nutrition.jpg",
    ],
    packCounts: [2, 3] as Array<2 | 3>,
  };
  const first = buildWalmartNewSkuOwnerPreviewGallery(input);
  const second = buildWalmartNewSkuOwnerPreviewGallery(input);

  assert.deepEqual(first, second);
  assert.equal(first.listing_previews.length, 2);
  assert.equal(first.listing_previews[0]!.price_cents, 3_313);
  assert.equal(first.listing_previews[1]!.price_cents, 4_036);
  assert.match(first.listing_previews[0]!.title, /8\.8 oz \(Pack of 2\)$/);
  assert.equal(
    first.listing_previews[0]!.comparable
      .price_competitiveness_signal,
    "ABOVE_EXACT_COMPARABLE_WARNING",
  );
  assert.equal(
    first.listing_previews[0]!.publication_readiness.status,
    "BLOCKED_PREVIEW_ONLY",
  );
  assert.equal(first.rules.marketplace_mutated, false);
  assert.match(first.artifact_sha256, /^[a-f0-9]{64}$/);
});
