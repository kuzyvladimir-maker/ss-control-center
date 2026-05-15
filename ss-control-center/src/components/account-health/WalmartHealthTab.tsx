"use client";

import { useCallback, useEffect, useState } from "react";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { KpiCard, Panel, PanelHeader, PanelBody } from "@/components/kit";
import {
  HeartPulse,
  AlertTriangle,
  Package,
  ArrowUp,
  ArrowDown,
  Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";

// One row from /api/account-health/walmart, enriched with the v2 fields the
// route now pulls out of `rawData`.
interface Metric {
  metric: string;
  windowDays: number;
  value: number;
  threshold: number | null;
  isHealthy: boolean;
  status: string;
  capturedAt: string;
  resultStatus: "OK" | "NO_DATA" | "ERROR" | "NOT_AVAILABLE" | null;
  trend: string | null;
  performanceRiskLevel: string | null;
  updatedTimestamp: string | null;
  standard: string | null;
  ordersImpacted: number | null;
  impactedCustomerCount: number | null;
  gmvLoss: number | null;
  overallRate: number | null;
  sellerAccountableRate: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
}

interface ItemComplianceItem {
  id: string;
  itemId: string;
  sku: string | null;
  title: string | null;
  issueType: string;
  issueDetails: string | null;
  severity: string;
  status: string;
  reportedAt: string;
}

interface ItemCompliance {
  totalIssues: number;
  urgent: number;
  monitor: number;
  items: ItemComplianceItem[];
}

interface StoreRow {
  storeId: string;
  storeName: string;
  storeIndex: number;
  configured: boolean;
  metrics: Metric[];
  itemCompliance: ItemCompliance;
  lastSyncedAt: string | null;
}

interface Response {
  stores: StoreRow[];
}

/**
 * The 8 metrics Vladimir wants visible. shipFromAccuracy + carrierAccuracy
 * still get synced but aren't displayed — they're not in the Seller Center
 * scorecard either.
 */
type CardKey =
  | "onTimeDelivery"
  | "cancellations"
  | "validTracking"
  | "sellerResponse"
  | "lateShipment" // derived: 100 - onTimeShipment.rate
  | "negativeFeedback"
  | "returns"
  | "itemNotReceived";

interface CardSpec {
  key: CardKey;
  label: string;
  /** Window we read from the snapshot table. */
  window: 30 | 60;
  /** Walmart-published standard, rendered next to the value. */
  threshold: string;
  /** Direction used to decide bad/ok when Walmart didn't label the row. */
  direction: "gte" | "lte";
  /** Threshold numeric value matching direction. */
  thresholdValue: number;
  /**
   * Source metric in the DB. For lateShipment we read onTimeShipment and
   * invert (100 - rate) in the renderer.
   */
  sourceMetric: string;
  invert?: boolean;
}

// Performance Standards — the seven metrics Walmart deactivates accounts
// over. The layout mirrors Walmart's Seller Center page exactly: 30-day
// and 60-day cards mingle in one row, each card carries its own window
// chip so the operator can still tell them apart at a glance.
const PERFORMANCE_CARDS: CardSpec[] = [
  {
    key: "onTimeDelivery",
    label: "On-time delivery",
    window: 30,
    threshold: "≥ 90%",
    direction: "gte",
    thresholdValue: 90,
    sourceMetric: "onTimeDelivery",
  },
  {
    key: "cancellations",
    label: "Cancellations",
    window: 30,
    threshold: "≤ 2%",
    direction: "lte",
    thresholdValue: 2,
    sourceMetric: "cancellations",
  },
  {
    key: "validTracking",
    label: "Valid tracking",
    window: 30,
    threshold: "≥ 99%",
    direction: "gte",
    thresholdValue: 99,
    sourceMetric: "validTracking",
  },
  {
    key: "sellerResponse",
    label: "Seller response",
    window: 30,
    threshold: "≥ 95%",
    direction: "gte",
    thresholdValue: 95,
    sourceMetric: "sellerResponse",
  },
  {
    key: "negativeFeedback",
    label: "Negative feedback",
    window: 60,
    threshold: "≤ 2%",
    direction: "lte",
    thresholdValue: 2,
    sourceMetric: "negativeFeedback",
  },
  {
    key: "returns",
    label: "Returns",
    window: 60,
    threshold: "≤ 6%",
    direction: "lte",
    thresholdValue: 6,
    sourceMetric: "returns",
  },
  {
    key: "itemNotReceived",
    label: "Item not received",
    window: 60,
    threshold: "≤ 2%",
    direction: "lte",
    thresholdValue: 2,
    sourceMetric: "itemNotReceived",
  },
];

// Walmart's "Upcoming Standards" — currently just Late shipment (NEW).
// Threshold ≤ 5% per Walmart's preview page (not the ≤ 1% I had before;
// the early-warning threshold is 5%, not the strict on-time-shipment one).
const UPCOMING_CARDS: CardSpec[] = [
  {
    key: "lateShipment",
    label: "Late shipment",
    window: 30,
    threshold: "≤ 5%",
    direction: "lte",
    thresholdValue: 5,
    sourceMetric: "onTimeShipment",
    invert: true,
  },
];

export function WalmartHealthTab({ refreshNonce }: { refreshNonce: number }) {
  const { selectedStoreIds, isAllSelected, hasWalmart } = useStoreFilter();
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);

  const filterKey = [...selectedStoreIds].sort().join(",");
  const load = useCallback(async () => {
    if (!hasWalmart) return;
    setLoading(true);
    try {
      const qs = isAllSelected ? "" : `?storeIds=${selectedStoreIds.join(",")}`;
      const r = await fetch(`/api/account-health/walmart${qs}`);
      const j = (await r.json()) as Response;
      setData(j);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, isAllSelected, hasWalmart]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load, refreshNonce]);

  if (loading && !data) return <div className="text-[12px] text-ink-3">Loading…</div>;
  if (!data || data.stores.length === 0) {
    return (
      <div className="rounded-lg border border-rule bg-surface p-6 text-center text-[13px] text-ink-3">
        No Walmart stores configured in the current selection.
      </div>
    );
  }

  // Walmart is one account today — render the first store.
  const store = data.stores[0];

  // Build the metric lookup once. The DB returns one row per (metric, window).
  const metricByKey: Map<string, Metric> = new Map(
    store.metrics.map((m) => [`${m.metric}|${m.windowDays}`, m])
  );

  // Aggregate overall status for the hero card.
  const overall = aggregateOverall(store);

  return (
    <div className="space-y-5">
      {/* Hero row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="Walmart overall"
          value={overall.label}
          icon={<HeartPulse size={14} />}
          iconVariant={overall.tone}
          trend={{ value: store.storeName }}
        />
        <KpiCard
          label="Listings needing review"
          value={store.itemCompliance.monitor + store.itemCompliance.urgent}
          icon={<AlertTriangle size={14} />}
          iconVariant={
            store.itemCompliance.urgent > 0
              ? "danger"
              : store.itemCompliance.monitor > 0
                ? "warn"
                : "default"
          }
          trend={{
            value: `${store.itemCompliance.urgent} urgent · ${store.itemCompliance.monitor} monitor`,
          }}
        />
        <KpiCard
          label="Performance metrics"
          value={overall.dataState}
          icon={<Package size={14} />}
          iconVariant="default"
          trend={{
            value: overall.lastSyncCaption,
          }}
        />
      </div>

      {/* Performance Standards — the seven metrics Walmart deactivates over.
          Layout mirrors Walmart Seller Center: 30d and 60d cards mingle,
          each card shows its own window chip + threshold. */}
      <Panel>
        <PanelHeader
          title="Performance Standards"
          right={
            <span className="text-[11px] text-ink-3">
              Failure to adhere puts the account at risk of suspension or termination.
            </span>
          }
        />
        <PanelBody>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {PERFORMANCE_CARDS.map((spec) => (
              <MetricCardV2
                key={spec.key}
                spec={spec}
                metric={metricByKey.get(`${spec.sourceMetric}|${spec.window}`)}
              />
            ))}
          </div>
        </PanelBody>
      </Panel>

      {/* Upcoming Standards — Late shipment is the only one Walmart
          surfaces here right now. Treated as a preview / early-warning
          threshold (≤ 5%) ahead of formal enforcement. */}
      <Panel>
        <PanelHeader
          title="Upcoming Standards"
          right={
            <span className="inline-flex items-center rounded bg-info-tint px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-info-strong">
              new
            </span>
          }
        />
        <PanelBody>
          <p className="mb-3 text-[12px] text-ink-2">
            Preview new performance standards to see what&apos;s changing
            and how the account is performing today.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {UPCOMING_CARDS.map((spec) => (
              <MetricCardV2
                key={spec.key}
                spec={spec}
                metric={metricByKey.get(`${spec.sourceMetric}|${spec.window}`)}
              />
            ))}
          </div>
        </PanelBody>
      </Panel>

      {/* Other Metrics — the bottom row of Walmart Seller Center.
          Carriers / Regional performance / Ratings & reviews aren't
          surfaced via the Insights API endpoints we use, so each card
          links out to Seller Center for now. Pull pending. */}
      <Panel>
        <PanelHeader title="Other metrics" />
        <PanelBody>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <OtherMetricCard
              label="Carriers"
              note="below on-time delivery standard"
              sellerCenterPath="/performance/carriers"
            />
            <OtherMetricCard
              label="Regional performance"
              note="states below on-time delivery standard"
              sellerCenterPath="/performance/regions"
            />
            <OtherMetricCard
              label="Ratings & reviews"
              note="customer rating, all time"
              sellerCenterPath="/performance/ratings-reviews"
            />
          </div>
        </PanelBody>
      </Panel>

      {/* Item Compliance — unchanged from the previous version. */}
      <Panel>
        <PanelHeader
          title="Item compliance"
          count={store.itemCompliance.totalIssues}
          right={
            <span className="text-[11px] text-ink-3">
              listings Walmart flagged for review
            </span>
          }
        />
        <PanelBody>
          <div className="mb-3 rounded-md bg-surface-tint p-3 text-[11.5px] text-ink-2">
            <div className="font-medium text-ink mb-1">What this means</div>
            <div className="space-y-0.5">
              <div>
                <span className="inline-flex w-[70px] rounded bg-danger-tint px-1.5 py-0.5 text-[10.5px] font-mono uppercase text-danger">
                  Urgent
                </span>{" "}
                — listing blocked or troubled. Sales likely affected. Fix
                ASAP.
              </div>
              <div>
                <span className="inline-flex w-[70px] rounded bg-warn-tint px-1.5 py-0.5 text-[10.5px] font-mono uppercase text-warn-strong">
                  Monitor
                </span>{" "}
                — published with errors / system problem. Listing live but
                Walmart wants attention. Not urgent.
              </div>
            </div>
          </div>

          {store.itemCompliance.items.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-ink-3">
              No open compliance issues right now.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead className="border-b border-rule">
                  <tr className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-ink-3">
                    <th className="px-4 py-2.5 text-left font-medium">Item</th>
                    <th className="px-4 py-2.5 text-left font-medium">SKU</th>
                    <th className="px-4 py-2.5 text-left font-medium">Issue</th>
                    <th className="px-4 py-2.5 text-left font-medium">Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {store.itemCompliance.items.slice(0, 25).map((i) => (
                    <tr
                      key={i.id}
                      className="border-b border-rule last:border-0 hover:bg-surface-tint"
                    >
                      <td className="px-4 py-2 text-ink">
                        {i.title || i.itemId}
                      </td>
                      <td className="px-4 py-2 text-ink-2 font-mono text-[12px]">
                        {i.sku ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-ink-2">{i.issueType}</td>
                      <td className="px-4 py-2">
                        <span
                          className={cn(
                            "inline-flex rounded px-1.5 py-0.5 text-[10.5px] font-mono uppercase",
                            i.severity === "URGENT"
                              ? "bg-danger-tint text-danger"
                              : i.severity === "MONITOR"
                                ? "bg-warn-tint text-warn-strong"
                                : "bg-bg-elev text-ink-3"
                          )}
                        >
                          {i.severity}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {store.itemCompliance.items.length > 25 && (
                <div className="border-t border-rule px-4 py-2 text-center text-[11px] text-ink-3">
                  Showing first 25 of {store.itemCompliance.items.length}
                </div>
              )}
            </div>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

function aggregateOverall(store: StoreRow): {
  label: string;
  tone: "danger" | "warn" | "default";
  dataState: string;
  lastSyncCaption: string;
} {
  const allMetrics = store.metrics;
  const okCount = allMetrics.filter((m) => m.resultStatus === "OK").length;
  const noDataCount = allMetrics.filter(
    (m) => m.resultStatus === "NO_DATA"
  ).length;
  const errorCount = allMetrics.filter(
    (m) => m.resultStatus === "ERROR"
  ).length;

  const anyUrgent = allMetrics.some((m) => m.status === "URGENT");
  const anyMonitor = allMetrics.some((m) => m.status === "MONITOR");

  let label = "Healthy";
  let tone: "danger" | "warn" | "default" = "default";
  if (anyUrgent) {
    label = "At Risk";
    tone = "danger";
  } else if (anyMonitor) {
    label = "Monitor";
    tone = "warn";
  }

  const dataState =
    okCount === 0 && noDataCount > 0 && errorCount === 0
      ? "No data yet"
      : errorCount > 0 && okCount === 0
        ? "Error"
        : `${okCount} live`;

  const lastSync = store.lastSyncedAt
    ? `Synced ${formatRelative(new Date(store.lastSyncedAt))}`
    : "never synced";

  return { label, tone, dataState, lastSyncCaption: lastSync };
}

function MetricCardV2({
  spec,
  metric,
}: {
  spec: CardSpec;
  metric: Metric | undefined;
}) {
  // No row yet — sync hasn't run.
  if (!metric) {
    return (
      <CardShell
        label={spec.label}
        threshold={spec.threshold}
        body={<span className="text-ink-3">— never synced</span>}
        footer={null}
      />
    );
  }

  // 204 / no orders accumulated yet for the window.
  if (metric.resultStatus === "NO_DATA") {
    return (
      <CardShell
        label={spec.label}
        threshold={spec.threshold}
        body={<span className="text-ink-3">No data yet</span>}
        footer={
          <span className="text-[10.5px] text-ink-3">
            Walmart hasn&apos;t accumulated enough orders for this window
            (usually ≥14 days of active sales).
          </span>
        }
      />
    );
  }

  // 4xx/5xx — endpoint reachable but Walmart rejected.
  if (metric.resultStatus === "ERROR") {
    return (
      <CardShell
        label={spec.label}
        threshold={spec.threshold}
        tone="danger"
        body={
          <span className="text-danger text-[14px]">
            Error{metric.httpStatus ? ` ${metric.httpStatus}` : ""}
          </span>
        }
        footer={
          metric.errorMessage ? (
            <span className="text-[10.5px] text-ink-2 line-clamp-2">
              {metric.errorMessage}
            </span>
          ) : null
        }
      />
    );
  }

  // Every fallback path 404'd — Walmart doesn't expose this metric to our
  // seller credentials. Calmer state than ERROR; link out to Seller Center.
  if (metric.resultStatus === "NOT_AVAILABLE") {
    return (
      <CardShell
        label={spec.label}
        threshold={spec.threshold}
        tone="default"
        body={
          <span className="text-ink-2 text-[14px]">Not exposed via API</span>
        }
        footer={
          <div className="space-y-1">
            <div className="text-[10.5px] text-ink-3 line-clamp-2">
              Walmart shows this metric on Seller Center but doesn&apos;t
              return it on our API credentials.
            </div>
            <a
              href="https://seller.walmart.com/performance"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-green hover:text-green-deep underline"
            >
              View in Seller Center →
            </a>
          </div>
        }
      />
    );
  }

  // Normal "OK" path.
  const displayed = spec.invert ? 100 - metric.value : metric.value;
  const bad =
    spec.direction === "gte"
      ? displayed < spec.thresholdValue
      : displayed > spec.thresholdValue;
  // Tone priority — Walmart's own performanceRiskLevel wins. Their
  // algorithm sees drivers we can't replicate (carrier blame, weather
  // exclusions, etc.), so when they say "Good" we tint green even if our
  // local threshold check would have flagged it (e.g. VTR 98.5% is below
  // the 99% line but Walmart still labels it Monitor, not Urgent).
  // Only when Walmart didn't bucket the row do we fall back to the local
  // threshold check.
  const wmStatus = metric.status; // GOOD | MONITOR | URGENT (from persist)
  let tone: "good" | "warn" | "danger";
  if (wmStatus === "URGENT") tone = "danger";
  else if (wmStatus === "MONITOR") tone = "warn";
  else if (wmStatus === "GOOD") tone = "good";
  else tone = bad ? "danger" : "good";

  return (
    <CardShell
      label={spec.label}
      window={spec.window}
      threshold={spec.threshold}
      tone={tone}
      body={
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-[22px] font-semibold leading-none tabular",
              tone === "danger"
                ? "text-danger"
                : tone === "warn"
                  ? "text-warn-strong"
                  : "text-ink"
            )}
          >
            {displayed.toFixed(1)}%
          </span>
          <TrendIndicator trend={metric.trend} invert={spec.invert} />
        </div>
      }
      footer={
        <div className="space-y-0.5 text-[10.5px] text-ink-3">
          {metric.performanceRiskLevel && (
            <div>
              Walmart:{" "}
              <span className="text-ink-2">{metric.performanceRiskLevel}</span>
            </div>
          )}
          {metric.updatedTimestamp &&
            Number.isFinite(new Date(metric.updatedTimestamp).getTime()) && (
              <div>
                Updated {formatRelative(new Date(metric.updatedTimestamp))}
              </div>
            )}
        </div>
      }
    />
  );
}

function CardShell({
  label,
  window,
  threshold,
  body,
  footer,
  tone = "default",
}: {
  label: string;
  window?: number;
  threshold: string;
  body: React.ReactNode;
  footer: React.ReactNode;
  /** "good" tints the whole card light-green so healthy metrics read at
   *  a glance; "warn" / "danger" use the existing yellow / red tints.
   *  "default" stays untinted — used for NO_DATA / never-synced cards
   *  where there's no signal to colour. */
  tone?: "default" | "good" | "warn" | "danger";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-surface p-4 space-y-2",
        tone === "danger" && "border-danger/30 bg-danger-tint/30",
        tone === "warn" && "border-warn/30 bg-warn-tint/40",
        tone === "good" && "border-green-light/40 bg-green-soft/60",
        tone === "default" && "border-rule"
      )}
    >
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ink-3">
            {label}
          </div>
          <div className="text-[10.5px] font-mono text-ink-3">{threshold}</div>
        </div>
        {window && (
          <div className="text-[10px] text-ink-3">
            Last {window} days
          </div>
        )}
      </div>
      <div>{body}</div>
      {footer}
    </div>
  );
}

function OtherMetricCard({
  label,
  note,
  sellerCenterPath,
}: {
  label: string;
  note: string;
  sellerCenterPath: string;
}) {
  return (
    <div className="rounded-lg border border-rule bg-surface p-4 space-y-2">
      <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ink-3">
        {label}
      </div>
      <div className="text-[14px] text-ink-2">Pull pending</div>
      <div className="text-[10.5px] text-ink-3 line-clamp-2">{note}</div>
      <a
        href={`https://seller.walmart.com${sellerCenterPath}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] text-green hover:text-green-deep underline"
      >
        View in Seller Center →
      </a>
    </div>
  );
}

function TrendIndicator({
  trend,
  invert,
}: {
  trend: string | null;
  invert?: boolean;
}) {
  if (!trend || trend === "NEUTRAL") {
    return <Minus size={12} className="text-ink-3" />;
  }
  // For inverted metrics (lateShipment) the colour semantics flip: a
  // GREEN_DOWN on on-time-shipment means LATE went up — bad.
  const raw = trend;
  const effective = invert ? flipTrend(raw) : raw;
  const isGood = effective.startsWith("GREEN");
  const isUp = effective.endsWith("UP");
  const colour = isGood ? "text-green" : "text-danger";
  const Icon = isUp ? ArrowUp : ArrowDown;
  return <Icon size={12} className={colour} aria-label={trend} />;
}

function flipTrend(t: string): string {
  if (t === "GREEN_UP") return "RED_UP";
  if (t === "GREEN_DOWN") return "RED_DOWN";
  if (t === "RED_UP") return "GREEN_UP";
  if (t === "RED_DOWN") return "GREEN_DOWN";
  return t;
}

function formatRelative(d: Date): string {
  // Walmart sometimes omits updatedTimestamp on cumulative-style payloads
  // (returns / inr / negative feedback). new Date(undefined) → Invalid
  // Date → NaN downstream. Guard so the UI shows "—" instead of "NaN d ago".
  const t = d.getTime();
  if (!Number.isFinite(t)) return "—";
  const diffMs = Date.now() - t;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}
