"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Settings,
  Store,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import WalmartPerformancePanel from "@/components/account-health/WalmartPerformancePanel";
import {
  Btn,
  HeroGreenCard,
  HeroDivider,
  HeroLabel,
  KpiCard,
  PageHead,
  Sep,
  SyncChip,
} from "@/components/kit";
import { Calendar, Plus } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoreData = any;

interface HealthResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stores: any[];
  summary: { total: number; configured: number; healthy: number; warning: number; critical: number };
  fetchedAt: string;
}

const statusBorder: Record<string, string> = {
  healthy: "border-green",
  warning: "border-warn-strong",
  critical: "border-danger",
  error: "border-danger",
  syncing: "border-info",
  pending: "border-silver-line",
  not_configured: "border-rule",
};

const statusBadge: Record<string, { label: string; className: string }> = {
  healthy: { label: "HEALTHY", className: "bg-green-soft2 text-green-ink" },
  warning: { label: "WARNING", className: "bg-warn-tint text-warn-strong" },
  critical: { label: "CRITICAL", className: "bg-danger text-green-cream" },
  error: { label: "ERROR", className: "bg-danger-tint text-danger" },
  syncing: { label: "SYNCING", className: "bg-green-soft2 text-green-deep" },
  pending: { label: "PENDING", className: "bg-bg-elev text-ink-3" },
  not_configured: { label: "NOT SET UP", className: "bg-bg-elev text-ink-3" },
};

const statusIcon: Record<string, string> = {
  ok: "text-green",
  warning: "text-warn-strong",
  critical: "text-danger",
  unknown: "text-ink-4",
};

