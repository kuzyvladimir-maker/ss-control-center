// Uncrustables SHIP-SPEC bands — the operator packaging convention of the
// live cohort: S 12x12x10 in / 160 oz, M 13x13x15 in / 256 oz,
// XL 24x13x16 in / 544 oz. Extracted verbatim from
// scripts/_publish_batch12_stage1.ts (bandFor); the script remains the
// fallback operator path.
//
// These are SHIP-SPEC bands: the declared physical package dimensions and
// weight written onto MasterBundle.packaging_spec and the ChannelSKU
// package_* fields for a given sandwich count. They are DISTINCT from the
// box-planner's rational count bands (RATIONAL_COUNT_BANDS in
// uncrustables-box-planner.ts), which gate which totals are plannable.
// The thresholds here intentionally cover every count (<=30 / <=60 / above)
// so that any promoted recipe gets a spec.

export type UncrustablesShipSpecBand = {
  weight_oz: number;
  length_in: number;
  width_in: number;
  height_in: number;
};

/** Ship-spec band for a total sandwich count (live-cohort convention). */
export function shipSpecBandFor(count: number): UncrustablesShipSpecBand {
  if (count <= 30) return { weight_oz: 160, length_in: 12, width_in: 12, height_in: 10 };
  if (count <= 60) return { weight_oz: 256, length_in: 13, width_in: 13, height_in: 15 };
  return { weight_oz: 544, length_in: 24, width_in: 13, height_in: 16 };
}
