// The days-allowed + ice table — how long a package of a given class/size may
// spend in transit for the forecast weather, and how much extra ice that
// requires.
//
// Owner-approved design (Vladimir, topic 135, 2026-10-23):
// docs/wiki/frozen-weather-rate-selection-plan-2026-10-23.md §3. All
// temperatures are °C. Two weather inputs (see weather.ts):
//   A — daily max in Clearwater on the ship day and the day after (origin heat
//       for the first ~36 h, when the cold must hold).
//   M — max of the daily highs at the route midpoint and the destination over
//       the remaining transit days (the route heat).
//
// This module is PURE: no DB, no network, no clock. Inputs → {allowedDays,
// extraIce}. It is the one place that encodes the food-safety window, so it is
// covered cell-by-cell in the tests.

import type { TempClass } from "./classes";
import {
  type CoolerSize,
  ICE_EXTRA_CAPACITY,
} from "./ice";

export interface WeatherForClass {
  /** Clearwater origin max (ship day & next), °C. null = unknown. */
  originMaxC: number | null;
  /** Route max (midpoint + destination over remaining transit), °C. null = unknown. */
  routeMaxC: number | null;
}

export interface DaysResult {
  /** Calendar days in transit the cold chain allows. Infinity for DRY (no
   *  cold-chain limit — only the marketplace deadline gates it). */
  allowedDays: number;
  /** Extra ice pieces (above the size's base) this window requires. */
  extraIce: number;
  /** Short human trace of which rule produced the number (for the card). */
  reason: string;
}

// ── Route bands (M) ──
type Band = "HOT" | "WARM" | "COOL" | "COLD" | "FRIGID";

function routeBand(mC: number): Band {
  if (mC > 20) return "HOT";
  if (mC > 10) return "WARM";
  if (mC > 0) return "COOL";
  if (mC > -5) return "COLD";
  return "FRIGID";
}

// A frozen cell is either a flat day count (no extra ice) or an ice-extendable
// cell: `iceDays` when the size can take its extra ice, else `noIceDays`.
type FrozenCell =
  | { kind: "flat"; days: number }
  | { kind: "ice"; iceDays: number; noIceDays: number; coldAOnly?: boolean };

// FROZEN table, Clearwater A ≤ 25 °C (hot-origin override applied separately).
// Mirrors §3 of the plan doc; the per-size extra-ice AMOUNT is the fixed owner
// value (M +2, L +1, XL +4) via ICE_EXTRA_CAPACITY, so an ice cell tops the
// cooler off to capacity.
const FROZEN: Record<Band, Record<CoolerSize, FrozenCell>> = {
  HOT: {
    XS: { kind: "flat", days: 2 },
    S: { kind: "flat", days: 2 },
    M: { kind: "flat", days: 2 },
    L: { kind: "flat", days: 2 },
    XL: { kind: "flat", days: 2 },
  },
  WARM: {
    XS: { kind: "flat", days: 2 },
    S: { kind: "flat", days: 2 },
    M: { kind: "ice", iceDays: 3, noIceDays: 2 },
    L: { kind: "ice", iceDays: 3, noIceDays: 2 },
    XL: { kind: "ice", iceDays: 3, noIceDays: 2 },
  },
  COOL: {
    XS: { kind: "flat", days: 3 },
    S: { kind: "flat", days: 3 },
    M: { kind: "ice", iceDays: 4, noIceDays: 3 },
    L: { kind: "flat", days: 3 },
    XL: { kind: "ice", iceDays: 4, noIceDays: 3 },
  },
  COLD: {
    XS: { kind: "flat", days: 3 },
    S: { kind: "flat", days: 3 },
    // 4 days normally; 5 with extra ice only when Clearwater is also cold (A < 15 °C).
    M: { kind: "ice", iceDays: 5, noIceDays: 4, coldAOnly: true },
    L: { kind: "flat", days: 4 },
    XL: { kind: "ice", iceDays: 5, noIceDays: 4 },
  },
  FRIGID: {
    XS: { kind: "flat", days: 3 },
    S: { kind: "flat", days: 3 },
    M: { kind: "ice", iceDays: 5, noIceDays: 4, coldAOnly: true },
    L: { kind: "flat", days: 4 },
    XL: { kind: "ice", iceDays: 5, noIceDays: 4 },
  },
};

const XS_S_CAP = 3; // XS/S never ship more than 3 days (owner, 2026-10-23).
const CHILLED_CAP = 5; // chilled window never exceeds 5 days.

