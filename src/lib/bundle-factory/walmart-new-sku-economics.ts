import {
  calculateWalmartTemplateShippingScenarios,
  type WalmartShippingChargeScenario,
  type WalmartShippingTemplateDetails,
} from "./walmart-shipping-templates";

export const SSCC_WALMART_NEW_SKU_TARGET_MARGIN_BPS = 3_000;
export const SSCC_WALMART_NEW_SKU_REFERRAL_FEE_BPS = 1_500;

export type WalmartNewSkuPriceCompetitivenessSignal =
  | "AT_OR_BELOW_EXACT_COMPARABLE"
  | "ABOVE_EXACT_COMPARABLE_WARNING";

export interface WalmartNewSkuEconomics {
  goods_cost_cents: number;
  packaging_cost_cents: number;
  shipping_label_cents: number;
  referral_fee_bps: typeof SSCC_WALMART_NEW_SKU_REFERRAL_FEE_BPS;
  referral_fee_cents: number;
  target_margin_bps: typeof SSCC_WALMART_NEW_SKU_TARGET_MARGIN_BPS;
  item_price_cents: number;
  customer_shipping_charge_cents: number;
  customer_total_cents: number;
  contribution_profit_cents: number;
  contribution_margin_bps: number;
}

export interface WalmartNewSkuTemplateEconomicsScenario
  extends WalmartShippingChargeScenario {
  economics: WalmartNewSkuEconomics;
}

