import {
  calculateWalmartTemplateShippingScenarios,
  type WalmartShippingChargeScenario,
  type WalmartShippingTemplateDetails,
} from "./walmart-shipping-templates";

export const WALMART_STUDIO_DEFAULT_PACKAGING_COST_CENTS = 150;
export const WALMART_STUDIO_DEFAULT_SHIPPING_LABEL_CENTS = 878;
export const WALMART_STUDIO_REFERRAL_FEE_BPS = 1_500;

/**
 * The owner's pricing rule, in his words: 70% return on the money he actually
 * puts in.
 *
 * "Invested" is the goods and the packaging, and nothing else. The shipping
 * label is a real cost and is subtracted from profit, but it is NOT part of the
 * denominator — it is bought on account rather than out of his own money, so it
 * is not capital at risk.
 *
 * This is deliberately NOT a margin. Margin measures profit against what the
 * customer paid; ROI measures it against what was staked. On a free-shipping
 * template, where an $8.78 label comes out of our own price, a 30% margin
 * target produced a 42% return — which is why the first published listing was
 * priced at $37.68 instead of $43.09.
 */
export const WALMART_STUDIO_TARGET_ROI_BPS = 7_000;

export interface WalmartStudioDraftEconomicsScenario
  extends WalmartShippingChargeScenario {
  item_price_cents: number;
  customer_total_cents: number;
  referral_fee_cents: number;
  contribution_profit_cents: number;
  contribution_margin_bps: number;
  /** Profit against invested capital (goods + packaging), in basis points. */
  return_on_invested_bps: number;
}
export interface WalmartStudioDraftEconomics {
  goods_cost_cents: number;
  packaging_cost_cents: number;
  shipping_label_cents: number;
  referral_fee_bps: typeof WALMART_STUDIO_REFERRAL_FEE_BPS;
  /** What the price was solved for: return on invested capital. */
  target_roi_bps: number;
  /** Money actually staked: goods + packaging. Excludes the shipping label. */
  invested_capital_cents: number;
  item_price_cents: number;
  minimum_customer_shipping_charge_cents: number;
  maximum_customer_shipping_charge_cents: number;
  minimum_customer_total_cents: number;
  maximum_customer_total_cents: number;
  worst_case_contribution_margin_bps: number;
  worst_case_return_on_invested_bps: number;
  shipping_template_id: string;
  shipping_template_name: string;
  shipping_template_sha256: string;
  is_free_shipping: boolean;
  scenarios: WalmartStudioDraftEconomicsScenario[];
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function targetRoi(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error("targetRoiBps must be a whole number from 1 to 100000");
  }
  return value;
}

function scenarioEconomics(input: {
  scenario: WalmartShippingChargeScenario;
  itemPriceCents: number;
  fixedCostCents: number;
  investedCapitalCents: number;
}): WalmartStudioDraftEconomicsScenario {
  const customerTotalCents =
    input.itemPriceCents + input.scenario.customer_shipping_charge_cents;
  const referralFeeCents = Math.ceil(
    customerTotalCents * WALMART_STUDIO_REFERRAL_FEE_BPS / 10_000,
  );
  const contributionProfitCents =
    customerTotalCents - input.fixedCostCents - referralFeeCents;
  return {
    ...input.scenario,
    item_price_cents: input.itemPriceCents,
    customer_total_cents: customerTotalCents,
    referral_fee_cents: referralFeeCents,
    contribution_profit_cents: contributionProfitCents,
    contribution_margin_bps: Math.floor(
      contributionProfitCents * 10_000 / customerTotalCents,
    ),
    return_on_invested_bps: Math.floor(
      contributionProfitCents * 10_000 / input.investedCapitalCents,
    ),
  };
}

/**
 * Solves the lowest displayed item price that reaches the selected margin in
 * every active scenario of the exact Walmart shipping-template snapshot.
 * Walmart's referral fee is charged against item price plus buyer shipping.
 */
