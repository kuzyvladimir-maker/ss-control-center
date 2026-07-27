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
  contribution_profit_cents: number;
  contribution_margin_bps: number;
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
  const referralFeeCents = Math.ceil(
    itemPriceCents * SSCC_WALMART_NEW_SKU_REFERRAL_FEE_BPS / 10_000,
  );
  const contributionProfitCents =
    itemPriceCents -
    goodsCostCents -
    packagingCostCents -
    shippingLabelCents -
    referralFeeCents;
  const contributionMarginBps = Math.floor(
    contributionProfitCents * 10_000 / itemPriceCents,
  );
  return {
    goods_cost_cents: goodsCostCents,
    packaging_cost_cents: packagingCostCents,
    shipping_label_cents: shippingLabelCents,
    referral_fee_bps: SSCC_WALMART_NEW_SKU_REFERRAL_FEE_BPS,
    referral_fee_cents: referralFeeCents,
    target_margin_bps: SSCC_WALMART_NEW_SKU_TARGET_MARGIN_BPS,
    item_price_cents: itemPriceCents,
    contribution_profit_cents: contributionProfitCents,
    contribution_margin_bps: contributionMarginBps,
  };
}

export function minimumWalmartNewSkuPriceForTargetMargin(input: {
  goodsCostCents: number;
  packagingCostCents: number;
  shippingLabelCents: number;
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
  const denominatorBps =
    10_000 -
    SSCC_WALMART_NEW_SKU_REFERRAL_FEE_BPS -
    SSCC_WALMART_NEW_SKU_TARGET_MARGIN_BPS;
  let itemPriceCents = Math.ceil(fixedCostCents * 10_000 / denominatorBps);
  for (;;) {
    const economics = calculateWalmartNewSkuEconomics({
      goodsCostCents,
      packagingCostCents,
      shippingLabelCents,
      itemPriceCents,
    });
    if (
      economics.contribution_profit_cents * 10_000 >=
        itemPriceCents * SSCC_WALMART_NEW_SKU_TARGET_MARGIN_BPS
    ) {
      return economics;
    }
    itemPriceCents += 1;
  }
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
