/**
 * Walmart Seller Performance — Insights API.
 *
 * Walmart restructured the Seller Performance surface in 2024-2025. The old
 * `/v3/sellerPerformance/summary` endpoint no longer exists. Every metric
 * is now an independent endpoint under the Insights category:
 *
 *   GET /v3/insights/performance/{metric}/summary
 *     ?reportDuration={14|30|60|90}
 *     [&shippingMethod=ALL_METHODS|TwoDay|OneDay]
 *
 * Three endpoints (`otd`, `cancellations`, `vtr`) were verified directly
 * against developer.walmart.com docs. The remaining eight paths are
 * derived from the reference IDs Walmart publishes (`getsrr`, `getinr`,
 * `getsfla`, `getots`, `getcma`, `getnegativefeedback`, `getreturns`,
 * `getrefunds` — the last is deprecated).
 *
 * Response shape splits in two:
 *   - overall-style (otd, ots, sfla, cma, srr) → payload.overallRate
 *   - cumulative-style (cancellations, vtr, returns, inr, negativeFeedback)
 *     → payload.cumulativeRate
 *
 * HTTP semantics worth knowing:
 *   200 — data returned
 *   204 — no data accumulated yet (new account, insufficient orders).
 *         Treated as a first-class state, NOT an error.
 *   429 — rate limit; client retries with backoff
 *   401 — token rotated; client refreshes and retries once
 *   400/403/404 — application errors; surfaced to caller per-metric
 *
 * Code path: every metric goes through `WalmartClient.requestRaw()` so a
 * single per-metric failure can't poison the fan-out. The caller uses
 * `Promise.allSettled` to keep partial successes.
 *
 * Datasets refresh on Walmart's side roughly once every 24h — no point
 * syncing more often.
 */

import type { WalmartClient } from "./client";

export type PerformanceWindow = 14 | 30 | 60 | 90;
export type ShippingMethod = "ALL_METHODS" | "TwoDay" | "OneDay";

export interface MetricConfig {
  /** URL path segment Walmart uses for this metric. */
  path: string;
  /** Default reportDuration. Some metrics (returns, INR, neg feedback)
   *  are surfaced over 60 days because that matches Walmart's published
   *  performance standards window. */
  window: PerformanceWindow;
  /** Whether the endpoint accepts `&shippingMethod=…`. Only shipping-
   *  flavoured metrics do. */
  hasShippingMethod: boolean;
  /** Which rate field carries the percent in the payload. The shape
   *  bifurcates per metric — Walmart has not unified it. */
  rateKey: "overallRate" | "cumulativeRate";
}

export const PERFORMANCE_METRICS = {
  onTimeDelivery: {
    path: "otd",
    window: 30,
    hasShippingMethod: true,
    rateKey: "overallRate",
  },
  cancellations: {
    path: "cancellations",
    window: 30,
    hasShippingMethod: false,
    rateKey: "cumulativeRate",
  },
  validTracking: {
    path: "vtr",
    window: 30,
    hasShippingMethod: true,
    rateKey: "cumulativeRate",
  },
  sellerResponse: {
    path: "srr",
    window: 30,
    hasShippingMethod: false,
    rateKey: "overallRate",
  },
  negativeFeedback: {
    path: "negativeFeedback",
    window: 60,
    hasShippingMethod: false,
    rateKey: "cumulativeRate",
  },
  returns: {
    path: "returns",
    window: 60,
    hasShippingMethod: false,
    rateKey: "cumulativeRate",
  },
  itemNotReceived: {
    path: "inr",
    window: 60,
    hasShippingMethod: false,
    rateKey: "cumulativeRate",
  },
  shipFromAccuracy: {
    path: "sfla",
    window: 30,
    hasShippingMethod: false,
    rateKey: "overallRate",
  },
  onTimeShipment: {
    path: "ots",
    window: 30,
    hasShippingMethod: true,
    rateKey: "overallRate",
  },
  carrierAccuracy: {
    path: "cma",
    window: 30,
    hasShippingMethod: false,
    rateKey: "overallRate",
  },
  // refunds (`getrefunds`) is intentionally omitted — Walmart deprecated it.
} as const satisfies Record<string, MetricConfig>;

export type MetricKey = keyof typeof PERFORMANCE_METRICS;

export type MetricStatus = "OK" | "NO_DATA" | "ERROR";

export type TrendValue =
  | "GREEN_UP"
  | "GREEN_DOWN"
  | "NEUTRAL"
  | "RED_UP"
  | "RED_DOWN";

export interface PerformanceMetricResult {
  metric: MetricKey;
  status: MetricStatus;
  /** Percent 0-100. Undefined when status is NO_DATA or ERROR. */
  rate?: number;
  trend?: TrendValue;
  sellerAccountableRate?: number;
  impactedCustomerCount?: number;
  ordersImpacted?: number;
  gmvLoss?: number;
  /** Walmart's free-text risk bucket — "Good" / "Monitor" / "Urgent" / etc. */
  performanceRiskLevel?: string;
  /** Older-style risk bucket from the response. Kept for completeness. */
  riskLevel?: string;
  /** Human-readable threshold string from Walmart ("90% or above", "below 2%"). */
  standard?: string;
  reportDuration?: number;
  updatedTimestamp?: string;
  drivers?: {
    accountable?: unknown;
    nonAccountable?: unknown;
  };
  recommendations?: Array<{ recommendation: string; moreInfoLink: string }>;
  errorMessage?: string;
  httpStatus?: number;
}

