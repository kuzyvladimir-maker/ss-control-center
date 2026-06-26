/**
 * Bundle Factory — automatic retail pricing model.
 *
 * Vladimir's directive (2026-06-26): the factory must price listings
 * AUTOMATICALLY. The operator only configures the pricing model up front; the
 * algorithm sets every listing's selling price from the bundle's goods cost
 * (COGS). No manual price entry per listing.
 *
 * The model is a simple cost-plus markup, resolved with the same 3-tier
 * pattern as margin-config:
 *   1. per-run override  — a future wizard "markup ×" field, highest priority;
 *   2. global default    — Setting `bundle_pricing_markup`;
 *   3. hard fallback     — DEFAULT_PRICING_MARKUP.
 *
 * price = max( min_price, ceil(cogs_cents × markup) )
 *
 * The result is fed into ChannelSKU.price_cents by promote-draft, which is the
 * number validator-margin-floor checks. Because the markup (3×) sits far above
 * the 20% margin floor, an auto-priced SKU clears the floor and reaches PASSED
 * — so the Publish button appears without manual price entry.
 */

import { prisma } from "@/lib/prisma";

/** Cost-plus multiple over COGS. 3.0 → a $4 bundle of goods lists at $12. */
export const DEFAULT_PRICING_MARKUP = 3.0;

/** Floor so tiny-COGS (or unknown-COGS) bundles still get a sane price. */
export const DEFAULT_MIN_PRICE_CENTS = 999; // $9.99

export const PRICING_MARKUP_SETTING_KEY = "bundle_pricing_markup";
export const PRICING_MIN_PRICE_SETTING_KEY = "bundle_pricing_min_price_cents";

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

export interface PricingModel {
  markup: number;
  min_price_cents: number;
}

/** Resolve the active pricing model (override → Setting → default). */
export async function getPricingModel(
  markupOverride?: number | null,
): Promise<PricingModel> {
  let markup = normalizeMarkup(markupOverride ?? null);
  let minPrice: number | null = null;

  if (markup == null) {
    const row = await prisma.setting.findUnique({
      where: { key: PRICING_MARKUP_SETTING_KEY },
    });
    markup = normalizeMarkup(row ? Number(row.value) : null);
  }
  const minRow = await prisma.setting.findUnique({
    where: { key: PRICING_MIN_PRICE_SETTING_KEY },
  });
  minPrice = normalizeCents(minRow ? Number(minRow.value) : null);

  return {
    markup: markup ?? DEFAULT_PRICING_MARKUP,
    min_price_cents: minPrice ?? DEFAULT_MIN_PRICE_CENTS,
  };
}

/**
 * Compute the auto retail price for a bundle from its goods cost.
 * `cogsCents` ≤ 0 (unknown cost) falls back to the model's min price.
 */
export function computeListingPriceCents(
  cogsCents: number,
  model: PricingModel,
): number {
  const fromCost =
    cogsCents > 0 ? Math.ceil(cogsCents * model.markup) : 0;
  return Math.max(model.min_price_cents, fromCost);
}
