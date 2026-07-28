// Client-safe recommendation generator. Mirrors the destination-only
// thresholds in default-rules.ts (decided with Vladimir on 2026-05-15):
// destination temperature is what predicts thaw, Tampa heat only matters
// during the brief pickup + Florida-exit window.
//
// The pipeline stores raw temperatures (in °F) on each FrozenRiskAlert row;
// this function reads those numbers and rebuilds the user-facing text in
// whatever unit the reader prefers — so the same alert row works for °C
// and °F readers without re-running the pipeline.

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

// Same thresholds as default-rules.ts, in °F.
const F_HIGH_ICE_PACKS = 95; // dest ≥ 35°C → +2 packs + Overnight territory
const F_MED_ICE_PACKS = 86; // dest ≥ 30°C → +1 pack
const F_DEST_HOT_TRANSIT = 86; // dest ≥ 30°C combined with transit≥3 triggers R6
const F_TAMPA_EXTREME = 95; // origin ≥ 35°C — pickup-window risk (M5)

export function regenerateRecommendations(
  alert: AlertForRecs,
  unit: TempUnit = DEFAULT_TEMP_UNIT,
): string[] {
  const recs: string[] = [];
  const originF = alert.originTempMaxF ?? alert.originTempF ?? null;
  const destF = alert.destTempMaxF ?? alert.destTempF ?? null;

  // CRITICAL — strongest action first.
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

  // Ice pack ladder — based on DESTINATION temperature (what package faces
  // at delivery, when it's been sitting in a truck and then on a porch).
  if (destF != null && destF >= F_HIGH_ICE_PACKS) {
    const dest = formatTemp(destF, unit);
    recs.push(`Add 2 extra ice packs (destination ${dest} at delivery).`);
  } else if (destF != null && destF >= F_MED_ICE_PACKS) {
    const dest = formatTemp(destF, unit);
    recs.push(`Add 1 extra ice pack (destination ${dest} at delivery).`);
  }

  // HIGH and currently Ground → push 2-Day
  if (
    alert.riskLevel === "high" &&
    alert.plannedService &&
    /ground/i.test(alert.plannedService)
  ) {
    recs.push(`Pick 2-Day Air instead of ${alert.plannedService}.`);
  }

  // Tampa extreme — covers the 12-18h pickup + Florida-exit window (M5).
  if (originF != null && originF >= F_TAMPA_EXTREME) {
    const origin = formatTemp(originF, unit);
    recs.push(
      `Tampa is ${origin} — limit time outside the freezer before pickup.`,
    );
  }

  // Anomaly notes — heat-wave context, only when meaningfully high.
  if ((alert.destAnomalyF ?? 0) > 5) {
    recs.push(
      `Destination is ${formatAnomaly(alert.destAnomalyF, unit)} above normal for this date.`,
    );
  }
  if ((alert.originAnomalyF ?? 0) > 5) {
    recs.push(
      `Tampa is ${formatAnomaly(alert.originAnomalyF, unit)} above the 30-yr average for this date.`,
    );
  }

  return recs;
}
