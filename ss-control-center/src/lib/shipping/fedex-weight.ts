/**
 * FedEx One Rate declared-weight rule — ONE place for the multiplier.
 *
 * One Rate labels must carry a heavier declared weight than the catalog
 * figure: +20% (Vladimir 2026-06-09; MASTER_PROMPT §4). The buy route pushes
 * `weight × 1.20` to Veeqo before re-quoting a One Rate label. Older code
 * stored `weightFedex = weight × 1.25` in the catalog (a stale formula from
 * MASTER_PROMPT v3.1); every writer now derives it from here so the stored
 * figure and the bought label agree.
 *
 * Pure: no I/O.
 */

/** +20% declared weight for FedEx One Rate labels. */
export const FEDEX_ONE_RATE_WEIGHT_MULT = 1.2;

/** True when a service title / name is a FedEx One Rate service
 *  (Veeqo names them "FedEx 2Day® One Rate", "Fedex Standard Overnight One Rate", …). */
export function isFedexOneRateService(
  titleOrName: string | null | undefined,
): boolean {
  return String(titleOrName ?? "").toLowerCase().includes("one rate");
}

/** Catalog weight (lbs) → FedEx One Rate declared weight (lbs), rounded to cents of a pound. */
export function computeFedexWeight(weightLbs: number): number {
  return Math.round(weightLbs * FEDEX_ONE_RATE_WEIGHT_MULT * 100) / 100;
}
