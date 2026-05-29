"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  DollarSign,
  AlertTriangle,
  TrendingDown,
  Download,
} from "lucide-react";
import {
  Btn,
  FilterTabs,
  KpiCard,
  PageHead,
  Panel,
  PanelBody,
  PanelHeader,
  Sep,
  StoreAvatar,
} from "@/components/kit";
import { Info, RefreshCw } from "lucide-react";
import AdjustmentsTable from "@/components/adjustments/AdjustmentsTable";
import SkuIssuesPanel from "@/components/adjustments/SkuIssuesPanel";

interface Stats {
  thisMonth: number;
  thisMonthCount: number;
  last30Days: number;
  last30Count: number;
  amazonTotal: number;
  walmartTotal: number;
  problematicSkus: number;
}

export default function AdjustmentsPage() {
  const [mounted, setMounted] = useState(false);

  // Stats
  const [stats, setStats] = useState<Stats | null>(null);

  // Adjustments list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [adjustments, setAdjustments] = useState<any[]>([]);
  const [adjTotal, setAdjTotal] = useState(0);
  const [adjLoading, setAdjLoading] = useState(false);
  const [filters, setFilters] = useState({
    channel: "",
    days: "30",
    sku: "",
  });

  // SKU profiles
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [skuProfiles, setSkuProfiles] = useState<any[]>([]);

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/adjustments/stats");
      setStats(await res.json());
    } catch {
      // ignore
    }
  }, []);

  const fetchAdjustments = useCallback(async () => {
    setAdjLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.channel) params.set("channel", filters.channel);
      params.set("days", filters.days);
      if (filters.sku) params.set("sku", filters.sku);
      const res = await fetch(`/api/adjustments?${params.toString()}`);
      const data = await res.json();
      setAdjustments(data.adjustments || []);
      setAdjTotal(data.total || 0);
    } catch {
      console.error("Failed to fetch adjustments");
    } finally {
      setAdjLoading(false);
    }
  }, [filters]);

  const fetchSkuProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/adjustments/sku-profiles");
      setSkuProfiles(await res.json());
    } catch {
      // ignore
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchStats();
    fetchAdjustments();
    fetchSkuProfiles();
  }, [fetchStats, fetchAdjustments, fetchSkuProfiles]);

  /**
   * Three-step sync:
   *   1/3 Amazon Financial Events (real-time, ~5-10s, dollar totals only)
   *   2/3 Amazon Settlement Reports (~30-60s, adds order-id + SKU linkage)
   *   3/3 Walmart Recon Reports (~10-30s per available date,
   *       mirrors adjustment rows into ShippingAdjustment with
   *       channel='Walmart')
   */
  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncMessage(null);
    setSyncError(null);
    try {
      setSyncMessage("Step 1/3 — Amazon Financial Events…");
      const scanRes = await fetch("/api/adjustments/scan", { method: "POST" });
      const scanJson = await scanRes.json();
      if (!scanRes.ok) {
        throw new Error(scanJson.error || `Scan failed (${scanRes.status})`);
      }

      setSyncMessage(
        `Step 2/3 — Amazon Settlement Reports… (FE added ${scanJson.totalNewSaved} new)`,
      );
      const settleRes = await fetch("/api/adjustments/settlement-sync", {
        method: "POST",
      });
      const settleJson = await settleRes.json();
      if (!settleRes.ok) {
        throw new Error(
          settleJson.error || `Settlement sync failed (${settleRes.status})`,
        );
      }

      setSyncMessage(
        `Step 3/3 — Walmart Recon Reports… (Settlement +${settleJson.totalInserted}, ${settleJson.totalEnriched} enriched)`,
      );
      const walmartRes = await fetch("/api/adjustments/walmart/sync", {
        method: "POST",
        // Cap to last 8 settlement dates to keep the live sync snappy;
        // the daily cron walks the full history.
        body: JSON.stringify({ maxDates: 8 }),
        headers: { "Content-Type": "application/json" },
      });
      const walmartJson = await walmartRes.json();
      if (!walmartRes.ok) {
        // Don't fail the whole sync on Walmart-only errors — the
        // Walmart credentials may not be set for every environment.
        console.warn("Walmart sync failed:", walmartJson);
      }

      const walmartSummary = walmartRes.ok
        ? ` Walmart: +${walmartJson.totalAdjustmentsInserted ?? 0} adj inserted, ${walmartJson.totalAdjustmentsEnriched ?? 0} enriched.`
        : " Walmart sync skipped (check WALMART_* env).";

      setSyncMessage(
        `Done. Amazon FE: +${scanJson.totalNewSaved}. ` +
          `Settlement: +${settleJson.totalInserted}, ${settleJson.totalEnriched} enriched.` +
          walmartSummary,
      );
      refreshAll();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [refreshAll]);

  useEffect(() => {
    if (mounted) {
      fetchStats();
      fetchAdjustments();
      fetchSkuProfiles();
    }
  }, [mounted, fetchStats, fetchAdjustments, fetchSkuProfiles]);

  if (!mounted) return null;

  // Tab filter — filters adjustments by type / channel
  const channelTabs = [
    { id: "", label: "All", count: adjTotal },
    {
      id: "Amazon",
      label: "Amazon",
      count: adjustments.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any) => a.channel === "Amazon"
      ).length,
    },
    {
      id: "Walmart",
      label: "Walmart",
      count: adjustments.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any) => a.channel === "Walmart"
      ).length,
    },
  ];

  return (
    <div className="space-y-5">
      <PageHead
        title="Adjustments"
        subtitle={
          stats ? (
            <>
              <span className="tabular">
                <strong className="text-ink">
                  {stats.thisMonthCount + stats.last30Count}
                </strong>{" "}
                transactions tracked
              </span>
              <Sep />
              <span className="font-mono text-[10.5px] uppercase tracking-wider">
                SP-API Finances v2024-06-19
              </span>
            </>
          ) : (
            <span>Loading…</span>
          )
        }
        actions={
          <div className="flex items-center gap-2">
            <Btn
              icon={
                syncing ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )
              }
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </Btn>
            <Btn
              icon={<RefreshCw size={13} />}
              onClick={refreshAll}
              disabled={syncing}
            >
              Refresh
            </Btn>
          </div>
        }
      />

      {/* Sync status banner */}
      {(syncMessage || syncError) && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-4 py-2.5 text-[12.5px] ${
            syncError
              ? "border-danger/20 bg-danger-tint text-danger-strong"
              : "border-rule bg-surface-tint text-ink-2"
          }`}
        >
          {syncError ? (
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          ) : (
            <Info size={14} className="mt-0.5 shrink-0 text-ink-3" />
          )}
          <div>
            <strong className="text-ink">
              {syncError ? "Sync failed." : "Sync"}
            </strong>{" "}
            {syncError || syncMessage}
          </div>
        </div>
      )}

      {/* Sync notice — SP-API has ~48h settlement delay */}
      <div className="flex items-start gap-2 rounded-lg border border-rule bg-surface-tint px-4 py-2.5 text-[12.5px] text-ink-2">
        <Info size={14} className="mt-0.5 shrink-0 text-ink-3" />
        <div>
          <strong className="text-ink">SP-API settlement delay.</strong> Amazon
          posts shipping adjustments to the Finances endpoint ≈ 48 hours after
          the event. Very recent rows will show up on the next sync.
        </div>
      </div>

      {/* KPI row */}
      {stats && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="This month"
            value={`$${Math.abs(stats.thisMonth).toFixed(2)}`}
            icon={<TrendingDown size={14} />}
            iconVariant="warn"
            trend={{ value: `${stats.thisMonthCount} adj`, positive: false }}
          />
          <KpiCard
            label="Last 30 days"
            value={`$${Math.abs(stats.last30Days).toFixed(2)}`}
            icon={<DollarSign size={14} />}
            trend={{ value: `${stats.last30Count} adj`, positive: false }}
          />
          <KpiCard
            label="Amazon"
            value={`$${Math.abs(stats.amazonTotal).toFixed(2)}`}
            icon={<StoreAvatar store="salutem" size="sm" />}
          />
          <KpiCard
            label="Walmart"
            value={`$${Math.abs(stats.walmartTotal).toFixed(2)}`}
            icon={<StoreAvatar store="walmart" size="sm" />}
          />
        </div>
      )}

      {stats && stats.problematicSkus > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/20 bg-warn-tint px-4 py-2.5 text-[12.5px] text-warn-strong">
          <AlertTriangle size={14} />
          <span>
            <strong>
              {stats.problematicSkus} SKU
              {stats.problematicSkus > 1 ? "s" : ""}
            </strong>{" "}
            with systematic issues (corrected 3+ times in 30 days)
          </span>
        </div>
      )}

      {/* Filter tabs — channel */}
      <FilterTabs
        tabs={channelTabs}
        active={filters.channel}
        onChange={(id) => setFilters({ ...filters, channel: id })}
        rightSlot={
          <span className="text-[11px] font-mono uppercase tracking-wider text-ink-3 tabular">
            {adjTotal} rows · last {filters.days}d
          </span>
        }
      />

      {/* Adjustments list */}
      <Panel>
        <PanelHeader
          title="Shipping adjustments"
          right={
            adjLoading && <Loader2 size={14} className="animate-spin text-ink-3" />
          }
        />
        <PanelBody>
          <AdjustmentsTable
            adjustments={adjustments}
            total={adjTotal}
            filters={filters}
            onFiltersChange={setFilters}
          />
        </PanelBody>
      </Panel>

      {/* SKU Issues */}
      <Panel>
        <PanelHeader title="SKU issues — need SKU Database v2 update" />
        <PanelBody>
          <SkuIssuesPanel profiles={skuProfiles} />
        </PanelBody>
      </Panel>
    </div>
  );
}
