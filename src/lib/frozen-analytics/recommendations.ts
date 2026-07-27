// Human-facing recommendations for an alert. Layered on top of the rules
// engine's triggered list — these are the SPECIFIC, action-oriented strings
// that show up on the RiskAlertCard. Wording stays calm and operator-style
// (no emoji clutter; one short clause per line).

import type { RuleContext, RuleResult } from "./rules-engine";

export function buildRecommendations(
  ctx: RuleContext,
  result: RuleResult,
  skuHistoryCount?: number | null,
): string[] {
  const recs: string[] = [];
  const maxTemp = Math.max(ctx.originTempF ?? 0, ctx.destTempF ?? 0);

  // Critical-only actions
  if (result.riskLevel === "critical") {
    if (ctx.service && !/(overnight|next.?day|1.?day)/i.test(ctx.service)) {
      recs.push("Switch to Overnight if the carrier offers it.");
    }
    if ((ctx.transitDays ?? 0) >= 3 && (ctx.destTempF ?? 0) >= 85) {
      recs.push(
        `Transit ${ctx.transitDays}d is too long with destination at ${Math.round(
          ctx.destTempF ?? 0,
        )}°F.`,
      );
    }
  }

  // Ice pack tier
  if (maxTemp >= 90) {
    recs.push(
      `Add 2 extra ice packs (peak temp ${Math.round(maxTemp)}°F on route).`,
    );
  } else if (maxTemp >= 85) {
    recs.push(
      `Add 1 extra ice pack (peak temp ${Math.round(maxTemp)}°F on route).`,
    );
  }

  // Service downgrade hint
  if (
    result.riskLevel === "high" &&
    ctx.service &&
    /ground/i.test(ctx.service)
  ) {
    recs.push(`Pick 2-Day Air instead of ${ctx.service}.`);
  }

  // Anomaly notes
  if ((ctx.originAnomalyF ?? 0) > 5) {
    recs.push(
      `Tampa is ${Math.round(ctx.originAnomalyF ?? 0)}°F above the 30-yr average for this date.`,
    );
  }
  if ((ctx.destAnomalyF ?? 0) > 5) {
    recs.push(
      `Destination is ${Math.round(ctx.destAnomalyF ?? 0)}°F above normal for this date.`,
    );
  }

  // SKU history
  if (skuHistoryCount && skuHistoryCount > 0) {
    recs.push(
      `SKU ${ctx.sku} has thawed ${skuHistoryCount} time${
        skuHistoryCount === 1 ? "" : "s"
      } in past incidents.`,
    );
  }

  return recs;
}
