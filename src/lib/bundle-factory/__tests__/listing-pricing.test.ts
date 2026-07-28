import { test } from "node:test";
import assert from "node:assert/strict";

import { computeListingPrice } from "@/lib/bundle-factory/listing-pricing";
import type { PricingModel } from "@/lib/bundle-factory/pricing-config";

const MODEL: PricingModel = {
  mode: "markup",
  markup: 2.3,
  target_margin_pct: 0.3,
  target_roi_pct: 0.7,
  min_price_cents: 999,
  fba_fee_cents: 0,
  closing_fee_cents: 0,
  own_shipping_cents: 0,
  referral_pct_override: null,
  shipping_in_price: false,
};

test("Uncrustables uses the canonical count model and .99 target", () => {
  const expected = new Map([
    [24, [7699, 6695]],
    [30, [8599, 7475]],
    [45, [13099, 11427]],
    [90, [25299, 21957]],
    [120, [29799, 25857]],
  ]);

  for (const [count, [target, floor]] of expected) {
    const result = computeListingPrice(
      {
        brand: "Uncrustables",
        cogs_cents: count * 100,
        unit_count: count,
        weight_lb: null,
        category: "FROZEN_GROCERY",
      },
      MODEL,
    );
    assert.equal(result.pricing_source, "UNCRUSTABLES_CANONICAL");
    assert.equal(result.selling_price_cents, target, `${count} target`);
    assert.equal(result.floor_price_cents, floor, `${count} floor`);
  }
});

test("non-passthrough bundles keep the configurable pricing model", () => {
  const result = computeListingPrice(
    {
      brand: "Salutem Vita",
      cogs_cents: 3000,
      unit_count: 30,
      weight_lb: null,
      category: "FROZEN_GROCERY",
    },
    MODEL,
  );
  assert.equal(result.pricing_source, "BUNDLE_FACTORY_CONFIG");
  assert.equal(result.selling_price_cents, 8625);
});