// Resolve a frozen cell to {days, extraIce} for a size, honouring the A<15
// condition and the ice-availability rule ("unavailable ice → cell without
// ice").
function resolveFrozenCell(
  cell: FrozenCell,
  size: CoolerSize,
  originMaxC: number | null,
): { days: number; extraIce: number } {
  if (cell.kind === "flat") return { days: cell.days, extraIce: 0 };
  // Ice-extendable cell.
  const capacity = ICE_EXTRA_CAPACITY[size];
  // The cold-A-only extension (M in COLD/FRIGID) needs Clearwater < 15 °C.
  const coldAOk = !cell.coldAOnly || (originMaxC != null && originMaxC < 15);
  if (capacity > 0 && coldAOk) {
    return { days: cell.iceDays, extraIce: capacity };
  }
  // Ice can't be added (size full at base) or the A condition isn't met →
  // fall back to the no-ice day count.
  return { days: cell.noIceDays, extraIce: 0 };
}

/**
 * Allowed transit days + required extra ice for a line's class, cooler size and
 * forecast weather.
 *
 * `hasIncident` — this SKU has a prior warm/spoiled complaint; subtract one day
 * (min 1). For CHILLED the caller should pass false for "arrived thawed"
 * complaints (not an incident for chilled).
 *
 * When weather is unknown (null inputs) the engine returns allowedDays = NaN so
 * the caller falls back to the summer profile instead of guessing a window.
 */
export function allowedDays(args: {
  tempClass: TempClass;
  size: CoolerSize;
  weather: WeatherForClass;
  hasIncident?: boolean;
}): DaysResult {
  const { tempClass, size, weather, hasIncident } = args;

  if (tempClass === "DRY") {
    return { allowedDays: Infinity, extraIce: 0, reason: "dry · no cold chain" };
  }

  const { originMaxC, routeMaxC } = weather;
  if (originMaxC == null || routeMaxC == null) {
    return {
      allowedDays: NaN,
      extraIce: 0,
      reason: "no forecast → fall back to summer profile",
    };
  }

  const band = routeBand(routeMaxC);

  // FROZEN base resolution.
  let { days, extraIce } = resolveFrozenCell(FROZEN[band][size], size, originMaxC);
  let reason = `frozen ${band.toLowerCase()} M${routeMaxC.toFixed(0)}/A${originMaxC.toFixed(0)} → ${days}d`;

  // CHILLED: +1 day (cap 5), then the heat overrides.
  if (tempClass === "CHILLED") {
    days = Math.min(days + 1, CHILLED_CAP);
    extraIce = 0;
    reason = `chilled ${band.toLowerCase()} +1 → ${days}d (cap ${CHILLED_CAP})`;
    if (routeMaxC > 20) {
      // Heat: 3 days, only WITH +1 ice. No capacity → fall to 2 days, no ice.
      if (ICE_EXTRA_CAPACITY[size] >= 1) {
        days = 3;
        extraIce = 1;
        reason = `chilled heat M${routeMaxC.toFixed(0)} → 3d with +1 ice`;
      } else {
        days = 2;
        extraIce = 0;
        reason = `chilled heat, ${size} can't take ice → 2d`;
      }
    }
    if (originMaxC > 30 && routeMaxC > 25) {
      // Extreme heat at both ends → 2 days.
      days = 2;
      extraIce = ICE_EXTRA_CAPACITY[size] >= 1 ? 1 : 0;
      reason = `chilled extreme heat A${originMaxC.toFixed(0)}/M${routeMaxC.toFixed(0)} → 2d`;
    }
  }

  // Hot Clearwater override (FROZEN & CHILLED): origin > 25 °C caps the window.
  if (originMaxC > 25) {
    const cap = routeMaxC > 10 ? 2 : 3;
    if (days > cap) {
      days = cap;
      extraIce = 0;
      reason = `hot origin A${originMaxC.toFixed(0)} caps → ${cap}d`;
    }
  }

  // XS/S hard cap at 3 days (both classes).
  if ((size === "XS" || size === "S") && days > XS_S_CAP) {
    days = XS_S_CAP;
    extraIce = 0;
    reason = `${size} cap → ${XS_S_CAP}d`;
  }

  // Prior-incident SKU: one day less (min 1).
  if (hasIncident && days > 1) {
    days = days - 1;
    reason = `${reason} · incident −1 → ${days}d`;
  }

  // Defence-in-depth: never request more ice than fits.
  if (extraIce > ICE_EXTRA_CAPACITY[size]) extraIce = ICE_EXTRA_CAPACITY[size];

  return { allowedDays: days, extraIce, reason };
}
