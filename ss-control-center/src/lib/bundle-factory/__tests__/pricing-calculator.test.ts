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
    min_price_cents: 999,
    fba_fee_cents: 0,
    closing_fee_cents: 0,
    own_shipping_cents: 0,
    referral_pct_override: null,
    ...over,
  };
}

test("frozen packaging buildup — Medium cooler when weight unknown", () => {
  const r = computeBundlePrice(
    { cogs_cents: 5904, weight_lb: null, category: "FROZEN_SINGLE" },
    model(),
  );
  // cooler M $9 + ice(9lb)=$0.72 + box $1 = $10.72
  assert.equal(r.cooler_size, "M");
  assert.equal(r.cost.cooler_cents, 900);
  assert.equal(r.cost.ice_cents, 72);
  assert.equal(r.cost.box_cents, 100);
  assert.equal(r.cost.packaging_cents, 1072);
  assert.equal(r.packaging_estimated, true);
  assert.equal(r.cost.total_cost_cents, 5904 + 1072);
});

test("margin mode — solved price hits the target margin (35%)", () => {
  const r = computeBundlePrice(
    { cogs_cents: 5904, weight_lb: null, category: "FROZEN_SINGLE" },
    model({ target_margin_pct: 0.35 }),
  );
  // totalCost 6976 / (1 - 0.15 - 0.35=0.5) = 13952 cents
  assert.equal(r.selling_price_cents, 13952);
  // realized margin after actual tiered referral ≈ target
  assert.ok(Math.abs(r.margin_pct - 0.35) < 0.01, `margin ${r.margin_pct}`);
  assert.ok(r.profit_cents > 0);
});

test("markup mode — price = total landed cost × markup", () => {
  const r = computeBundlePrice(
    { cogs_cents: 5904, weight_lb: null, category: "FROZEN_SINGLE" },
    model({ mode: "markup", markup: 2 }),
  );
  // total cost 6976 × 2 = 13952
  assert.equal(r.selling_price_cents, 13952);
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

test("fees add to total cost and raise the price", () => {
  const base = computeBundlePrice(
    { cogs_cents: 3000, weight_lb: 10, category: "FROZEN" },
    model(),
  );
  const withFees = computeBundlePrice(
    { cogs_cents: 3000, weight_lb: 10, category: "FROZEN" },
    model({ fba_fee_cents: 500, own_shipping_cents: 1500 }),
  );
  assert.equal(
    withFees.cost.total_cost_cents,
    base.cost.total_cost_cents + 2000,
  );
  assert.ok(withFees.selling_price_cents > base.selling_price_cents);
});
