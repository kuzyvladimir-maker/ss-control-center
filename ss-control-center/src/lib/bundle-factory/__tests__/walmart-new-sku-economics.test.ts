import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateWalmartNewSkuEconomics,
  minimumWalmartNewSkuPriceForShippingTemplate,
  minimumWalmartNewSkuPriceForTargetMargin,
  walmartNewSkuComparableSignal,
} from "../walmart-new-sku-economics";
import { parseWalmartShippingTemplateDetails } from
  "../walmart-shipping-templates";

test("RITZ two-pack minimum price reaches the exact 30% contribution target", () => {
  const economics = minimumWalmartNewSkuPriceForTargetMargin({
    goodsCostCents: 794,
    packagingCostCents: 150,
    shippingLabelCents: 878,
  });

  assert.deepEqual(economics, {
    goods_cost_cents: 794,
    packaging_cost_cents: 150,
    shipping_label_cents: 878,
    referral_fee_bps: 1_500,
    referral_fee_cents: 497,
    target_margin_bps: 3_000,
    item_price_cents: 3_313,
    customer_shipping_charge_cents: 0,
    customer_total_cents: 3_313,
    contribution_profit_cents: 994,
    contribution_margin_bps: 3_000,
  });
});

test("minimum-price solver advances past fee rounding when necessary", () => {
  const economics = minimumWalmartNewSkuPriceForTargetMargin({
    goodsCostCents: 1_191,
    packagingCostCents: 150,
    shippingLabelCents: 878,
  });
  assert.equal(economics.item_price_cents, 4_036);
  assert.equal(economics.referral_fee_cents, 606);
  assert.equal(economics.contribution_profit_cents, 1_211);
  assert.equal(economics.contribution_margin_bps, 3_000);
});

test("above-comparable pricing is a warning while below-margin pricing fails math", () => {
  assert.deepEqual(
    walmartNewSkuComparableSignal({
      itemPriceCents: 3_313,
      linearizedComparableCents: 794,
    }),
    {
      proposed_to_comparable_ratio_bps: 41_726,
      price_competitiveness_signal: "ABOVE_EXACT_COMPARABLE_WARNING",
    },
  );
  const belowTarget = calculateWalmartNewSkuEconomics({
    goodsCostCents: 794,
    packagingCostCents: 150,
    shippingLabelCents: 878,
    itemPriceCents: 3_000,
  });
  assert.ok(belowTarget.contribution_margin_bps < 3_000);
});

test("flat $11.99 customer shipping preserves the $33.13 landed target", () => {
  const template = parseWalmartShippingTemplateDetails({
    id: "paid-1199",
    name: "Standard $11.99",
    type: "CUSTOM",
    status: "ACTIVE",
    rateModelType: "PER_SHIPMENT_PRICING",
    createdDate: 1_700_000_000_000,
    modifiedDate: 1_700_000_000_001,
    shippingMethods: [{
      shipMethod: "STANDARD",
      status: "ACTIVE",
      configurations: [{
        regions: [{ regionCode: "C", regionName: "48 State" }],
        addressTypes: ["STREET"],
        transitTime: 5,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 11.99, currency: "USD" },
          chargePerWeight: { amount: 0, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
      }],
    }],
  });
  const result = minimumWalmartNewSkuPriceForShippingTemplate({
    goodsCostCents: 794,
    packagingCostCents: 150,
    shippingLabelCents: 878,
    packageWeightOz: 20,
    template,
  });

  assert.equal(result.item_price_cents, 2_114);
  assert.equal(result.minimum_customer_shipping_charge_cents, 1_199);
  assert.equal(result.maximum_customer_shipping_charge_cents, 1_199);
  assert.equal(result.minimum_customer_total_cents, 3_313);
  assert.equal(result.maximum_customer_total_cents, 3_313);
  assert.equal(result.scenarios[0]!.economics.referral_fee_cents, 497);
  assert.equal(result.worst_case_contribution_margin_bps, 3_000);
});
