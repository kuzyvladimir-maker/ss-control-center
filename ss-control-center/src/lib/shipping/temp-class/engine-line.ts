/**
 * The one-line engine summary on a shipping card, shown BEFORE the label is
 * bought, so the owner can see what the temperature-aware engine decided:
 *   "Clearwater 28°C → Columbus, WI 4°C · route max 9°C · Frozen · max 3 days · +2 ice"
 * Same text in shadow and live. Built only from data the plan already computed
 * (no extra API calls). UI strings are English (owner rule).
 */

export interface EngineLineInput {
  tempClass: string | null | undefined;
  shadow?: {
    originMaxC: number | null;
    routeMaxC: number | null;
    allowedDays: number | null;
    extraIce: number;
    noForecast: boolean;
    destCity?: string | null;
    destState?: string | null;
    destMaxC?: number | null;
  } | null;
}

export interface EngineLine {
  text: string;
  /** "rules" = the weather table decided; "summer" = fell back to summer. */
  mode: "rules" | "summer" | "dry";
}

const deg = (c: number | null | undefined) =>
  c == null || !Number.isFinite(c) ? "?°C" : `${Math.round(c)}°C`;

const label = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

export function formatEngineLine(input: EngineLineInput): EngineLine | null {
  const cls = (input.tempClass ?? "").toUpperCase();
  if (!cls) return null; // engine off (summer profile)
  if (cls === "DRY") {
    return { text: "Dry · no temperature limit · cheapest rate", mode: "dry" };
  }

  const s = input.shadow;
  if (!s) {
    return {
      text: `${label(cls)} · engine not run (no box size or address) — summer rules`,
      mode: "summer",
    };
  }
  if (s.noForecast) {
    return { text: `${label(cls)} · no forecast — summer rules`, mode: "summer" };
  }

  const place =
    [s.destCity, s.destState].filter(Boolean).join(", ") || "destination";
  const parts = [`Clearwater ${deg(s.originMaxC)} → ${place} ${deg(s.destMaxC)}`];
  // The engine decides on the ROUTE max (midpoint + destination). Show it when
  // it differs from the destination, so the numbers explain the day cap.
  if (
    s.routeMaxC != null &&
    (s.destMaxC == null || Math.round(s.routeMaxC) !== Math.round(s.destMaxC))
  ) {
    parts.push(`route max ${deg(s.routeMaxC)}`);
  }
  parts.push(label(cls));
  parts.push(
    s.allowedDays == null || !Number.isFinite(s.allowedDays)
      ? "no day cap"
      : `max ${s.allowedDays} day${s.allowedDays === 1 ? "" : "s"}`,
  );
  if (s.extraIce > 0) parts.push(`+${s.extraIce} ice`);
  return { text: parts.join(" · "), mode: "rules" };
}
