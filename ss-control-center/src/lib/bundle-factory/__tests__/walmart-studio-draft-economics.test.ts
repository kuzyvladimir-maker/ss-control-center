/**
 * Pricing is solved for return on invested capital, not for margin.
 *
 * The owner's rule, in his words: 70% back on the money he actually puts in.
 * Invested is the goods and the packaging. The shipping label is a real cost
 * and comes out of profit, but it is NOT in the denominator — it is bought on
 * account, not staked out of his own pocket.
 *
 * Why this replaced a margin target: margin measures profit against what the
 * customer paid, and on a free-shipping template the label comes out of our own
 * price. A 30% margin target priced the first published listing at $37.68 on
 * $16.38 invested — a 42% return, not 70%. The two metrics diverge exactly
 * where the shipping cost is.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateWalmartStudioDraftEconomics,
  WALMART_STUDIO_TARGET_ROI_BPS,
} from "../walmart-studio-draft-economics";
import { parseWalmartShippingTemplateDetails } from "../walmart-shipping-templates";

function flatTemplate(dollars: number) {
  return parseWalmartShippingTemplateDetails({
    id: "T1",
    name: `flat ${dollars}`,
    type: "CUSTOM",
    rateModelType: "PER_SHIPMENT_PRICING",
    status: "ACTIVE",
    shippingMethods: [{
      shipMethod: "VALUE",
      status: "ACTIVE",
      configurations: [{
        regions: [{ regionCode: "C", regionName: "48 State", subRegions: [] }],
        addressTypes: ["STREET"],
        transitTime: 6,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: dollars, currency: "USD" },
          chargePerWeight: { amount: 0, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
      }],
    }],
  });
}

/** The live Campbell's Pack-of-6 numbers, so the test speaks about real money. */
const REAL = {
  goodsCostCents: 1_488,
  packagingCostCents: 150,
  shippingLabelCents: 878,
  packageWeightOz: 179,
};

test("70 percent is the default, and it is the owner's rule", () => {
  assert.equal(WALMART_STUDIO_TARGET_ROI_BPS, 7_000);
});

test("the live listing prices at $43.10 and returns exactly 70 percent", () => {
  const result = calculateWalmartStudioDraftEconomics({
    ...REAL,
    template: flatTemplate(0),
  });

  assert.equal(result.invested_capital_cents, 1_638, "goods + packaging only");
  assert.equal(result.item_price_cents, 4_310);

  const scenario = result.scenarios[0]!;
  assert.equal(scenario.customer_total_cents, 4_310);
  assert.equal(scenario.referral_fee_cents, 647);
  assert.equal(scenario.contribution_profit_cents, 1_147);
  assert.ok(
    scenario.return_on_invested_bps >= 7_000,
    `ROI was ${scenario.return_on_invested_bps} bps`,
  );
});

test("the shipping label is subtracted from profit but is not invested", () => {
  const result = calculateWalmartStudioDraftEconomics({
    ...REAL,
    template: flatTemplate(0),
  });
  // Invested excludes the label...
  assert.equal(
    result.invested_capital_cents,
    REAL.goodsCostCents + REAL.packagingCostCents,
  );
  // ...but profit still pays for it.
  const scenario = result.scenarios[0]!;
  const allCosts = REAL.goodsCostCents + REAL.packagingCostCents
    + REAL.shippingLabelCents;
  assert.equal(
    scenario.contribution_profit_cents,
    scenario.customer_total_cents - allCosts - scenario.referral_fee_cents,
  );
});

test("the old 30 percent margin target would have under-priced it", () => {
  const result = calculateWalmartStudioDraftEconomics({
    ...REAL,
    template: flatTemplate(0),
  });
  // $37.68 was the price the margin rule produced. Whatever we charge now must
  // be more than that, or the change achieved nothing.
  assert.ok(
    result.item_price_cents > 3_768,
    `priced at ${result.item_price_cents}, which is no better than the margin rule`,
  );
  // And that old price really did fall short of the owner's rule.
  const oldProfit = 3_768 - 1_488 - 150 - 878 - Math.ceil(3_768 * 0.15);
  assert.ok(oldProfit * 10_000 / 1_638 < 7_000);
});

test("a customer-paid shipping template lowers the item price, not the return", () => {
  const free = calculateWalmartStudioDraftEconomics({
    ...REAL,
    template: flatTemplate(0),
  });
  const paid = calculateWalmartStudioDraftEconomics({
    ...REAL,
    template: flatTemplate(11.99),
  });

  assert.ok(
    paid.item_price_cents < free.item_price_cents,
    "when the buyer pays shipping, the item itself costs less",
  );
  // The return is what must stay put.
  assert.ok(paid.worst_case_return_on_invested_bps >= 7_000);
  assert.ok(free.worst_case_return_on_invested_bps >= 7_000);
});

test("an explicitly chosen target is honoured", () => {
  const result = calculateWalmartStudioDraftEconomics({
    ...REAL,
    targetRoiBps: 10_000,
    template: flatTemplate(0),
  });
  assert.equal(result.target_roi_bps, 10_000);
  assert.ok(result.worst_case_return_on_invested_bps >= 10_000);
});

test("does not invent weight when the template actually charges by weight", () => {
  const weighted = parseWalmartShippingTemplateDetails({
    id: "T2",
    name: "by weight",
    type: "CUSTOM",
    rateModelType: "PER_SHIPMENT_PRICING",
    status: "ACTIVE",
    shippingMethods: [{
      shipMethod: "VALUE",
      status: "ACTIVE",
      configurations: [{
        regions: [{ regionCode: "C", regionName: "48 State", subRegions: [] }],
        addressTypes: ["STREET"],
        transitTime: 6,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 0, currency: "USD" },
          chargePerWeight: { amount: 1, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
      }],
    }],
  });
  const result = calculateWalmartStudioDraftEconomics({
    ...REAL,
    template: weighted,
  });
  assert.ok(result.scenarios.every((s) => s.customer_shipping_charge_cents > 0));
  assert.ok(result.worst_case_return_on_invested_bps >= 7_000);
});