export interface WalmartPerformanceData {
  syncedAt: string;
  metrics: Record<MetricKey, PerformanceMetricResult>;
}

/**
 * Fetch every supported metric for one store in parallel. Returns a
 * partial-success bundle: failed metrics carry `status: ERROR` so the rest
 * of the sync (DB writes, alert evaluator, UI) still works.
 */
export async function fetchAllPerformanceMetrics(
  client: WalmartClient
): Promise<WalmartPerformanceData> {
  const entries = Object.entries(PERFORMANCE_METRICS) as Array<
    [MetricKey, MetricConfig]
  >;

  const results = await Promise.allSettled(
    entries.map(([key, config]) => fetchSingleMetric(client, key, config))
  );

  // Build a complete map — every key shows up, even failed ones.
  const metrics = {} as Record<MetricKey, PerformanceMetricResult>;
  for (let i = 0; i < entries.length; i++) {
    const [key] = entries[i];
    const r = results[i];
    if (r.status === "fulfilled") {
      metrics[key] = r.value;
    } else {
      metrics[key] = {
        metric: key,
        status: "ERROR",
        errorMessage:
          r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    }
  }

  return {
    syncedAt: new Date().toISOString(),
    metrics,
  };
}

async function fetchSingleMetric(
  client: WalmartClient,
  key: MetricKey,
  config: MetricConfig
): Promise<PerformanceMetricResult> {
  const params: Record<string, string | number> = {
    reportDuration: config.window,
  };
  if (config.hasShippingMethod) {
    params.shippingMethod = "ALL_METHODS";
  }

  // Path passes through WalmartClient.requestRaw which prepends /v3/ and
  // adds the full standard header set + correlation id per request.
  const path = `/insights/performance/${config.path}/summary`;

  try {
    const { status, body, ok } = await client.requestRaw("GET", path, {
      params,
    });

    if (status === 204) {
      return { metric: key, status: "NO_DATA", httpStatus: 204 };
    }
    if (!ok) {
      return {
        metric: key,
        status: "ERROR",
        httpStatus: status,
        errorMessage: stringifyBody(body),
      };
    }

    return parseSuccessfulPayload(key, config, body, status);
  } catch (err) {
    return {
      metric: key,
      status: "ERROR",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseSuccessfulPayload(
  key: MetricKey,
  config: MetricConfig,
  body: unknown,
  status: number
): PerformanceMetricResult {
  if (!body || typeof body !== "object") {
    return {
      metric: key,
      status: "ERROR",
      httpStatus: status,
      errorMessage: "200 OK but body was empty or non-object",
    };
  }
  const wrapper = body as { payload?: unknown };
  const p = (wrapper.payload && typeof wrapper.payload === "object"
    ? (wrapper.payload as Record<string, unknown>)
    : (body as Record<string, unknown>));

  const rawRate = p[config.rateKey];
  const rate = typeof rawRate === "number" ? rawRate : undefined;
  const trend =
    (p.overallTrend as TrendValue | undefined) ??
    (p.cumulativeRateTrend as TrendValue | undefined);

  return {
    metric: key,
    status: "OK",
    httpStatus: status,
    rate,
    trend,
    sellerAccountableRate: numOrUndef(p.sellerAccountableRate),
    impactedCustomerCount: numOrUndef(p.impactedCustomerCount),
    ordersImpacted: numOrUndef(p.ordersImpacted),
    gmvLoss: numOrUndef(p.gmvLoss),
    performanceRiskLevel: stringOrUndef(p.performanceRiskLevel),
    riskLevel: stringOrUndef(p.riskLevel),
    standard: stringOrUndef(p.standard),
    reportDuration: numOrUndef(p.reportDuration),
    updatedTimestamp: stringOrUndef(p.updatedTimestamp),
    drivers: {
      accountable: p.sellerAccountableDrivers,
      nonAccountable: p.nonAccountableDrivers,
    },
    recommendations: Array.isArray(p.recommendations)
      ? (p.recommendations as Array<{
          recommendation: string;
          moreInfoLink: string;
        }>)
      : undefined,
  };
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function stringifyBody(body: unknown): string {
  if (body == null) return "(empty body)";
  if (typeof body === "string") return body.slice(0, 500);
  try {
    return JSON.stringify(body).slice(0, 500);
  } catch {
    return String(body).slice(0, 500);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Compatibility shim — old call sites that imported the class. Kept around so
// the v2 swap doesn't ripple into unrelated places (cron / sync routes use the
// function form directly, but other code may not).
// ────────────────────────────────────────────────────────────────────────────

export class WalmartSellerPerformanceApi {
  constructor(private client: WalmartClient) {}

  /** Fetches every supported metric. Window argument is accepted for backward
   *  compatibility but ignored — each metric now has its own canonical window
   *  baked into the PERFORMANCE_METRICS table. */
  async getAll(): Promise<WalmartPerformanceData> {
    return fetchAllPerformanceMetrics(this.client);
  }
}
