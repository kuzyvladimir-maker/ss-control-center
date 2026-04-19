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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoreData = any;

interface HealthResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stores: any[];
  summary: { total: number; configured: number; healthy: number; warning: number; critical: number };
  fetchedAt: string;
}

const statusBorder: Record<string, string> = {
  healthy: "border-green-400",
  warning: "border-amber-400",
  critical: "border-red-500",
  error: "border-red-300",
  syncing: "border-blue-300",
  pending: "border-slate-300",
  not_configured: "border-slate-200",
};

const statusBadge: Record<string, { label: string; className: string }> = {
  healthy: { label: "HEALTHY", className: "bg-green-100 text-green-700" },
  warning: { label: "WARNING", className: "bg-amber-100 text-amber-700" },
  critical: { label: "CRITICAL", className: "bg-red-600 text-white" },
  error: { label: "ERROR", className: "bg-red-100 text-red-700" },
  syncing: { label: "SYNCING", className: "bg-blue-100 text-blue-700" },
  pending: { label: "PENDING", className: "bg-slate-100 text-slate-500" },
  not_configured: { label: "NOT SET UP", className: "bg-slate-100 text-slate-400" },
};

const statusIcon: Record<string, string> = {
  ok: "text-green-500",
  warning: "text-amber-500",
  critical: "text-red-500",
  unknown: "text-slate-300",
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
      className={`flex items-center justify-between py-1 px-2 rounded text-xs ${
        isBad ? "bg-red-50" : isWarn ? "bg-amber-50/50" : ""
      } ${indent ? "ml-4" : ""}`}
    >
      <span className={`${indent ? "text-slate-400" : "text-slate-600"}`}>
        {label}
        {period && !indent && (
          <span className="text-slate-400 ml-1">({period})</span>
        )}
      </span>
      <div className="flex items-center gap-2">
        <span className={`font-mono font-semibold ${statusIcon[status] || "text-slate-400"}`}>
          {value !== null && value !== undefined ? `${value}%` : "—"}
        </span>
        {numerator !== null && numerator !== undefined && denominator !== null && denominator !== undefined && (
          <span className="text-[10px] text-slate-400">
            ({numerator}/{denominator})
          </span>
        )}
        {status === "ok" && <CheckCircle size={12} className="text-green-500" />}
        {status === "warning" && <AlertTriangle size={12} className="text-amber-500" />}
        {status === "critical" && (
          <span className="text-[10px] font-bold text-red-600">OVER</span>
        )}
        <span className="text-[10px] text-slate-400">{limit}</span>
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
  const border = statusBorder[store.status] || "border-slate-200";
  const badge = statusBadge[store.status] || statusBadge.not_configured;

  if (store.status === "not_configured") {
    return (
      <Card className={`border-2 ${border}`}>
        <CardContent className="py-5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-sm text-slate-600 flex items-center gap-1.5">
              <Store size={15} className="text-slate-400" />
              Store {store.storeIndex}
            </span>
            <Badge className={badge.className}>
              <Settings size={10} className="mr-1" />
              {badge.label}
            </Badge>
          </div>
          <p className="text-xs text-slate-400">
            Add <code className="bg-slate-100 px-1 rounded">AMAZON_SP_REFRESH_TOKEN_STORE{store.storeIndex}</code> to .env
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
          <p className="text-xs text-slate-400 mb-3">{store.message || "Waiting..."}</p>
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
              <Store size={15} className="text-red-400" />
              Store {store.storeIndex}
            </span>
            <Badge className={badge.className}><XCircle size={10} className="mr-1" />Error</Badge>
          </div>
          <p className="text-xs text-red-600 break-all">{store.error || store.message}</p>
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
            <Store size={15} className="text-slate-600" />
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
          <p className="text-xs text-slate-500 mb-3">
            {store.storeName}
            {store.sellerId && <span className="text-slate-400"> | {store.sellerId}</span>}
          </p>
        )}

        {m && (
          <div className="space-y-1">
            {/* Customer Service Performance */}
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
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
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mt-2">
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
        <div className="flex items-center justify-between text-[10px] text-slate-400 pt-2 mt-2 border-t border-slate-100">
          <span>
            {store.alertCount > 0 && (
              <span className="text-amber-600 font-medium mr-2">
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
            className="text-blue-500 hover:text-blue-700 flex items-center gap-1"
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">Account Health</h1>
          {data?.fetchedAt && (
            <p className="text-xs text-slate-400">
              {new Date(data.fetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={syncAll} disabled={syncingAll}>
          {syncingAll ? <Loader2 size={14} className="animate-spin mr-1" /> : <RefreshCw size={14} className="mr-1" />}
          {syncingAll ? "Syncing..." : "Sync All"}
        </Button>
      </div>

      {data?.summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Configured", value: `${data.summary.configured}/${data.summary.total}`, color: "text-slate-800" },
            { label: "Healthy", value: data.summary.healthy, color: "text-green-600" },
            { label: "Warning", value: data.summary.warning, color: "text-amber-600" },
            { label: "Critical", value: data.summary.critical, color: "text-red-600" },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="py-3 text-center">
                <p className="text-[10px] text-slate-500">{s.label}</p>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-slate-400 mr-2" />
          <span className="text-sm text-slate-500">Loading...</span>
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
