// Temperature classes for shipping-label rate selection.
//
// A SKU belongs to exactly one temperature class. The class decides how many
// calendar days the package may spend in transit (the cold chain), how much
// ice we pack, and whether the item may ship on Walmart at all.
//
//   FROZEN  — the buyer expects the item frozen. Strictest cold chain.
//   CHILLED — sold refrigerated in stores. We still freeze + ice it, but the
//             buyer accepts it arriving thawed, so the window is +1 day.
//   DRY     — no temperature logic at all; just buy the cheapest on-time rate.
//
// Owner (Vladimir), topic 135, 2026-10-23. Design doc:
// docs/wiki/frozen-weather-rate-selection-plan-2026-10-23.md.

export type TempClass = "FROZEN" | "CHILLED" | "DRY";

export const TEMP_CLASSES: readonly TempClass[] = ["FROZEN", "CHILLED", "DRY"];

// Strictness ranking. FROZEN is strictest (holds the shortest window / most
// ice); DRY is loosest. In a mixed order the STRICTEST class wins, so the one
// item that must stay frozen drags the whole box onto the frozen cold chain.
const STRICTNESS: Record<TempClass, number> = {
  FROZEN: 3,
  CHILLED: 2,
  DRY: 1,
};

// When a SKU has no class anywhere (no manual value, no legacy override, no
// Veeqo tag), we treat it as FROZEN — the safe default (owner, 2026-10-23:
// "без тега = frozen"). The caller flags the card so the operator can correct
// it, but the cold chain is never silently dropped.
export const DEFAULT_CLASS: TempClass = "FROZEN";

/** Is `v` one of the three valid class strings? */
export function isTempClass(v: unknown): v is TempClass {
  return v === "FROZEN" || v === "CHILLED" || v === "DRY";
}

/**
 * Normalise a free-form string (Veeqo tag, legacy "Frozen"/"Dry", operator
 * input) to a TempClass, or null when it says nothing about temperature.
 *   frozen                                   → FROZEN
 *   chilled / refrigerated / fridge / cold   → CHILLED
 *   dry / ambient / shelf                    → DRY
 */
export function parseTempClass(raw: string | null | undefined): TempClass | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("frozen")) return "FROZEN";
  if (
    s.includes("chilled") ||
    s.includes("refriger") ||
    s.includes("fridge") ||
    s === "cold"
  ) {
    return "CHILLED";
  }
  if (s.includes("dry") || s.includes("ambient") || s.includes("shelf")) {
    return "DRY";
  }
  return null;
}

/**
 * The strictest class among a set of line classes — the order's effective
 * class. Empty list → the default (FROZEN). Used so a mixed order inherits the
 * coldest item's rules instead of reading only the first line (the old bug).
 */
export function strictestClass(classes: readonly TempClass[]): TempClass {
  let winner: TempClass = DEFAULT_CLASS;
  let best = -1;
  for (const c of classes) {
    const rank = STRICTNESS[c];
    if (rank > best) {
      best = rank;
      winner = c;
    }
  }
  return classes.length === 0 ? DEFAULT_CLASS : winner;
}

/**
 * Bridge to the legacy two-value productType string the existing summer buy
 * path and SkuShippingData.category understand. CHILLED maps to "Frozen"
 * because a chilled order still freezes + ices and buys through the same
 * Amazon frozen path; only the allowed-days window differs (handled by the
 * temp-aware engine). DRY → "Dry".
 */
export function tempClassToProductType(c: TempClass): "Frozen" | "Dry" {
  return c === "DRY" ? "Dry" : "Frozen";
}
