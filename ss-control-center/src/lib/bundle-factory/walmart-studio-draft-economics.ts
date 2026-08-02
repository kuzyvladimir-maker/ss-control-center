import {
  calculateWalmartTemplateShippingScenarios,
  type WalmartShippingChargeScenario,
  type WalmartShippingTemplateDetails,
} from "./walmart-shipping-templates";

export const WALMART_STUDIO_DEFAULT_PACKAGING_COST_CENTS = 150;
export const WALMART_STUDIO_DEFAULT_SHIPPING_LABEL_CENTS = 878;
export const WALMART_STUDIO_REFERRAL_FEE_BPS = 1_500;

export interface WalmartStudioDraftEconomicsScenario
  extends WalmartShippingChargeScenario {
  item_price_cents: number;
  customer_total_cents: number;
  referral_fee_cents: number;
  contribution_profit_cents: number;
  contribution_margin_bps: number;
}
export interface WalmartStudioDraftEconomics {
  goods_cost_cents: number;
  packaging_cost_cents: number;
  shipping_label_cents: number;
  referral_fee_bps: typeof WALMART_STUDIO_REFERRAL_FEE_BPS;
  target_margin_bps: number;
  item_price_cents: number;
  minimum_customer_shipping_charge_cents: number;
  maximum_customer_shipping_charge_cents: number;
  minimum_customer_total_cents: number;
  maximum_customer_total_cents: number;
  worst_case_contribution_margin_bps: number;
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

function targetMargin(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new Error("targetMarginBps must be a whole number from 1 to 5000");
  }
  if (value + WALMART_STUDIO_REFERRAL_FEE_BPS >= 10_000) {
    throw new Error("target margin and referral fee leave no positive price denominator");
  }
  return value;
}

function scenarioEconomics(input: {
  scenario: WalmartShippingChargeScenario;
  itemPriceCents: number;
  fixedCostCents: number;
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
  targetMarginBps: number;
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
  const targetMarginBps = targetMargin(input.targetMarginBps);
  if (!Number.isFinite(input.packageWeightOz) || input.packageWeightOz <= 0) {
    throw new Error("packageWeightOz must be positive");
  }
  const fixedCostCents =
    goodsCostCents + packagingCostCents + shippingLabelCents;
  const denominator =
    10_000 - WALMART_STUDIO_REFERRAL_FEE_BPS - targetMarginBps;
  const freeShippingPriceCeiling = Math.ceil(
    fixedCostCents * 10_000 / denominator,
  ) + 2;

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
      }),
    );
    if (
      scenarios.length === 0 ||
      scenarios.some(
        (scenario) =>
          scenario.contribution_profit_cents * 10_000 <
          scenario.customer_total_cents * targetMarginBps,
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
      target_margin_bps: targetMarginBps,
      item_price_cents: itemPriceCents,
      minimum_customer_shipping_charge_cents: Math.min(...shippingCharges),
      maximum_customer_shipping_charge_cents: Math.max(...shippingCharges),
      minimum_customer_total_cents: Math.min(...totals),
      maximum_customer_total_cents: Math.max(...totals),
      worst_case_contribution_margin_bps: Math.min(...margins),
      shipping_template_id: input.template.id,
      shipping_template_name: input.template.name,
      shipping_template_sha256: input.template.template_sha256,
      is_free_shipping: input.template.is_free_shipping,
      scenarios,
    };
  }
  throw new Error(
    `No item price reaches the selected margin for shipping template ${input.template.id}`,
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
