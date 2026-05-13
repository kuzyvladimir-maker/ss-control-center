"use client";

import { useCallback, useEffect, useState } from "react";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { KpiCard, Panel, PanelHeader, PanelBody } from "@/components/kit";
import { HeartPulse, AlertTriangle, Package } from "lucide-react";
import { cn } from "@/lib/utils";

interface Metric {
  metric: string;
  windowDays: number;
  value: number;
  threshold: number | null;
  isHealthy: boolean;
  status: string;
}

interface ItemCompliance {
  totalIssues: number;
  urgent: number;
  monitor: number;
  items: Array<{
    id: string;
    itemId: string;
    sku: string | null;
    title: string | null;
    issueType: string;
    issueDetails: string | null;
    severity: string;
    status: string;
    reportedAt: string;
  }>;
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

// Display metadata for each metric (label + thresh direction). Mirrors what
// the alert-rules use under the hood but in UI-friendly form.
const METRIC_LABELS: Record<
  string,
  { label: string; threshold: string; dir: "lte" | "gte" }
> = {
  onTimeDelivery:     { label: "On-time delivery",      threshold: "≥ 90%",  dir: "lte" },
  cancellationRate:   { label: "Cancellations",         threshold: "≤ 2%",   dir: "gte" },
  validTrackingRate:  { label: "Valid tracking",        threshold: "≥ 99%",  dir: "lte" },
  responseRate:       { label: "Seller response",       threshold: "≥ 95%",  dir: "lte" },
  refundRate:         { label: "Refund rate",           threshold: "≤ 6%",   dir: "gte" },
  onTimeShipment:     { label: "Late shipment",         threshold: "≤ 5%",   dir: "gte" },
  carrierMethodAccuracy: { label: "Carrier accuracy",   threshold: "—",      dir: "lte" },
  shipFromLocationAccuracy: { label: "Ship-from accuracy", threshold: "—",   dir: "lte" },
};

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

  // Walmart is one account per project today — render the first store's
  // payload prominently. When a second account lands, we'll iterate.
  const store = data.stores[0];

  // Walmart's Seller Performance API is only available to sellers enrolled
  // in their (gated) Insights program. Our account returns 404 on every
  // performance / scorecard endpoint, so we show a clear placeholder
  // instead of an empty grid that looks broken.
  const performanceAvailable = store.metrics.length > 0;

  return (
    <div className="space-y-5">
      {/* Hero row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="Walmart overall"
          value={
            store.itemCompliance.urgent > 0
              ? `${store.itemCompliance.urgent} urgent`
              : store.itemCompliance.monitor > 0
                ? "Monitor"
                : "Healthy"
          }
          icon={<HeartPulse size={14} />}
          iconVariant={
            store.itemCompliance.urgent > 0
              ? "danger"
              : store.itemCompliance.monitor > 0
                ? "warn"
                : "default"
          }
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
          value={performanceAvailable ? "Live" : "Not available"}
          icon={<Package size={14} />}
          iconVariant="default"
          trend={{
            value: performanceAvailable
              ? "via Marketplace API"
              : "Walmart Seller Center only",
          }}
        />
      </div>

      {/* Performance standards block — only when API actually returned data.
          Most sellers (us included) hit 404 on /sellerPerformance/*, so the
          panel below renders only when at least one metric was captured. */}
      {performanceAvailable ? (
        <Panel>
          <PanelHeader
            title="Performance standards"
            right={
              <span className="text-[11px] text-ink-3">30-day window</span>
            }
          />
          <PanelBody>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Object.entries(METRIC_LABELS).map(([key, meta]) => {
                const m = store.metrics.find(
                  (x) => x.metric === key && x.windowDays === 30
                );
                return (
                  <MetricCard
                    key={key}
                    label={meta.label}
                    value={m?.value ?? null}
                    threshold={meta.threshold}
                    healthy={m?.isHealthy ?? null}
                  />
                );
              })}
            </div>
          </PanelBody>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader title="Performance metrics" />
          <PanelBody>
            <div className="rounded-md bg-surface-tint p-4 text-[12.5px] text-ink-2">
              <div className="mb-1 font-medium text-ink">
                Not available via API for this account
              </div>
              Walmart&apos;s Seller Performance / Scorecard endpoints
              (<code>/v3/sellerPerformance/*</code>, <code>/v3/insights/*</code>) return{" "}
              <code>404 CONTENT_NOT_FOUND</code> for our seller account.
              These metrics are accessible only via{" "}
              <a
                href="https://seller.walmart.com/account/performance"
                target="_blank"
                rel="noopener noreferrer"
                className="text-green hover:text-green-deep underline"
              >
                Walmart Seller Center
              </a>
              . Item-compliance issues (below) are pulled successfully via
              the public <code>/v3/items</code> endpoint.
            </div>
          </PanelBody>
        </Panel>
      )}

      {/* Item Compliance — what Walmart's /v3/items API flagged. Each row is
          one product in our catalog Walmart considers problematic. */}
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
          {/* Severity legend — explains what URGENT vs MONITOR means so the
              operator doesn't have to guess. */}
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

function MetricCard({
  label,
  value,
  threshold,
  healthy,
}: {
  label: string;
  value: number | null;
  threshold: string;
  healthy: boolean | null;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-rule bg-surface p-4",
        healthy === false && "border-danger/30 bg-danger-tint/30"
      )}
    >
      <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ink-3">
        {label}
      </div>
      <div
        className={cn(
          "mt-2 text-[22px] font-semibold leading-none tabular",
          healthy === false ? "text-danger" : "text-ink"
        )}
      >
        {value == null ? "—" : `${value.toFixed(2)}%`}
      </div>
      <div className="mt-1.5 text-[11px] text-ink-3">{threshold}</div>
    </div>
  );
}
