"use client";

/**
 * Walmart Performance panel for the Account Health page.
 *
 * GET /api/account-health/walmart/sync — returns latest snapshot per
 *   (storeIndex, windowDays, metric).
 * POST same path — pulls a fresh snapshot from Walmart Seller Performance.
 *
 * One card per (windowDays, metric). Colour codes:
 *   green  — isHealthy=true
 *   red    — isHealthy=false
 *   slate  — no data captured yet
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface MetricItem {
  storeIndex: number;
  windowDays: number;
  metric: string;
  value: number;
  threshold?: number | null;
  isHealthy: boolean;
  capturedAt: string;
}

interface ApiResponse {
  items: MetricItem[];
  issues: number;
}

const METRIC_LABELS: Record<string, string> = {
  onTimeDelivery: "On-time Delivery",
  validTrackingRate: "Valid Tracking",
  responseRate: "Response Rate",
  cancellationRate: "Cancellation Rate",
  refundRate: "Refund Rate",
  carrierMethodAccuracy: "Carrier Method Accuracy",
  onTimeShipment: "On-time Shipment",
  shipFromLocationAccuracy: "Ship-from Accuracy",
};

function formatPercent(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v >= 1 && v <= 100 ? `${v.toFixed(2)}%` : v.toFixed(2);
}

export default function WalmartPerformancePanel() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/account-health/walmart/sync");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as ApiResponse;
      setData(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/account-health/walmart/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windows: [30, 90] }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  // Group metrics by windowDays for two columns of cards
  const byWindow = new Map<number, MetricItem[]>();
  for (const item of data?.items ?? []) {
    if (!byWindow.has(item.windowDays)) byWindow.set(item.windowDays, []);
    byWindow.get(item.windowDays)!.push(item);
  }
  const windows = Array.from(byWindow.keys()).sort((a, b) => a - b);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">
            Walmart Performance
          </h2>
          {data && data.issues > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-danger-tint px-2 py-0.5 text-xs text-danger">
              <AlertTriangle size={12} /> {data.issues} issue
              {data.issues === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={runSync} disabled={syncing}>
          {syncing ? (
            <Loader2 size={14} className="mr-1 animate-spin" />
          ) : (
            <RefreshCw size={14} className="mr-1" />
          )}
          Sync Walmart
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-danger/20 bg-danger-tint px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-8 text-sm text-ink-3">
          <Loader2 size={18} className="mr-2 animate-spin" /> Loading…
        </div>
      )}

      {!loading && data && data.items.length === 0 && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-ink-3">
            No Walmart performance snapshots yet. Click <b>Sync Walmart</b>{" "}
            to pull the first one.
          </CardContent>
        </Card>
      )}

      {windows.map((w) => (
        <div key={w} className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-ink-3">
            Last {w} days
          </p>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {byWindow.get(w)!.map((m) => (
              <Card
                key={`${w}-${m.metric}`}
                className={`border ${m.isHealthy ? "border-green-200" : "border-red-300"}`}
              >
                <CardContent className="py-3">
                  <p className="truncate text-[11px] text-ink-3" title={m.metric}>
                    {METRIC_LABELS[m.metric] ?? m.metric}
                  </p>
                  <p
                    className={`text-lg font-bold ${m.isHealthy ? "text-green-ink" : "text-danger"}`}
                  >
                    {formatPercent(m.value)}
                  </p>
                  {m.threshold != null && (
                    <p className="text-[10px] text-ink-3">
                      threshold {formatPercent(m.threshold)}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
