/**
 * Shared persistence + alert prep for Walmart Seller Performance v2.
 *
 * Both /api/account-health/walmart/sync and the two crons need the same
 * three things after `fetchAllPerformanceMetrics`:
 *   1. write each metric to WalmartPerformanceSnapshot (one row per metric
 *      so history accumulates; the @@index on (storeIndex, metric,
 *      capturedAt) makes the "latest per metric" read cheap).
 *   2. flatten the result into the { onTimeDelivery30d: 91.2, ... } map
 *      that alert-rules.ts expects.
 *   3. surface a per-metric breakdown for logs.
 *
 * Pulling all of that out of the route handlers keeps the route bodies
 * small and means a future change to either the snapshot shape or the
 * alert key naming is a one-file edit.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type {
  MetricKey,
  PerformanceMetricResult,
  WalmartPerformanceData,
} from "./seller-performance";

/**
 * Walmart's published performance standards (https://marketplacelearn.
 * walmart.com/guides/Policies%20&%20standards/Performance/Seller-perfor-
 * mance-standards). Direction: "gte" means healthy when rate >= value;
 * "lte" means healthy when rate <= value.
 */
const STANDARD_THRESHOLDS: Record<MetricKey, {
  value: number;
  direction: "gte" | "lte";
}> = {
  onTimeDelivery:    { value: 90, direction: "gte" },
  cancellations:     { value: 2,  direction: "lte" },
  validTracking:     { value: 99, direction: "gte" },
  sellerResponse:    { value: 95, direction: "gte" },
  onTimeShipment:    { value: 99, direction: "gte" },
  // Walmart publishes 60-day "watch" trends rather than hard cut-offs for
  // these three; the values below are the thresholds in the same docs page
  // (Seller Performance Standards) and what we wired into alert-rules.ts.
  negativeFeedback:  { value: 2,  direction: "lte" },
  returns:           { value: 6,  direction: "lte" },
  itemNotReceived:   { value: 2,  direction: "lte" },
  // No published numeric standards — assumed sensible defaults so the UI
  // can still render an "is healthy?" pill. Tune if Walmart publishes.
  shipFromAccuracy:  { value: 99, direction: "gte" },
  carrierAccuracy:   { value: 95, direction: "gte" },
};

function isHealthy(metric: MetricKey, rate: number | undefined): boolean {
  if (rate === undefined) return true;
  const t = STANDARD_THRESHOLDS[metric];
  return t.direction === "gte" ? rate >= t.value : rate <= t.value;
}

function statusBucket(
  result: PerformanceMetricResult
): "GOOD" | "MONITOR" | "URGENT" | "NO_DATA" | "ERROR" | "NOT_AVAILABLE" {
  if (result.status === "NO_DATA") return "NO_DATA";
  if (result.status === "ERROR") return "ERROR";
  if (result.status === "NOT_AVAILABLE") return "NOT_AVAILABLE";
  // Walmart's own bucket wins when it labels the row Monitor / Urgent —
  // their algorithm includes drivers we can't replicate. Otherwise fall
  // back to threshold check.
  const wm = (result.performanceRiskLevel ?? result.riskLevel ?? "")
    .toLowerCase();
  if (wm.includes("urgent")) return "URGENT";
  if (wm.includes("monitor")) return "MONITOR";
  if (isHealthy(result.metric, result.rate)) return "GOOD";
  return "URGENT";
}

/**
 * Map a (metricKey, windowDays) pair to the flat key expected by the
 * critical-alerts evaluator (`onTimeDelivery30d`, `negativeFeedback60d`,
 * etc). Anything outside the alert rule set returns null.
 */
function toFlatAlertKey(metric: MetricKey, windowDays: number): string | null {
  switch (metric) {
    case "onTimeDelivery":   return `onTimeDelivery${windowDays}d`;
    case "cancellations":    return `cancellations${windowDays}d`;
    case "validTracking":    return `validTracking${windowDays}d`;
    case "sellerResponse":   return `sellerResponse${windowDays}d`;
    case "onTimeShipment":   return `onTimeShipment${windowDays}d`;
    case "negativeFeedback": return `negativeFeedback${windowDays}d`;
    case "returns":          return `returns${windowDays}d`;
    case "itemNotReceived":  return `itemNotReceived${windowDays}d`;
    default:                 return null; // shipFromAccuracy, carrierAccuracy
  }
}

export interface PersistResult {
  snapshotsWritten: number;
  okCount: number;
  noDataCount: number;
  errorCount: number;
  metricsMap: Record<string, number | null>;
}

/**
 * Persist every metric in `data` to WalmartPerformanceSnapshot and produce
 * the flat key/value map for the alert evaluator. Idempotent in the sense
 * that each call inserts new history rows — there's no upsert because we
 * want a trace for trend charts.
 */
export async function persistPerformanceSnapshots(
  prisma: PrismaClient,
  storeIndex: number,
  data: WalmartPerformanceData
): Promise<PersistResult> {
  let snapshotsWritten = 0;
  let okCount = 0;
  let noDataCount = 0;
  let errorCount = 0;
  const metricsMap: Record<string, number | null> = {};

  for (const [keyStr, result] of Object.entries(data.metrics)) {
    const key = keyStr as MetricKey;
    if (result.status === "NO_DATA") noDataCount++;
    else if (result.status === "ERROR" || result.status === "NOT_AVAILABLE") {
      errorCount++;
    } else okCount++;

    const reportDuration =
      result.reportDuration ?? defaultWindowFor(key);

    const threshold = STANDARD_THRESHOLDS[key]?.value ?? null;
    const healthy = isHealthy(key, result.rate);
    const bucket = statusBucket(result);

    // History row even for NO_DATA / ERROR — we want to see when data
    // started flowing or when an endpoint started failing.
    await prisma.walmartPerformanceSnapshot.create({
      data: {
        storeIndex,
        windowDays: reportDuration,
        metric: key,
        value: result.rate ?? 0,
        threshold,
        isHealthy: result.status === "OK" ? healthy : true,
        status: bucket,
        rawData: JSON.stringify(result),
      },
    });
    snapshotsWritten++;

    if (result.status === "OK" && typeof result.rate === "number") {
      const flat = toFlatAlertKey(key, reportDuration);
      if (flat) metricsMap[flat] = result.rate;
    }
  }

  return {
    snapshotsWritten,
    okCount,
    noDataCount,
    errorCount,
    metricsMap,
  };
}

function defaultWindowFor(key: MetricKey): number {
  // Mirror PERFORMANCE_METRICS table without re-importing it (circular
  // import danger). Returns and INR + neg feedback run on 60-day windows;
  // everything else 30.
  if (
    key === "negativeFeedback" ||
    key === "returns" ||
    key === "itemNotReceived"
  ) {
    return 60;
  }
  return 30;
}
