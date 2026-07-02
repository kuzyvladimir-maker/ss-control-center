// Unit tests for the Bundle Factory cost-buildup pricing calculator.
//   npx tsx --test src/lib/bundle-factory/__tests__/pricing-calculator.test.ts
//
// Verifies the frozen cost buildup (goods + cooler + ice + box), the two levers
// (target margin vs markup), the referral-fee accounting, and the floor.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeBundlePrice,
  type PricingModel,
} from "@/lib/bundle-factory/pricing-config";

function model(over: Partial<PricingModel> = {}): PricingModel {
  return {
    mode: "margin",
    markup: 3,
    target_margin_pct: 0.35,
    target_roi_pct: 0.70,
    min_price_cents: 999,
    fba_fee_cents: 0,
    closing_fee_cents: 0,
    own_shipping_cents: 0,
    referral_pct_override: null,
    shipping_in_price: true, // legacy tests below assert the buildup WITH shipping in cost
    ...over,
  };
}

test("frozen packaging buildup — Medium cooler + auto M shipping when weight unknown", () => {
  const r = computeBundlePrice(
    { cogs_cents: 5904, weight_lb: null, category: "FROZEN_SINGLE" },
    model(),
  );
  // cooler M $9 + ice(9lb)=$0.72 + box $1 = $10.72 packaging; shipping = M label $32
  assert.equal(r.cooler_size, "M");
  assert.equal(r.cost.cooler_cents, 900);
  assert.equal(r.cost.ice_cents, 72);
  assert.equal(r.cost.box_cents, 100);
  assert.equal(r.cost.packaging_cents, 1072);
  assert.equal(r.packaging_estimated, true);
  assert.equal(r.shipping_auto, true);
  assert.equal(r.cost.own_shipping_cents, 3200); // calibrated M label
  assert.equal(r.cost.total_cost_cents, 5904 + 1072 + 3200);
});

test("margin mode — solved price hits the target margin (35%)", () => {
  const r = computeBundlePrice(
    { cogs_cents: 5904, weight_lb: null, category: "FROZEN_SINGLE" },
    model({ target_margin_pct: 0.35 }),
  );
  // totalCost (5904+1072+3200=10176) / (1 - 0.15 - 0.35=0.5) = 20352 cents
  assert.equal(r.selling_price_cents, 20352);
  // realized margin after actual tiered referral ≈ target
  assert.ok(Math.abs(r.margin_pct - 0.35) < 0.01, `margin ${r.margin_pct}`);
  assert.ok(r.profit_cents > 0);
});

test("count-based cooler — 30 units -> S ($7.50 pkg), 48 -> M ($10.90), not the weight fallback", () => {
  const s = computeBundlePrice(
    { cogs_cents: 3000, weight_lb: null, unit_count: 30, category: "FROZEN_GROCERY" },
    model(),
  );
  assert.equal(s.cooler_size, "S");
  assert.equal(s.cost.packaging_cents, 750); // cost-model PACKAGING.S = $7.50
  const m = computeBundlePrice(
    { cogs_cents: 4800, weight_lb: null, unit_count: 48, category: "FROZEN_GROCERY" },
    model(),
  );
  assert.equal(m.cooler_size, "M");
  assert.equal(m.cost.packaging_cents, 1090); // PACKAGING.M = $10.90
});

test("shipping-out (default) + markup 2.3 reproduces the 30-ct best-seller (~$86)", () => {
  const r = computeBundlePrice(
    { cogs_cents: 3000, weight_lb: null, unit_count: 30, category: "FROZEN_GROCERY" },
    model({ mode: "markup", markup: 2.3, shipping_in_price: false }),
  );
  // base = goods $30 + packaging S $7.50 = $37.50; shipping NOT in price.
  // price = 3750 * 2.3 = 8625 cents = $86.25 (his live best-seller = $86.15).
  assert.equal(r.selling_price_cents, 8625);
  // shipping still reported for the template (S label $20), just not in cost.
  assert.equal(r.cost.own_shipping_cents, 2000);
  assert.equal(r.cost.total_cost_cents, 3000 + 750); // goods + packaging only
});

test("roi mode — profit / (goods + packaging) hits target ROI (70%), shipping excluded from base", () => {
  const r = computeBundlePrice(
    { cogs_cents: 5904, weight_lb: null, category: "FROZEN_SINGLE" },
    model({ mode: "roi", target_roi_pct: 0.70 }),
  );
  // base = goods 5904 + packaging 1072 = 6976; targetProfit = 0.70×6976 = 4883
  // total_cost = 5904+1072+3200(ship) = 10176
  // price = ceil((10176 + 4883) / (1 − 0.15)) = ceil(15059/0.85) = 17717
  assert.equal(r.selling_price_cents, 17717);
  // ROI measured against goods+packaging (shipping NOT in the base) ≈ 70%
  assert.ok(Math.abs(r.roi_pct - 0.70) < 0.02, `roi ${r.roi_pct}`);
  assert.ok(r.profit_cents > 0);
});

