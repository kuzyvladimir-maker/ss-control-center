/**
 * Canonical listing-price resolver.
 *
 * Generic gift bundles keep the configurable Bundle Factory economics model.
 * Genuine Uncrustables passthrough listings use the owner-approved count model
 * from `pricing/cost-model.ts` (unit + cooler + label, 1.5x target, .99 price).
 * Keeping the branch here prevents Studio, promotion, validation, and preview
 * from silently choosing different formulas.
 */

import { referralFee } from "@/lib/economics/fee-tables";
import { priceFor } from "@/lib/pricing/cost-model";
import { isOwnBrandPassthrough, textSaysUncrustables } from "./own-brand";
import {
  computeBundlePrice,
  type BundlePriceInput,
  type BundlePriceResult,
  type PricingModel,
} from "./pricing-config";

export type ListingPricingSource =
  | "UNCRUSTABLES_CANONICAL"
  | "BUNDLE_FACTORY_CONFIG";

export interface ListingPriceInput extends BundlePriceInput {
  brand: string | null;
  /** Any product-identifying text (draft/bundle/variant name). Second identity
   *  net beside the brand field: a null/misspelled brand must never route an
   *  Uncrustables bundle onto the generic markup (the 2026-07 price-above-max
   *  birth bug). */
  title?: string | null;
}

export interface ListingPriceResult extends BundlePriceResult {
  pricing_source: ListingPricingSource;
}

export function computeListingPrice(
  input: ListingPriceInput,
  model: PricingModel,
): ListingPriceResult {
  const base = computeBundlePrice(input, model);
  const unitCount = input.unit_count;
  const uncrustables =
    isOwnBrandPassthrough(input.brand) || textSaysUncrustables(input.title);
  if (!uncrustables) {
    return { ...base, pricing_source: "BUNDLE_FACTORY_CONFIG" };
  }

  // FAIL CLOSED: an Uncrustables bundle must never silently price on the
  // generic markup — that mismatch (generic price ~landed×1.53 vs canonical
  // band 1.3/1.5) birthed the 2026-07 price-above-max cohort that Amazon
  // suppressed. A missing/invalid count is a data bug to surface, not a
  // reason to fall back.
  if (unitCount == null || !Number.isInteger(unitCount) || unitCount <= 0) {
    throw new Error(
      `Uncrustables bundle has no valid unit_count (${String(unitCount)}); ` +
        "cannot price canonically and refusing the generic markup fallback",
    );
  }
  const canonical = priceFor(unitCount);
  if (!canonical) {
    throw new Error(
      `Uncrustables bundle unit_count ${unitCount} has no canonical price; ` +
        "refusing the generic markup fallback",
    );
  }

  const sellingPriceCents = Math.round(canonical.suggested * 100);
  const floorPriceCents = Math.min(
    sellingPriceCents,
    Math.round(canonical.floor * 100),
  );
  const marketplace = input.marketplace ?? "amazon";
  const feeCategory = input.fee_category ?? "grocery_food";
  const referralFeeCents = Math.round(
    referralFee(marketplace, feeCategory, sellingPriceCents / 100) * 100,
  );
  const profitCents =
    sellingPriceCents - base.cost.total_cost_cents - referralFeeCents;
  const roiBase = base.cost.goods_cents + base.cost.packaging_cents;

  return {
    ...base,
    selling_price_cents: sellingPriceCents,
    floor_price_cents: floorPriceCents,
    referral_fee_cents: referralFeeCents,
    referral_pct:
      sellingPriceCents > 0 ? referralFeeCents / sellingPriceCents : 0,
    profit_cents: profitCents,
    margin_pct:
      sellingPriceCents > 0 ? profitCents / sellingPriceCents : 0,
    roi_pct: roiBase > 0 ? profitCents / roiBase : 0,
    pricing_source: "UNCRUSTABLES_CANONICAL",
  };
}