export interface WalmartNewSkuTemplateEconomics {
  shipping_template_id: string;
  shipping_template_name: string;
  shipping_template_sha256: string;
  is_free_shipping: boolean;
  item_price_cents: number;
  minimum_customer_shipping_charge_cents: number;
  maximum_customer_shipping_charge_cents: number;
  minimum_customer_total_cents: number;
  maximum_customer_total_cents: number;
  worst_case_contribution_margin_bps: number;
  scenarios: WalmartNewSkuTemplateEconomicsScenario[];
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function calculateWalmartNewSkuEconomics(input: {
  goodsCostCents: number;
  packagingCostCents: number;
  shippingLabelCents: number;
  itemPriceCents: number;
  customerShippingChargeCents?: number;
}): WalmartNewSkuEconomics {
  const goodsCostCents = positiveSafeInteger(
    input.goodsCostCents,
    "goodsCostCents",
  );
  const packagingCostCents = positiveSafeInteger(
    input.packagingCostCents,
    "packagingCostCents",
  );
  const shippingLabelCents = positiveSafeInteger(
    input.shippingLabelCents,
    "shippingLabelCents",
  );
  const itemPriceCents = positiveSafeInteger(
    input.itemPriceCents,
    "itemPriceCents",
  );
  const customerShippingChargeCents =
    input.customerShippingChargeCents ?? 0;
  if (
    !Number.isSafeInteger(customerShippingChargeCents) ||
    customerShippingChargeCents < 0
  ) {
    throw new Error(
      "customerShippingChargeCents must be a non-negative safe integer",
    );
  }
  const customerTotalCents =
    itemPriceCents + customerShippingChargeCents;
  if (!Number.isSafeInteger(customerTotalCents)) {
    throw new Error("customer total exceeds safe integer precision");
  }
  const referralFeeCents = Math.ceil(
    customerTotalCents *
      SSCC_WALMART_NEW_SKU_REFERRAL_FEE_BPS /
      10_000,
  );
  const contributionProfitCents =
    customerTotalCents -
    goodsCostCents -
    packagingCostCents -
    shippingLabelCents -
    referralFeeCents;
  const contributionMarginBps = Math.floor(
    contributionProfitCents * 10_000 / customerTotalCents,
  );
  return {
    goods_cost_cents: goodsCostCents,
    packaging_cost_cents: packagingCostCents,
    shipping_label_cents: shippingLabelCents,
    referral_fee_bps: SSCC_WALMART_NEW_SKU_REFERRAL_FEE_BPS,
    referral_fee_cents: referralFeeCents,
    target_margin_bps: SSCC_WALMART_NEW_SKU_TARGET_MARGIN_BPS,
    item_price_cents: itemPriceCents,
    customer_shipping_charge_cents: customerShippingChargeCents,
    customer_total_cents: customerTotalCents,
    contribution_profit_cents: contributionProfitCents,
    contribution_margin_bps: contributionMarginBps,
  };
}

export function minimumWalmartNewSkuPriceForTargetMargin(input: {
  goodsCostCents: number;
  packagingCostCents: number;
  shippingLabelCents: number;
  customerShippingChargeCents?: number;
}): WalmartNewSkuEconomics {
  const goodsCostCents = positiveSafeInteger(
    input.goodsCostCents,
    "goodsCostCents",
  );
  const packagingCostCents = positiveSafeInteger(
    input.packagingCostCents,
    "packagingCostCents",
  );
  const shippingLabelCents = positiveSafeInteger(
    input.shippingLabelCents,
    "shippingLabelCents",
  );
  const fixedCostCents =
    goodsCostCents + packagingCostCents + shippingLabelCents;
  const customerShippingChargeCents =
    input.customerShippingChargeCents ?? 0;
  if (
    !Number.isSafeInteger(customerShippingChargeCents) ||
    customerShippingChargeCents < 0
  ) {
    throw new Error(
      "customerShippingChargeCents must be a non-negative safe integer",
    );
  }
  const denominatorBps =
    10_000 -
    SSCC_WALMART_NEW_SKU_REFERRAL_FEE_BPS -
    SSCC_WALMART_NEW_SKU_TARGET_MARGIN_BPS;
  const requiredCustomerTotalCents = Math.ceil(
    fixedCostCents * 10_000 / denominatorBps,
  );
  let itemPriceCents = Math.max(
    1,
    requiredCustomerTotalCents - customerShippingChargeCents,
  );
  for (;;) {
    const economics = calculateWalmartNewSkuEconomics({
      goodsCostCents,
      packagingCostCents,
      shippingLabelCents,
      itemPriceCents,
      customerShippingChargeCents,
    });
    if (
      economics.contribution_profit_cents * 10_000 >=
        economics.customer_total_cents *
          SSCC_WALMART_NEW_SKU_TARGET_MARGIN_BPS
    ) {
      return economics;
    }
    itemPriceCents += 1;
  }
}

export function minimumWalmartNewSkuPriceForShippingTemplate(input: {
  goodsCostCents: number;
  packagingCostCents: number;
  shippingLabelCents: number;
  packageWeightOz: number;
  template: WalmartShippingTemplateDetails;
  itemQuantity?: number;
}): WalmartNewSkuTemplateEconomics {
  const goodsCostCents = positiveSafeInteger(
    input.goodsCostCents,
    "goodsCostCents",
  );
  const packagingCostCents = positiveSafeInteger(
    input.packagingCostCents,
    "packagingCostCents",
  );
  const shippingLabelCents = positiveSafeInteger(
    input.shippingLabelCents,
    "shippingLabelCents",
  );
  if (!Number.isFinite(input.packageWeightOz) || input.packageWeightOz <= 0) {
    throw new Error("packageWeightOz must be a positive number");
  }
  const freeShippingCeiling = minimumWalmartNewSkuPriceForTargetMargin({
    goodsCostCents,
    packagingCostCents,
    shippingLabelCents,
  }).item_price_cents;
  for (
    let itemPriceCents = 1;
    itemPriceCents <= freeShippingCeiling;
    itemPriceCents += 1
  ) {
    let shippingScenarios: WalmartShippingChargeScenario[];
    try {
      shippingScenarios = calculateWalmartTemplateShippingScenarios({
        template: input.template,
        itemPriceCents,
        packageWeightOz: input.packageWeightOz,
        itemQuantity: input.itemQuantity,
      });
    } catch {
      continue;
    }
    const scenarios = shippingScenarios.map((scenario) => ({
      ...scenario,
      economics: calculateWalmartNewSkuEconomics({
        goodsCostCents,
        packagingCostCents,
        shippingLabelCents,
        itemPriceCents,
        customerShippingChargeCents:
          scenario.customer_shipping_charge_cents,
      }),
    }));
    const clearsTarget = scenarios.every((scenario) =>
      scenario.economics.contribution_profit_cents * 10_000 >=
        scenario.economics.customer_total_cents *
          SSCC_WALMART_NEW_SKU_TARGET_MARGIN_BPS
    );
    if (!clearsTarget) continue;
    const shippingCharges = scenarios.map(
      (scenario) => scenario.customer_shipping_charge_cents,
    );
    const customerTotals = scenarios.map(
      (scenario) => scenario.economics.customer_total_cents,
    );
    const margins = scenarios.map(
      (scenario) => scenario.economics.contribution_margin_bps,
    );
    return {
      shipping_template_id: input.template.id,
      shipping_template_name: input.template.name,
      shipping_template_sha256: input.template.template_sha256,
      is_free_shipping: input.template.is_free_shipping,
      item_price_cents: itemPriceCents,
      minimum_customer_shipping_charge_cents: Math.min(...shippingCharges),
      maximum_customer_shipping_charge_cents: Math.max(...shippingCharges),
      minimum_customer_total_cents: Math.min(...customerTotals),
      maximum_customer_total_cents: Math.max(...customerTotals),
      worst_case_contribution_margin_bps: Math.min(...margins),
      scenarios,
    };
  }
  throw new Error(
    `No item price clears the target margin for shipping template ${input.template.id}`,
  );
}

export function walmartNewSkuComparableSignal(input: {
  itemPriceCents: number;
  linearizedComparableCents: number;
}): {
  proposed_to_comparable_ratio_bps: number;
  price_competitiveness_signal: WalmartNewSkuPriceCompetitivenessSignal;
} {
  const itemPriceCents = positiveSafeInteger(
    input.itemPriceCents,
    "itemPriceCents",
  );
  const linearizedComparableCents = positiveSafeInteger(
    input.linearizedComparableCents,
    "linearizedComparableCents",
  );
  const ratioBps = Math.ceil(
    itemPriceCents * 10_000 / linearizedComparableCents,
  );
  return {
    proposed_to_comparable_ratio_bps: ratioBps,
    price_competitiveness_signal: ratioBps <= 10_000
      ? "AT_OR_BELOW_EXACT_COMPARABLE"
      : "ABOVE_EXACT_COMPARABLE_WARNING",
  };
}
