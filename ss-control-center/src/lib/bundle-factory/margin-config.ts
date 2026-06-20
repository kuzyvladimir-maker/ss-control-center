/**
 * Phase 7 — configurable target margin for new listings.
 *
 * The margin floor is NOT a fixed 20%. It is a variable the operator sets when
 * forming listings:
 *   1. per-run override  — the wizard's "target margin %" field
 *                          (StudioRunConfig.target_margin_pct), highest priority;
 *   2. global default    — Setting `bundle_margin_floor_pct`;
 *   3. hard fallback     — DEFAULT_MARGIN_FLOOR (only if nothing is configured).
 *
 * validator-margin-floor checks the SKU's price (from the economics module)
 * against the resolved value. This module is the single resolver so the wizard,
 * the validator, and any future repricer all read the same number.
 */

import { prisma } from "@/lib/prisma";
import { DEFAULT_MARGIN_FLOOR } from "./validation/validators/validator-margin-floor";

/** Setting key for the global default margin floor. Stored as a fraction
 *  (e.g. "0.18") or a percent (e.g. "18") — both are accepted. */
export const MARGIN_FLOOR_SETTING_KEY = "bundle_margin_floor_pct";

export { DEFAULT_MARGIN_FLOOR };

/**
 * Normalize a margin value to a fraction in (0,1). Accepts either a fraction
 * (0.18) or a percent (18). Returns null when the input is missing/invalid so
 * callers can fall through to the next source.
 */
export function normalizeMarginPct(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  const frac = raw > 1 ? raw / 100 : raw; // 18 → 0.18 ; 0.18 → 0.18
  if (frac <= 0 || frac >= 1) return null;
  return Math.round(frac * 10000) / 10000;
}

/**
 * Resolve the target margin floor (fraction 0-1) for a run. `override` is the
 * wizard's per-run value; falls back to the global Setting, then the default.
 */
export async function getMarginFloorPct(
  override?: number | null,
): Promise<number> {
  const fromOverride = normalizeMarginPct(override ?? null);
  if (fromOverride != null) return fromOverride;

  const row = await prisma.setting.findUnique({
    where: { key: MARGIN_FLOOR_SETTING_KEY },
  });
  const fromSetting = normalizeMarginPct(row ? Number(row.value) : null);
  return fromSetting ?? DEFAULT_MARGIN_FLOOR;
}