export function calculateWalmartStudioDraftEconomics(input: {
  goodsCostCents: number;
  packagingCostCents: number;
  shippingLabelCents: number;
  /** Return on invested capital, in basis points. Defaults to the owner's 70%. */
  targetRoiBps?: number;
  packageWeightOz: number;
  template: WalmartShippingTemplateDetails;
}): WalmartStudioDraftEconomics {
  const goodsCostCents = positiveInteger(input.goodsCostCents, "goodsCostCents");
  const packagingCostCents = positiveInteger(
    input.packagingCostCents,
    "packagingCostCents",
  );
  const shippingLabelCents = positiveInteger(
    input.shippingLabelCents,
    "shippingLabelCents",
  );
  const targetRoiBps = targetRoi(
    input.targetRoiBps ?? WALMART_STUDIO_TARGET_ROI_BPS,
  );
  // Capital at risk. The shipping label is a cost, not an investment.
  const investedCapitalCents = goodsCostCents + packagingCostCents;
  if (!Number.isFinite(input.packageWeightOz) || input.packageWeightOz <= 0) {
    throw new Error("packageWeightOz must be positive");
  }
  const fixedCostCents =
    goodsCostCents + packagingCostCents + shippingLabelCents;
  // Highest price the search could possibly need: everything the customer pays
  // has to cover the costs and the required return once the referral fee is
  // taken off. Doubled as headroom for tiered shipping, where the customer's
  // total is larger than the item price and the fee grows with it.
  const requiredNetCents = fixedCostCents
    + Math.ceil(investedCapitalCents * targetRoiBps / 10_000);
  const freeShippingPriceCeiling = Math.ceil(
    requiredNetCents * 10_000 / (10_000 - WALMART_STUDIO_REFERRAL_FEE_BPS),
  ) * 2 + 4;

  for (
    let itemPriceCents = 1;
    itemPriceCents <= freeShippingPriceCeiling;
    itemPriceCents += 1
  ) {
    let shippingScenarios: WalmartShippingChargeScenario[];
    try {
      shippingScenarios = calculateWalmartTemplateShippingScenarios({
        template: input.template,
        itemPriceCents,
        packageWeightOz: input.packageWeightOz,
        itemQuantity: 1,
      });
    } catch {
      continue;
    }
    const scenarios = shippingScenarios.map((scenario) =>
      scenarioEconomics({
        scenario,
        itemPriceCents,
        fixedCostCents,
        investedCapitalCents,
      }),
    );
    if (
      scenarios.length === 0 ||
      scenarios.some(
        (scenario) =>
          scenario.contribution_profit_cents * 10_000 <
          investedCapitalCents * targetRoiBps,
      )
    ) {
      continue;
    }
    const shippingCharges = scenarios.map(
      (scenario) => scenario.customer_shipping_charge_cents,
    );
    const totals = scenarios.map((scenario) => scenario.customer_total_cents);
    const margins = scenarios.map(
      (scenario) => scenario.contribution_margin_bps,
    );
    return {
      goods_cost_cents: goodsCostCents,
      packaging_cost_cents: packagingCostCents,
      shipping_label_cents: shippingLabelCents,
      referral_fee_bps: WALMART_STUDIO_REFERRAL_FEE_BPS,
      target_roi_bps: targetRoiBps,
      invested_capital_cents: investedCapitalCents,
      item_price_cents: itemPriceCents,
      minimum_customer_shipping_charge_cents: Math.min(...shippingCharges),
      maximum_customer_shipping_charge_cents: Math.max(...shippingCharges),
      minimum_customer_total_cents: Math.min(...totals),
      maximum_customer_total_cents: Math.max(...totals),
      worst_case_contribution_margin_bps: Math.min(...margins),
      worst_case_return_on_invested_bps: Math.min(
        ...scenarios.map((scenario) => scenario.return_on_invested_bps),
      ),
      shipping_template_id: input.template.id,
      shipping_template_name: input.template.name,
      shipping_template_sha256: input.template.template_sha256,
      is_free_shipping: input.template.is_free_shipping,
      scenarios,
    };
  }
  throw new Error(
    `No item price reaches the required return on invested capital for shipping template ${input.template.id}`,
  );
}

export function walmartStudioDraftPackageWeightOz(input: {
  sizeDimension: "MASS" | "VOLUME" | "COUNT";
  sizeBaseAmount: number;
  sizeBaseUnit: "g" | "ml" | "count";
  packCount: number;
  template: WalmartShippingTemplateDetails;
}): { package_weight_oz: number; basis: "EXACT_NET_MASS" | "NOT_USED_BY_TEMPLATE" } {
  const hasWeightCharge = input.template.configurations
    .filter((configuration) => configuration.status === "ACTIVE")
    .some(
      (configuration) =>
        configuration.pricing.kind === "PER_SHIPMENT_PRICING" &&
        configuration.pricing.charge_per_weight.amount_cents > 0,
    );
  if (!hasWeightCharge) {
    return { package_weight_oz: 1, basis: "NOT_USED_BY_TEMPLATE" };
  }
  if (
    input.sizeDimension !== "MASS" ||
    input.sizeBaseUnit !== "g" ||
    !Number.isFinite(input.sizeBaseAmount) ||
    input.sizeBaseAmount <= 0 ||
    !Number.isInteger(input.packCount) ||
    input.packCount <= 0
  ) {
    throw new Error(
      "The selected shipping template charges by weight, but Product Truth has no exact product mass",
    );
  }
  return {
    package_weight_oz: input.sizeBaseAmount * input.packCount / 28.349523125,
    basis: "EXACT_NET_MASS",
  };
}
