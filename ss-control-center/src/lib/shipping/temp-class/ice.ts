// Cooler sizes and gel-ice math for the temperature-aware rate engine.
//
// Cooler size == the box-preset label the operator already picks for the order
// (XS / S / M / L / XL — see src/lib/shipping/box-presets.ts). Each cooler
// holds a BASE number of ice pieces that ship with every frozen/chilled order,
// and can take a fixed number of EXTRA pieces on top when a longer transit or
// hot weather needs them.
//
// Owner (Vladimir), topic 135, 2026-10-23:
//   base pieces:  XS 3, S 5, M 9, L 11, XL 19
//   extra fits:   XS 0, S 0, M +2, L +1, XL +4   (the old 40%/80% ice steps
//                                                  are CANCELLED)
// The base counts match the packaging cost model already in the repo
// (src/lib/pricing/cost-model.ts PACKAGING comments: S 5 / M 9 / L 11 / XL 19).

export type CoolerSize = "XS" | "S" | "M" | "L" | "XL";

export const COOLER_SIZES: readonly CoolerSize[] = ["XS", "S", "M", "L", "XL"];

/** Ice pieces that ship with EVERY frozen/chilled order of this size. */
export const ICE_BASE: Record<CoolerSize, number> = {
  XS: 3,
  S: 5,
  M: 9,
  L: 11,
  XL: 19,
};

/**
 * Extra ice pieces that physically fit ABOVE the base — the only amount the
 * engine may add. XS/S are 0 (already full at base), so they can never take an
 * ice-dependent longer transit (this is what forces the XS/S short window).
 */
export const ICE_EXTRA_CAPACITY: Record<CoolerSize, number> = {
  XS: 0,
  S: 0,
  M: 2,
  L: 1,
  XL: 4,
};

/** Per-cube gel-ice cost (owner 2026-10-23: $0.10 / piece). */
export const ICE_UNIT_COST_USD = 0.1;

/** ~1 lb of label weight per extra ice piece, so the carrier doesn't bill an
 *  overweight on top of our declared box weight. Base ice is already inside the
 *  SKU's stored shipping weight; only the EXTRA pieces are added here. */
export const ICE_WEIGHT_PER_PIECE_LB = 1;

/** Normalise a stored box label ("XL", "m", "7×7×6"…) to a CoolerSize, or null
 *  when it isn't one of the five named coolers (custom dimension strings have
 *  no ice profile). */
export function coolerSizeFromBox(
  boxSize: string | null | undefined,
): CoolerSize | null {
  const s = (boxSize ?? "").trim().toUpperCase();
  return (COOLER_SIZES as readonly string[]).includes(s)
    ? (s as CoolerSize)
    : null;
}

/** Can this cooler physically take `pieces` extra ice above base? */
export function canFitExtraIce(size: CoolerSize, pieces: number): boolean {
  return pieces <= ICE_EXTRA_CAPACITY[size];
}

export interface IcePlan {
  size: CoolerSize;
  base: number;
  extra: number;
  total: number;
  /** Extra weight to add to the carrier label (lb). */
  weightDeltaLb: number;
  /** Cost of the extra ice only (base is already in the costed packaging). */
  extraCostUsd: number;
}

/** Build the ice plan for a size given a chosen number of extra pieces. The
 *  extra is clamped to what fits (defence-in-depth — the days table should
 *  never request more than fits). */
export function buildIcePlan(size: CoolerSize, extra: number): IcePlan {
  const safeExtra = Math.max(0, Math.min(extra, ICE_EXTRA_CAPACITY[size]));
  const base = ICE_BASE[size];
  return {
    size,
    base,
    extra: safeExtra,
    total: base + safeExtra,
    weightDeltaLb: safeExtra * ICE_WEIGHT_PER_PIECE_LB,
    extraCostUsd: safeExtra * ICE_UNIT_COST_USD,
  };
}

/**
 * Extra-ice marker the plan writes into a live plan item's notes ("[ice +N]")
 * and the buy route turns into the warehouse note. 0 when absent.
 */
export function iceMarker(extra: number): string {
  return extra > 0 ? `[ice +${extra}]` : "";
}

export function iceExtraFromNotes(notes: string | null | undefined): number {
  const m = /\[ice \+(\d+)\]/.exec(notes ?? "");
  return m ? Number(m[1]) : 0;
}
