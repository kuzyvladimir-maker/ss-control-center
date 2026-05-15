// Client-safe recommendation generator. The pipeline stores raw temperatures
// (in °F) on each FrozenRiskAlert row; this function reads those numbers and
// rebuilds the user-facing recommendation strings in whatever unit the
// reader prefers. That way the SAME alert row works for °C and °F readers
// without re-running the pipeline.
//
// Mirrors src/lib/frozen-analytics/recommendations.ts (server-side) but uses
// the new unit helpers from src/lib/units.ts.

import {
  formatAnomaly,
  formatTemp,
  type TempUnit,
  DEFAULT_TEMP_UNIT,
} from "@/lib/units";

interface AlertForRecs {
  riskLevel: string;
  originTempF: number | null;
  destTempF: number | null;
  originTempMaxF: number | null;
  destTempMaxF: number | null;
  originAnomalyF: number | null;
  destAnomalyF: number | null;
  transitDays: number | null;
  plannedCarrier: string | null;
  plannedService: string | null;
  sku: string;
}

// Same thresholds as default-rules.ts uses in °F. Kept inline here so the UI
// doesn't need to fetch FrozenRule rows on every render.
const F_HIGH_ICE_PACKS = 95; // ≥ 35°C → +2 packs
const F_MED_ICE_PACKS = 86; // ≥ 30°C → +1 pack
const F_DEST_HOT_TRANSIT = 86; // ≥ 30°C destination triggers transit-too-long rule

export function regenerateRecommendations(
  alert: AlertForRecs,
  unit: TempUnit = DEFAULT_TEMP_UNIT,
): string[] {
  const recs: string[] = [];
  const originF = alert.originTempMaxF ?? alert.originTempF ?? null;
  const destF = alert.destTempMaxF ?? alert.destTempF ?? null;
  const maxF = Math.max(originF ?? 0, destF ?? 0);
  const peak = formatTemp(maxF, unit);

  // CRITICAL — push for the strongest action first.
  if (alert.riskLevel === "critical") {
    if (
      alert.plannedService &&
      !/(overnight|next.?day|1.?day)/i.test(alert.plannedService)
    ) {
      recs.push("Switch to Overnight if the carrier offers it.");
    }
    if (
      (alert.transitDays ?? 0) >= 3 &&
      (destF ?? 0) >= F_DEST_HOT_TRANSIT
    ) {
      const destStr = formatTemp(destF, unit);
      recs.push(
        `Transit ${alert.transitDays}d is too long with destination at ${destStr}.`,
      );
    }
  }

  // Ice pack ladder
  if (maxF >= F_HIGH_ICE_PACKS) {
    recs.push(`Add 2 extra ice packs (peak ${peak} on route).`);
  } else if (maxF >= F_MED_ICE_PACKS) {
    recs.push(`Add 1 extra ice pack (peak ${peak} on route).`);
  }

  // HIGH and using Ground → push 2-Day
  if (
    alert.riskLevel === "high" &&
    alert.plannedService &&
    /ground/i.test(alert.plannedService)
  ) {
    recs.push(`Pick 2-Day Air instead of ${alert.plannedService}.`);
  }

  // Anomaly notes — only when meaningfully high
  if ((alert.originAnomalyF ?? 0) > 5) {
    recs.push(
      `Tampa is ${formatAnomaly(alert.originAnomalyF, unit)} above the 30-yr average for this date.`,
    );
  }
  if ((alert.destAnomalyF ?? 0) > 5) {
    recs.push(
      `Destination is ${formatAnomaly(alert.destAnomalyF, unit)} above normal for this date.`,
    );
  }

  return recs;
}
