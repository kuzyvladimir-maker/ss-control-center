/**
 * Bundle Factory — automatic retail pricing model + cost-buildup calculator.
 *
 * Vladimir's directive (2026-06-26): the factory must price listings
 * AUTOMATICALLY. The operator only configures the pricing model up front; the
 * algorithm sets every listing's selling price. No manual price entry per
 * listing.
 *
 * 2026-06-30 upgrade (Vladimir): the naive `COGS × markup` was not enough. A
 * frozen gift set has a real cost buildup — goods + styrofoam cooler + gel ice
 * + cardboard box + marketplace referral fee + FBA/closing fees + our outbound
 * label — and the price must be solved so a target MARGIN survives all of it
 * (like the ChannelMax calculator). We reuse the Economics module (Phase 7) for
 * the packaging + referral-fee math so the factory and the /economics page stay
 * on ONE cost model.
 *
 * Two levers (operator picks one, configured once, applies to every listing):
 *   - "margin": solve price so `profit / revenue ≥ target_margin_pct` AFTER the
 *     referral fee and all costs.  price = totalCost / (1 − referral − margin)
 *   - "markup": price = totalLandedCost × markup   (ROI multiple)
 * Both are then floored at `min_price_cents`.
 *
 * The model is resolved with the same 3-tier pattern as margin-config:
 *   per-run override → global Setting → hard default.
 */

import { prisma } from "@/lib/prisma";
import { type Cooler, LABEL as UNCRUSTABLES_LABEL } from "@/lib/pricing/cost-model";
import type { Marketplace, FeeCategory } from "@/lib/economics/types";
import {
  COOLER_SHELL,
  BOX_COST,
  DRY_BOX_COST,
  iceCost,
  coolerForWeight,
} from "@/lib/economics/packaging";
import { referralFee } from "@/lib/economics/fee-tables";

export type PricingMode = "margin" | "markup";

/** Cost-plus multiple over TOTAL landed cost (goods + packaging + fees). 3.0. */
export const DEFAULT_PRICING_MARKUP = 3.0;
/** Target margin kept after ALL costs + referral fee (fraction of revenue). */
export const DEFAULT_TARGET_MARGIN_PCT = 0.35;
/** Which lever drives the price by default. Margin = the real calculator. */
export const DEFAULT_PRICING_MODE: PricingMode = "margin";
/** Floor so tiny-COGS (or unknown-COGS) bundles still get a sane price. */
export const DEFAULT_MIN_PRICE_CENTS = 999; // $9.99
/** Amazon fulfillment fee estimate per unit — 0 for MFN/self-ship (our case). */
export const DEFAULT_FBA_FEE_CENTS = 0;
/** Variable closing fee — 0 for grocery (applies to media). */
export const DEFAULT_CLOSING_FEE_CENTS = 0;
/** Our outbound label estimate for DRY/ambient bundles — operator sets globally.
 *  Frozen bundles auto-fill the label from the cooler size (see LABEL_CENTS). */
export const DEFAULT_OWN_SHIPPING_CENTS = 0;

/** Outbound shipping-label cost per cooler size, in cents. Calibrated from real
 *  Veeqo shipment history (2026-06-15) — same source as cost-model.ts LABEL
 *  ($20/$32/$45/$60). Frozen bundles ship in a cooler, so the label cost is
 *  driven by the cooler the weight selects, not a flat guess. */
export const FROZEN_LABEL_CENTS: Record<Cooler, number> = {
  S: Math.round(UNCRUSTABLES_LABEL.S * 100),
  M: Math.round(UNCRUSTABLES_LABEL.M * 100),
  L: Math.round(UNCRUSTABLES_LABEL.L * 100),
  XL: Math.round(UNCRUSTABLES_LABEL.XL * 100),
};

export const PRICING_MARKUP_SETTING_KEY = "bundle_pricing_markup";
export const PRICING_MIN_PRICE_SETTING_KEY = "bundle_pricing_min_price_cents";
export const PRICING_MODE_SETTING_KEY = "bundle_pricing_mode";
export const PRICING_TARGET_MARGIN_SETTING_KEY = "bundle_pricing_target_margin_pct";
export const PRICING_FBA_FEE_SETTING_KEY = "bundle_pricing_fba_fee_cents";
export const PRICING_CLOSING_FEE_SETTING_KEY = "bundle_pricing_closing_fee_cents";
export const PRICING_OWN_SHIPPING_SETTING_KEY = "bundle_pricing_own_shipping_cents";
export const PRICING_REFERRAL_PCT_SETTING_KEY = "bundle_pricing_referral_pct";

/** Accept a markup as a plain multiple (3 or 3.0). Reject non-positive / NaN. */
function normalizeMarkup(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  // A markup below 1.0 would price below cost — treat as misconfiguration.
  return raw < 1 ? null : Math.round(raw * 1000) / 1000;
}

