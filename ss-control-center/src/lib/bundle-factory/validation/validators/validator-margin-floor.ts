/**
 * Phase 7 Stage 6 — Validator: margin floor (≥20%).
 *
 * Enforces the Phase 7 pricing rule without ever inventing a price. The
 * SELLING price (`sku.price_cents`) is owned by the economics module — this
 * validator only *checks* it against the persisted all-in cost basis carried
 * on the MasterBundle: sourced goods, packaging, configured fulfillment/closing
 * fees, shipping when baked into the item price, and marketplace referral fee.
 *
 * Outcome design — a SKU only reaches `listing_status` publishable when its
 * validation status is PASSED, and distribution only submits PASSED SKUs, so
 * this validator is the gate that keeps under-margin / un-priced listings off
 * the marketplace:
 *   - price not set yet        → WARNING  (NEEDS_REVIEW, not published) —
 *                                normal while economics fills the price.
 *   - cost basis incomplete    → WARNING  (can't verify the floor honestly).
 *   - margin < 20%             → ERROR    (FAILED, hard-blocked from publish).
 *   - margin ≥ 20%             → PASS.
 */

import type { ValidatorFn } from "../types";
import { referralFee } from "@/lib/economics/fee-tables";
import type { FeeCategory, Marketplace } from "@/lib/economics/types";

/** Hard fallback margin floor, used only when no per-run value and no global
 *  Setting are configured. The real value is a variable resolved per run by
 *  `margin-config.ts` (wizard "target margin %" → Setting → this default) and
 *  threaded in via `ValidatorInput.margin_floor_pct`. */
export const DEFAULT_MARGIN_FLOOR = 0.2;

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export const validatorMarginFloor: ValidatorFn = async ({
  sku,
  master_bundle,
  margin_floor_pct,
}) => {
  const price = sku.price_cents;
  let breakdown: Record<string, unknown> | null = null;
  try {
    const parsed = master_bundle?.cost_breakdown
      ? JSON.parse(master_bundle.cost_breakdown)
      : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      breakdown = parsed as Record<string, unknown>;
    }
  } catch {
    breakdown = null;
  }
  const cents = (key: string): number | null => {
    const value = Number(breakdown?.[key]);
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  };
  const goods = cents("goods_cents") ?? master_bundle?.estimated_cost_cents ?? null;
  const packaging = cents("packaging_cents");
  const fba = cents("fba_cents") ?? 0;
  const closing = cents("closing_cents") ?? 0;
  const shippingInPrice = breakdown?.shipping_in_price === true;
  const shipping = shippingInPrice ? cents("shipping_label_cents") ?? 0 : 0;
  const cost =
    goods != null && goods > 0 && packaging != null
      ? goods + packaging + fba + closing + shipping
      : null;
  // The floor is a per-run variable (wizard → Setting → default), resolved
  // upstream and passed in. Guard against an unset/invalid injected value.
  const floor =
    typeof margin_floor_pct === "number" &&
    margin_floor_pct > 0 &&
    margin_floor_pct < 1
      ? margin_floor_pct
      : DEFAULT_MARGIN_FLOOR;

  // Price comes from the economics module; until it lands we don't block the
  // rest of validation — we just keep the SKU out of PASSED (not publishable).
  if (price == null || price <= 0) {
    return {
      validator_id: "validator-margin-floor",
      passed: false,
      severity: "warning",
      message:
        "Selling price not set — awaiting the economics module (≥20% margin rule). Listing cannot publish until a price is provided.",
      details: { price_cents: price, all_in_cost_cents: cost },
    };
  }

  if (cost == null || cost <= 0) {
    return {
      validator_id: "validator-margin-floor",
      passed: false,
      severity: "warning",
      message:
        "All-in cost basis is incomplete (goods + packaging required) — margin cannot be verified.",
      details: {
        price_cents: price,
        goods_cents: goods,
        packaging_cents: packaging,
      },
    };
  }

  const marketplace: Marketplace = sku.channel === "WALMART" ? "walmart" : "amazon";
  const category: FeeCategory = /HEALTH|BEAUTY/i.test(master_bundle?.category ?? "")
    ? "health_personal_care"
    : /PET/i.test(master_bundle?.category ?? "")
      ? "pet"
      : /FROZEN|REFRIGERATED|SHELF|GROCERY|FOOD/i.test(master_bundle?.category ?? "")
        ? "grocery_food"
        : "other";
  const referralFeeCents = Math.round(
    referralFee(marketplace, category, price / 100) * 100,
  );
  const profitCents = price - cost - referralFeeCents;
  const marginPct = profitCents / price;
  if (marginPct < floor) {
    return {
      validator_id: "validator-margin-floor",
      passed: false,
      severity: "error",
      message: `All-in margin ${(marginPct * 100).toFixed(1)}% is below the ${(floor * 100).toFixed(0)}% target (price ${dollars(price)}, costs ${dollars(cost)}, referral ${dollars(referralFeeCents)}).`,
      details: {
        price_cents: price,
        all_in_cost_cents: cost,
        referral_fee_cents: referralFeeCents,
        profit_cents: profitCents,
        margin_pct: marginPct,
        floor_pct: floor,
      },
    };
  }

  return {
    validator_id: "validator-margin-floor",
    passed: true,
    details: {
      price_cents: price,
      all_in_cost_cents: cost,
      referral_fee_cents: referralFeeCents,
      profit_cents: profitCents,
      margin_pct: marginPct,
      floor_pct: floor,
    },
  };
};
