import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateWalmartStudioDraftEconomics,
  walmartStudioDraftPackageWeightOz,
} from "../walmart-studio-draft-economics";
import { parseWalmartShippingTemplateDetails } from
  "../walmart-shipping-templates";

function flatTemplate(amount: number) {
  return parseWalmartShippingTemplateDetails({
    id: amount === 0 ? "free" : "paid-1199",
    name: amount === 0 ? "Free shipping" : "Standard $11.99",
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
          shippingAndHandling: { amount, currency: "USD" },
          chargePerWeight: { amount: 0, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
      }],
    }],
  });
}

test("free and $11.99 templates preserve one landed target at 30 percent", () => {
  const free = calculateWalmartStudioDraftEconomics({
    goodsCostCents: 794,
    packagingCostCents: 150,
    shippingLabelCents: 878,
    targetMarginBps: 3_000,
    packageWeightOz: 1,
    template: flatTemplate(0),
  });
  const paid = calculateWalmartStudioDraftEconomics({
    goodsCostCents: 794,
    packagingCostCents: 150,
    shippingLabelCents: 878,
    targetMarginBps: 3_000,
    packageWeightOz: 1,
    template: flatTemplate(11.99),
  });

  assert.equal(free.item_price_cents, 3_313);
  assert.equal(free.minimum_customer_total_cents, 3_313);
  assert.equal(paid.item_price_cents, 2_114);
  assert.equal(paid.minimum_customer_shipping_charge_cents, 1_199);
  assert.equal(paid.minimum_customer_total_cents, 3_313);
});
test("honors a non-default owner-selected target margin", () => {
  const result = calculateWalmartStudioDraftEconomics({
    goodsCostCents: 794,
    packagingCostCents: 150,
    shippingLabelCents: 878,
    targetMarginBps: 2_500,
    packageWeightOz: 1,
    template: flatTemplate(0),
  });
  assert.equal(result.target_margin_bps, 2_500);
  assert.ok(result.worst_case_contribution_margin_bps >= 2_500);
  assert.ok(result.item_price_cents < 3_313);
});

test("does not invent weight when the template actually charges by weight", () => {
  const free = flatTemplate(0);
  assert.deepEqual(walmartStudioDraftPackageWeightOz({
    sizeDimension: "COUNT",
    sizeBaseAmount: 1,
    sizeBaseUnit: "count",
    packCount: 8,
    template: free,
  }), { package_weight_oz: 1, basis: "NOT_USED_BY_TEMPLATE" });

  const weighted = parseWalmartShippingTemplateDetails({
    id: "weighted",
    name: "Weighted",
    type: "CUSTOM",
    status: "ACTIVE",
    rateModelType: "PER_SHIPMENT_PRICING",
    shippingMethods: [{
      shipMethod: "STANDARD",
      status: "ACTIVE",
      configurations: [{
        regions: [{ regionCode: "C", regionName: "48 State" }],
        addressTypes: ["STREET"],
        transitTime: 5,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 5, currency: "USD" },
          chargePerWeight: { amount: 0.5, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
      }],
    }],
  });
  assert.throws(
    () => walmartStudioDraftPackageWeightOz({
      sizeDimension: "COUNT",
      sizeBaseAmount: 1,
      sizeBaseUnit: "count",
      packCount: 8,
      template: weighted,
    }),
    /no exact product mass/,
  );
});