function normalizeCents(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw);
}

/** A fraction in [0, 0.95). Null on out-of-range / NaN. */
function normalizePct(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw < 0 || raw >= 0.95) return null;
  return Math.round(raw * 10000) / 10000;
}

export interface PricingModel {
  mode: PricingMode;
  markup: number;
  target_margin_pct: number;
  min_price_cents: number;
  fba_fee_cents: number;
  closing_fee_cents: number;
  own_shipping_cents: number;
  /** Flat referral override (fraction). null → use the tiered fee-tables. */
  referral_pct_override: number | null;
}

/** Resolve the active pricing model (override → Setting → default). */
export async function getPricingModel(
  markupOverride?: number | null,
): Promise<PricingModel> {
  const keys = [
    PRICING_MARKUP_SETTING_KEY,
    PRICING_MIN_PRICE_SETTING_KEY,
    PRICING_MODE_SETTING_KEY,
    PRICING_TARGET_MARGIN_SETTING_KEY,
    PRICING_FBA_FEE_SETTING_KEY,
    PRICING_CLOSING_FEE_SETTING_KEY,
    PRICING_OWN_SHIPPING_SETTING_KEY,
    PRICING_REFERRAL_PCT_SETTING_KEY,
  ];
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const get = (k: string): string | undefined =>
    rows.find((r) => r.key === k)?.value;

  const markup =
    normalizeMarkup(markupOverride ?? null) ??
    normalizeMarkup(numOrNull(get(PRICING_MARKUP_SETTING_KEY))) ??
    DEFAULT_PRICING_MARKUP;

  const modeRaw = get(PRICING_MODE_SETTING_KEY);
  const mode: PricingMode = modeRaw === "markup" ? "markup" : DEFAULT_PRICING_MODE;

  const referralOverride = normalizePct(numOrNull(get(PRICING_REFERRAL_PCT_SETTING_KEY)));

  return {
    mode,
    markup,
    target_margin_pct:
      normalizePct(numOrNull(get(PRICING_TARGET_MARGIN_SETTING_KEY))) ??
      DEFAULT_TARGET_MARGIN_PCT,
    min_price_cents:
      normalizeCents(numOrNull(get(PRICING_MIN_PRICE_SETTING_KEY))) ??
      DEFAULT_MIN_PRICE_CENTS,
    fba_fee_cents:
      normalizeCents(numOrNull(get(PRICING_FBA_FEE_SETTING_KEY))) ??
      DEFAULT_FBA_FEE_CENTS,
    closing_fee_cents:
      normalizeCents(numOrNull(get(PRICING_CLOSING_FEE_SETTING_KEY))) ??
      DEFAULT_CLOSING_FEE_CENTS,
    own_shipping_cents:
      normalizeCents(numOrNull(get(PRICING_OWN_SHIPPING_SETTING_KEY))) ??
      DEFAULT_OWN_SHIPPING_CENTS,
    referral_pct_override: referralOverride,
  };
}