function MetricRow({
  label,
  value,
  status,
  limit,
  period,
  numerator,
  denominator,
  indent,
}: {
  label: string;
  value: number | null;
  status: string;
  limit: string;
  period?: string;
  numerator?: number | null;
  denominator?: number | null;
  indent?: boolean;
}) {
  const isBad = status === "critical";
  const isWarn = status === "warning";
  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2 py-1 px-2 rounded text-xs ${
        isBad ? "bg-danger-tint" : isWarn ? "bg-warn-tint/50" : ""
      } ${indent ? "ml-4" : ""}`}
    >
      <span className={`${indent ? "text-ink-3" : "text-ink-2"}`}>
        {label}
        {period && !indent && (
          <span className="text-ink-3 ml-1">({period})</span>
        )}
      </span>
      <div className="flex items-center justify-between sm:justify-end gap-2">
        <span className={`font-mono font-semibold ${statusIcon[status] || "text-ink-3"}`}>
          {value !== null && value !== undefined ? `${value}%` : "—"}
        </span>
        {numerator !== null && numerator !== undefined && denominator !== null && denominator !== undefined && (
          <span className="text-[10px] text-ink-3">
            ({numerator}/{denominator})
          </span>
        )}
        {status === "ok" && <CheckCircle size={12} className="text-green" />}
        {status === "warning" && <AlertTriangle size={12} className="text-warn-strong" />}
        {status === "critical" && (
          <span className="text-[10px] font-bold text-danger">OVER</span>
        )}
        <span className="text-[10px] text-ink-3">{limit}</span>
      </div>
    </div>
  );
}

function StoreCard({
  store,
  onSync,
  syncing,
}: {
  store: StoreData;
  onSync: (i: number) => void;
  syncing: boolean;
}) {
  const border = statusBorder[store.status] || "border-rule";
  const badge = statusBadge[store.status] || statusBadge.not_configured;

  if (store.status === "not_configured") {
    return (
      <Card className={`border-2 ${border}`}>
        <CardContent className="py-5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-sm text-ink-2 flex items-center gap-1.5">
              <Store size={15} className="text-ink-3" />
              Store {store.storeIndex}
            </span>
            <Badge className={badge.className}>
              <Settings size={10} className="mr-1" />
              {badge.label}
            </Badge>
          </div>
          <p className="text-xs text-ink-3">
            Add <code className="bg-bg-elev px-1 rounded">AMAZON_SP_REFRESH_TOKEN_STORE{store.storeIndex}</code> to .env
          </p>
        </CardContent>
      </Card>
    );
  }

  if (store.status === "pending" || store.status === "syncing") {
    return (
      <Card className={`border-2 ${border}`}>
        <CardContent className="py-5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-sm flex items-center gap-1.5">
              <Store size={15} />
              Store {store.storeIndex}
            </span>
            <Badge className={badge.className}>
              {store.status === "syncing" && <Loader2 size={10} className="mr-1 animate-spin" />}
              {badge.label}
            </Badge>
          </div>
          <p className="text-xs text-ink-3 mb-3">{store.message || "Waiting..."}</p>
          <Button variant="outline" size="sm" onClick={() => onSync(store.storeIndex)} disabled={syncing}>
            {syncing ? <Loader2 size={12} className="animate-spin mr-1" /> : <RefreshCw size={12} className="mr-1" />}
            Sync Now
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (store.status === "error") {
    return (
      <Card className={`border-2 ${border}`}>
        <CardContent className="py-5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-sm flex items-center gap-1.5">
              <Store size={15} className="text-danger" />
              Store {store.storeIndex}
            </span>
            <Badge className={badge.className}><XCircle size={10} className="mr-1" />Error</Badge>
          </div>
          <p className="text-xs text-danger break-all">{store.error || store.message}</p>
        </CardContent>
      </Card>
    );
  }

  const m = store.metrics;

  return (
    <Card className={`border-2 ${border}`}>
      <CardContent className="py-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <span className="font-medium text-sm flex items-center gap-1.5">
            <Store size={15} className="text-ink-2" />
            Store {store.storeIndex}
          </span>
          <Badge className={badge.className}>
            {store.status === "healthy" && <CheckCircle size={10} className="mr-1" />}
            {store.status === "warning" && <AlertTriangle size={10} className="mr-1" />}
            {store.status === "critical" && <XCircle size={10} className="mr-1" />}
            {badge.label}
          </Badge>
        </div>
        {store.storeName && (
          <p className="text-xs text-ink-3 mb-3">
            {store.storeName}
            {store.sellerId && <span className="text-ink-3"> | {store.sellerId}</span>}
          </p>
        )}

        {m && (
          <div className="space-y-1">
            {/* Customer Service Performance */}
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-wide">
              Customer Service (60 days)
            </p>
            <MetricRow label="Order Defect Rate" value={m.odr?.value} status={m.odr?.status} limit={m.odr?.limit} period={m.odr?.period} numerator={null} denominator={m.odr?.orders} />
            {m.odr?.breakdown && (
              <>
                <MetricRow label="Negative Feedback" value={m.odr.breakdown.negativeFeedback?.rate} status="unknown" limit="" indent numerator={m.odr.breakdown.negativeFeedback?.count} denominator={null} />
                <MetricRow label="A-to-Z Claims" value={m.odr.breakdown.atozClaims?.rate} status="unknown" limit="" indent numerator={m.odr.breakdown.atozClaims?.count} denominator={null} />
                <MetricRow label="Chargebacks" value={m.odr.breakdown.chargebacks?.rate} status="unknown" limit="" indent numerator={m.odr.breakdown.chargebacks?.count} denominator={null} />
              </>
            )}

            {/* Shipping Performance */}
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-wide mt-2">
              Shipping Performance
            </p>
            <MetricRow label="Late Shipment (10d)" value={m.lsr10d?.value} status={m.lsr10d?.status} limit={m.lsr10d?.limit} period="10 days" numerator={m.lsr10d?.numerator} denominator={m.lsr10d?.denominator} />
            <MetricRow label="Late Shipment (30d)" value={m.lsr30d?.value} status={m.lsr30d?.status} limit={m.lsr30d?.limit} period="30 days" numerator={m.lsr30d?.numerator} denominator={m.lsr30d?.denominator} />
            <MetricRow label="Cancel Rate" value={m.cancelRate?.value} status={m.cancelRate?.status} limit={m.cancelRate?.limit} period="7 days" numerator={m.cancelRate?.numerator} denominator={m.cancelRate?.denominator} />
            <MetricRow label="Valid Tracking" value={m.vtr?.value} status={m.vtr?.status} limit={m.vtr?.limit} period="30 days" numerator={m.vtr?.numerator} denominator={m.vtr?.denominator} />
            {m.otdr?.value !== null && m.otdr?.value !== undefined && (
              <MetricRow label="On-Time Delivery" value={m.otdr.value} status={m.otdr.status} limit={m.otdr.limit} period="14 days" numerator={m.otdr.numerator} denominator={m.otdr.denominator} />
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between text-[10px] text-ink-3 pt-2 mt-2 border-t border-rule">
          <span>
            {store.alertCount > 0 && (
              <span className="text-warn font-medium mr-2">
                {store.alertCount} issue{store.alertCount > 1 ? "s" : ""}
              </span>
            )}
            {store.syncedAt && (
              <>
                Synced:{" "}
                {new Date(store.syncedAt).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </>
            )}
          </span>
          <button
            onClick={() => onSync(store.storeIndex)}
            disabled={syncing}
            className="text-green-mid hover:text-green-deep flex items-center gap-1"
          >
            {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            <span>Sync</span>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AccountHealthPage() {
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncingStores, setSyncingStores] = useState<Set<number>>(new Set());
  const [syncingAll, setSyncingAll] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/amazon/account-health");
      setData(await res.json());
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (mounted) fetchData(); }, [mounted, fetchData]);

  const syncStore = async (idx: number) => {
    setSyncingStores((prev) => new Set(prev).add(idx));
    try {
      await fetch("/api/amazon/account-health/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeIndex: idx }),
      });
      await fetchData();
    } catch { /* ignore */ } finally {
      setSyncingStores((prev) => { const n = new Set(prev); n.delete(idx); return n; });
    }
  };

  const syncAll = async () => {
    setSyncingAll(true);
    try {
      await fetch("/api/amazon/account-health/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await fetchData();
    } catch { /* ignore */ } finally {
      setSyncingAll(false);
    }
  };

  if (!mounted) return null;

  const s = data?.summary;
  const overall: "healthy" | "warning" | "critical" = s
    ? s.critical > 0
      ? "critical"
      : s.warning > 0
        ? "warning"
        : "healthy"
    : "healthy";
  const overallLabel =
    overall === "critical"
      ? "Critical"
      : overall === "warning"
        ? "Warning"
        : "Healthy";

  return (
    <div className="space-y-5">
      <PageHead
        title="Account Health"
        syncChip={data?.fetchedAt && <SyncChip when={data.fetchedAt} />}
        subtitle={
          s ? (
            <>
              <span>
                <strong className="text-ink tabular">{s.configured}</strong> of{" "}
                {s.total} stores monitored
              </span>
              <Sep />
              <span className="font-mono text-[10.5px] uppercase tracking-wider">
                SP-API · 4H POLL
              </span>
            </>
          ) : (
            <span>Loading…</span>
          )
        }
        actions={
          <>
            <Btn
              icon={<RefreshCw size={13} />}
              onClick={syncAll}
              loading={syncingAll}
              disabled={syncingAll}
            >
              {syncingAll ? "Syncing…" : "Refresh all"}
            </Btn>
            <Btn variant="ghost" icon={<Calendar size={13} />}>
              90-day view
            </Btn>
            <Btn variant="primary" icon={<Plus size={13} />}>
              Action plan
            </Btn>
          </>
        }
      />

      {/* HERO: overall + summary */}
      {s && (
        <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr_1fr]">
          <HeroGreenCard>
            <HeroLabel>Overall health</HeroLabel>
            <div
              className="mt-2 font-semibold leading-none"
              style={{
                fontSize: 44,
                letterSpacing: "-0.04em",
                color: "var(--green-cream)",
              }}
            >
              {overallLabel}
            </div>
            <div
              className="mt-2 max-w-md text-[12.5px]"
              style={{ color: "rgba(240,232,208,0.78)" }}
            >
              {overall === "healthy"
                ? `All ${s.configured} configured stores within Amazon limits.`
                : overall === "warning"
                  ? `${s.warning} store${s.warning > 1 ? "s" : ""} trending toward threshold.`
                  : `${s.critical} store${s.critical > 1 ? "s" : ""} breaching policy — immediate action.`}
            </div>

            <HeroDivider className="my-4" />

            <div className="grid grid-cols-2 gap-6">
              <div>
                <HeroLabel>Stores at risk</HeroLabel>
                <div
                  className="mt-1 tabular"
                  style={{ fontSize: 24, fontWeight: 600, color: "var(--green-cream)" }}
                >
                  {s.warning + s.critical}
                  <span
                    className="ml-1.5 text-[11px]"
                    style={{ color: "rgba(240,232,208,0.6)" }}
                  >
                    of {s.total}
                  </span>
                </div>
                <div
                  className="mt-1 text-[11px]"
                  style={{ color: "rgba(240,232,208,0.6)" }}
                >
                  {s.warning} warning · {s.critical} critical
                </div>
              </div>
              <div>
                <HeroLabel>Healthy stores</HeroLabel>
                <div
                  className="mt-1 tabular"
                  style={{ fontSize: 24, fontWeight: 600, color: "var(--green-cream)" }}
                >
                  {s.healthy}
                </div>
                <div
                  className="mt-1 text-[11px]"
                  style={{ color: "rgba(240,232,208,0.6)" }}
                >
                  all metrics under limit
                </div>
              </div>
            </div>
          </HeroGreenCard>

          <KpiCard
            label="Configured"
            value={`${s.configured}/${s.total}`}
            trend={{
              value: `${s.configured}`,
              subText: "Amazon stores",
            }}
          />
          <KpiCard
            label="Healthy"
            value={s.healthy}
            iconVariant={s.healthy === s.configured ? "default" : "warn"}
            chips={[
              {
                label:
                  s.critical > 0
                    ? `${s.critical} critical`
                    : s.warning > 0
                      ? `${s.warning} warn`
                      : "all clear",
                variant:
                  s.critical > 0
                    ? "urgent"
                    : s.warning > 0
                      ? "neutral"
                      : "ok",
              },
            ]}
          />
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-ink-3 mr-2" />
          <span className="text-sm text-ink-3">Loading...</span>
        </div>
      )}

      {data?.stores && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {data.stores.map((store) => (
            <StoreCard
              key={store.storeIndex}
              store={store}
              onSync={syncStore}
              syncing={syncingStores.has(store.storeIndex) || syncingAll}
            />
          ))}
        </div>
      )}

      <WalmartPerformancePanel />
    </div>
  );
}
