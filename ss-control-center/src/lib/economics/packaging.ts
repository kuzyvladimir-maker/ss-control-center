// Packaging cost for a listing — cooler + ice + box.
//
// Two important differences from the Uncrustables cost-model (cost-model.ts):
//   1. Cooler is chosen by PRODUCT WEIGHT here (coolerForWeight), not by unit
//      count (cost-model's coolerFor is Uncrustables-specific — left untouched
//      so /pricing keeps working).
//   2. Ice scales with weight: 0.8 × product_weight_lb × $0.10/piece — the same
//      formula SkuCost.iceCost documents — instead of a fixed per-cooler count.
//
// DOUBLE-COUNT GUARD: if the COGS source already includes packaging
// (SkuCost.includesPackaging — true for Sellerboard frozen rows), this returns
// { packaging: 0 } so we never add cooler+ice on top of a cost that already has it.

import type { Cooler } from "@/lib/pricing/cost-model";

/** Cooler shell cost only (no ice, no box) — the breakdown behind cost-model's
 *  bundled PACKAGING constant ($6/$9/$12/$16 + ice + $1 box). */
const COOLER_SHELL: Record<Cooler, number> = { S: 6, M: 9, L: 12, XL: 16 };
const BOX_COST = 1; // cardboard outer for a frozen cooler
const DRY_BOX_COST = 1.5; // plain ambient box, no cooler/ice
const ICE_PER_PIECE = 0.1; // $0.10 per gel-ice piece (1 piece ≈ 1 lb)
const ICE_RATIO = 0.8; // ice weight = 80% of product weight

/** Weight→cooler thresholds (lb). Initial estimate calibrated against the
 *  cost-model ice capacities and the label regression (L ≈ 18 lb); tune as we
 *  learn. A Setting override hook can replace these later without a deploy. */
export function coolerForWeight(weightLb: number): Cooler {
  if (weightLb <= 6) return "S";
  if (weightLb <= 12) return "M";
  if (weightLb <= 18) return "L";
  return "XL";
}

/** Gel-ice cost for a frozen product of the given bare weight. */
export function iceCost(weightLb: number): number {
  if (!Number.isFinite(weightLb) || weightLb <= 0) return 0;
  return Math.round(ICE_RATIO * weightLb * ICE_PER_PIECE * 100) / 100;
}

export interface PackagingResult {
  packaging: number;
  cooler: Cooler | null;
  /** True when we had to guess (missing weight, or COGS already includes pkg). */
  estimated: boolean;
}

/**
 * Packaging cost for one listing.
 *  - includesPackaging → 0 (guard).
 *  - Dry/ambient → a plain box, no cooler/ice.
 *  - Frozen → cooler shell (by weight) + ice (by weight) + box.
 *  - Missing weight on a frozen item → estimate with a Medium cooler + flag.
 */
export function packagingForSku(input: {
  weightLb: number | null;
  includesPackaging: boolean;
  category?: string | null; // "Frozen" | "Dry" | null
}): PackagingResult {
  if (input.includesPackaging) {
    return { packaging: 0, cooler: null, estimated: false };
  }

  const isFrozen = (input.category ?? "").toLowerCase() === "frozen";
  if (!isFrozen) {
    // Dry / ambient (or unknown non-frozen): just a box.
    return { packaging: DRY_BOX_COST, cooler: null, estimated: input.category == null };
  }

  const weight = input.weightLb;
  if (weight == null || !Number.isFinite(weight) || weight <= 0) {
    // Frozen but no usable weight — assume a Medium cooler, flag the estimate.
    const packaging = Math.round((COOLER_SHELL.M + iceCost(9) + BOX_COST) * 100) / 100;
    return { packaging, cooler: "M", estimated: true };
  }

  const cooler = coolerForWeight(weight);
  const packaging =
    Math.round((COOLER_SHELL[cooler] + iceCost(weight) + BOX_COST) * 100) / 100;
  return { packaging, cooler, estimated: false };
}