test("markup mode — price = total landed cost × markup", () => {
  const r = computeBundlePrice(
    { cogs_cents: 5904, weight_lb: null, category: "FROZEN_SINGLE" },
    model({ mode: "markup", markup: 2 }),
  );
  // total cost 10176 × 2 = 20352
  assert.equal(r.selling_price_cents, 20352);
});

test("shipping auto-fills from cooler size (S $20 / M $32 / L $45 / XL $60)", () => {
  const s = computeBundlePrice({ cogs_cents: 1000, weight_lb: 5, category: "FROZEN" }, model());
  assert.equal(s.cooler_size, "S");
  assert.equal(s.cost.own_shipping_cents, 2000);
  const m = computeBundlePrice({ cogs_cents: 1000, weight_lb: 10, category: "FROZEN" }, model());
  assert.equal(m.cost.own_shipping_cents, 3200);
  const l = computeBundlePrice({ cogs_cents: 1000, weight_lb: 18, category: "FROZEN" }, model());
  assert.equal(l.cost.own_shipping_cents, 4500);
  const xl = computeBundlePrice({ cogs_cents: 1000, weight_lb: 25, category: "FROZEN" }, model());
  assert.equal(xl.cost.own_shipping_cents, 6000);
});

test("global own_shipping override wins over the auto cooler label", () => {
  const r = computeBundlePrice(
    { cogs_cents: 1000, weight_lb: 10, category: "FROZEN" },
    model({ own_shipping_cents: 4000 }),
  );
  assert.equal(r.shipping_auto, false);
  assert.equal(r.cost.own_shipping_cents, 4000);
});

test("dry bundle uses the flat global shipping, not a cooler label", () => {
  const r = computeBundlePrice(
    { cogs_cents: 1000, weight_lb: 5, category: "DRY" },
    model({ own_shipping_cents: 800 }),
  );
  assert.equal(r.shipping_auto, false);
  assert.equal(r.cost.own_shipping_cents, 800);
});

test("weight drives the cooler size (18lb → L, 25lb → XL)", () => {
  const l = computeBundlePrice(
    { cogs_cents: 1000, weight_lb: 18, category: "FROZEN" },
    model(),
  );
  assert.equal(l.cooler_size, "L");
  assert.equal(l.cost.cooler_cents, 1200);
  assert.equal(l.packaging_estimated, false);

  const xl = computeBundlePrice(
    { cogs_cents: 1000, weight_lb: 25, category: "FROZEN" },
    model(),
  );
  assert.equal(xl.cooler_size, "XL");
  assert.equal(xl.cost.cooler_cents, 1600);
});

test("dry category uses a plain box, no cooler/ice", () => {
  const r = computeBundlePrice(
    { cogs_cents: 1000, weight_lb: 5, category: "DRY_SNACKS" },
    model(),
  );
  assert.equal(r.cooler_size, null);
  assert.equal(r.cost.cooler_cents, 0);
  assert.equal(r.cost.ice_cents, 0);
  assert.equal(r.cost.box_cents, 150); // DRY_BOX_COST $1.50
});

test("floor applies when solved price is below the minimum", () => {
  const r = computeBundlePrice(
    { cogs_cents: 50, weight_lb: 2, category: "DRY" },
    model({ min_price_cents: 999 }),
  );
  assert.equal(r.selling_price_cents, 999);
});

test("referral override changes the solved price", () => {
  const auto = computeBundlePrice(
    { cogs_cents: 5904, weight_lb: null, category: "FROZEN" },
    model(),
  );
  const lower = computeBundlePrice(
    { cogs_cents: 5904, weight_lb: null, category: "FROZEN" },
    model({ referral_pct_override: 0.08 }),
  );
  // Lower referral in the solve → lower required price for the same margin.
  assert.ok(lower.selling_price_cents < auto.selling_price_cents);
});

test("fba/closing fees add to total cost and raise the price", () => {
  const base = computeBundlePrice(
    { cogs_cents: 3000, weight_lb: 10, category: "FROZEN" },
    model(),
  );
  const withFees = computeBundlePrice(
    { cogs_cents: 3000, weight_lb: 10, category: "FROZEN" },
    model({ fba_fee_cents: 500, closing_fee_cents: 300 }),
  );
  assert.equal(
    withFees.cost.total_cost_cents,
    base.cost.total_cost_cents + 800,
  );
  assert.ok(withFees.selling_price_cents > base.selling_price_cents);
});