function numOrNull(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── The cost-buildup calculator ─────────────────────────────────────────────

export interface BundlePriceInput {
  /** Goods cost for the WHOLE bundle (pack_count × donor unit price), cents. */
  cogs_cents: number;
  /** Bundle weight in lb (for cooler/ice sizing). null → estimate (flagged). */
  weight_lb: number | null;
  /** Bundle category — FROZEN / REFRIGERATED → cold packaging; else dry box. */
  category: string | null;
  marketplace?: Marketplace; // default amazon
  fee_category?: FeeCategory; // default grocery_food (all our bundles are food)
}

export interface BundlePriceResult {
  selling_price_cents: number;
  mode: PricingMode;
  cooler_size: Cooler | null;
  /** true when weight was missing and packaging was estimated. */
  packaging_estimated: boolean;
  /** true when the shipping label was auto-filled from the cooler size (frozen);
   *  false when it came from the flat global own_shipping (dry, or override). */
  shipping_auto: boolean;
  cost: {
    goods_cents: number;
    cooler_cents: number;
    ice_cents: number;
    box_cents: number;
    packaging_cents: number; // cooler + ice + box
    fba_cents: number;
    closing_cents: number;
    own_shipping_cents: number;
    /** All non-referral costs (goods + packaging + fba + closing + own_shipping). */
    total_cost_cents: number;
  };
  referral_pct: number; // effective rate at the final price
  referral_fee_cents: number;
  profit_cents: number;
  margin_pct: number; // profit / selling_price
}

function isColdCategory(category: string | null | undefined): boolean {
  return /FROZEN|REFRIGERATED|COLD/i.test(category ?? "");
}

/**
 * Solve the selling price from the full cost buildup + the pricing model.
 * Pure (no I/O) so it's testable and reusable by the preview, promote-draft and
 * any future repricer. Reuses the Economics packaging + referral-fee model.
 */
export function computeBundlePrice(
  input: BundlePriceInput,
  model: PricingModel,
): BundlePriceResult {
  const marketplace: Marketplace = input.marketplace ?? "amazon";
  const feeCategory: FeeCategory = input.fee_category ?? "grocery_food";
  const cold = isColdCategory(input.category);

  // Packaging breakdown (dollars → cents).
  let cooler: Cooler | null = null;
  let coolerDollars = 0;
  let iceDollars = 0;
  let boxDollars = 0;
  let estimated = false;

  if (cold) {
    const w = input.weight_lb;
    if (w != null && Number.isFinite(w) && w > 0) {
      cooler = coolerForWeight(w);
      coolerDollars = COOLER_SHELL[cooler];
      iceDollars = iceCost(w);
    } else {
      // Frozen but no usable weight — assume a Medium cooler, flag the estimate.
      cooler = "M";
      coolerDollars = COOLER_SHELL.M;
      iceDollars = iceCost(9);
      estimated = true;
    }
    boxDollars = BOX_COST;
  } else {
    // Dry / ambient: a plain box, no cooler / ice.
    boxDollars = DRY_BOX_COST;
    estimated = input.category == null;
  }

  const cooler_cents = Math.round(coolerDollars * 100);
  const ice_cents = Math.round(iceDollars * 100);
  const box_cents = Math.round(boxDollars * 100);
  const packaging_cents = cooler_cents + ice_cents + box_cents;

  const goods_cents = Math.max(0, Math.round(input.cogs_cents || 0));
  const fba_cents = Math.max(0, Math.round(model.fba_fee_cents || 0));
  const closing_cents = Math.max(0, Math.round(model.closing_fee_cents || 0));

  // Outbound shipping label. FROZEN bundles ship in a cooler, so the label is
  // driven by the cooler size (calibrated per-cooler averages) — auto, unless
  // the operator pinned a global override (>0). DRY/ambient uses the flat global.
  const globalShip = Math.max(0, Math.round(model.own_shipping_cents || 0));
  const shipping_auto = cold && cooler != null && globalShip === 0;
  const own_shipping_cents = shipping_auto
    ? FROZEN_LABEL_CENTS[cooler as Cooler]
    : globalShip;

  const total_cost_cents =
    goods_cents + packaging_cents + fba_cents + closing_cents + own_shipping_cents;

  // Referral rate used to SOLVE the price. Our bundles list well above the $15
  // Amazon-grocery tier boundary, so the high tier (0.15) is the right solving
  // rate; the operator can pin a flat override. We recompute the ACTUAL tiered
  // fee at the solved price below for display + margin.
  const solveReferral =
    model.referral_pct_override != null ? model.referral_pct_override : 0.15;

  let priceCents: number;
  if (model.mode === "markup") {
    priceCents = Math.ceil(total_cost_cents * model.markup);
  } else {
    // margin mode: price = totalCost / (1 − referral − targetMargin)
    const denom = Math.max(0.05, 1 - solveReferral - model.target_margin_pct);
    priceCents = Math.ceil(total_cost_cents / denom);
  }

  const selling_price_cents = Math.max(model.min_price_cents, priceCents);

  // Actual tiered referral at the final price.
  const referral_fee_cents = Math.round(
    referralFee(marketplace, feeCategory, selling_price_cents / 100) * 100,
  );
  const referral_pct =
    selling_price_cents > 0 ? referral_fee_cents / selling_price_cents : 0;

  const profit_cents = selling_price_cents - total_cost_cents - referral_fee_cents;
  const margin_pct =
    selling_price_cents > 0 ? profit_cents / selling_price_cents : 0;

  return {
    selling_price_cents,
    mode: model.mode,
    cooler_size: cooler,
    packaging_estimated: estimated,
    shipping_auto,
    cost: {
      goods_cents,
      cooler_cents,
      ice_cents,
      box_cents,
      packaging_cents,
      fba_cents,
      closing_cents,
      own_shipping_cents,
      total_cost_cents,
    },
    referral_pct,
    referral_fee_cents,
    profit_cents,
    margin_pct,
  };
}

/**
 * LEGACY cost-plus price (goods × markup, floored). Kept for callers/tests that
 * don't have weight/category. New callers should use computeBundlePrice, which
 * accounts for packaging + fees + the target margin.
 */
export function computeListingPriceCents(
  cogsCents: number,
  model: PricingModel,
): number {
  const fromCost = cogsCents > 0 ? Math.ceil(cogsCents * model.markup) : 0;
  return Math.max(model.min_price_cents, fromCost);
}
