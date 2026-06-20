/**
 * Phase 7 Stage 6 — Validator: margin floor (≥20%).
 *
 * Enforces the Phase 7 pricing rule without ever inventing a price. The
 * SELLING price (`sku.price_cents`) is owned by the economics module — this
 * validator only *checks* it against the real COGS basis carried on the
 * MasterBundle (`estimated_cost_cents`, derived from the donor's first-party
 * sourcing cost in donor-pool.ts).
 *
 * Outcome design — a SKU only reaches `listing_status` publishable when its
 * validation status is PASSED, and distribution only submits PASSED SKUs, so
 * this validator is the gate that keeps under-margin / un-priced listings off
 * the marketplace:
 *   - price not set yet        → WARNING  (NEEDS_REVIEW, not published) —
 *                                normal while economics fills the price.
 *   - COGS basis unknown       → WARNING  (can't verify the floor honestly).
 *   - margin < 20%             → ERROR    (FAILED, hard-blocked from publish).
 *   - margin ≥ 20%             → PASS.
 */

import type { ValidatorFn } from "../types";

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
  const cost = master_bundle?.estimated_cost_cents ?? null;
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
      details: { price_cents: price, cost_cents: cost },
    };
  }

  if (cost == null || cost <= 0) {
    return {
      validator_id: "validator-margin-floor",
      passed: false,
      severity: "warning",
      message:
        "COGS basis unknown for this bundle — cannot verify the 20% margin floor. Check the donor sourcing cost.",
      details: { price_cents: price, cost_cents: cost },
    };
  }

  const marginPct = (price - cost) / price;
  if (marginPct < floor) {
    return {
      validator_id: "validator-margin-floor",
      passed: false,
      severity: "error",
      message: `Margin ${(marginPct * 100).toFixed(1)}% is below the ${(floor * 100).toFixed(0)}% target (price ${dollars(price)} vs COGS ${dollars(cost)}). Adjust the price in the economics module.`,
      details: {
        price_cents: price,
        cost_cents: cost,
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
      cost_cents: cost,
      margin_pct: marginPct,
      floor_pct: floor,
    },
  };
};
