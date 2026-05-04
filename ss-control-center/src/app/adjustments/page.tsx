"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, DollarSign, AlertTriangle, TrendingDown } from "lucide-react";
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

  useEffect(() => {
    if (mounted) {
      fetchStats();
      fetchAdjustments();
      fetchSkuProfiles();
    }
  }, [mounted, fetchStats, fetchAdjustments, fetchSkuProfiles]);

  if (!mounted) return null;

  const statCards = stats
    ? [
        {
          title: "This Month",
          value: `$${Math.abs(stats.thisMonth).toFixed(2)}`,
          sub: `${stats.thisMonthCount} adj.`,
          color: "text-danger",
          bg: "bg-danger-tint",
        },
        {
          title: "Last 30 Days",
          value: `$${Math.abs(stats.last30Days).toFixed(2)}`,
          sub: `${stats.last30Count} adj.`,
          color: "text-warn-strong",
          bg: "bg-warn-tint",
        },
        {
          title: "Amazon Total",
          value: `$${Math.abs(stats.amazonTotal).toFixed(2)}`,
          sub: "",
          color: "text-warn-strong",
          bg: "bg-warn-tint",
        },
        {
          title: "Walmart Total",
          value: `$${Math.abs(stats.walmartTotal).toFixed(2)}`,
          sub: "",
          color: "text-green",
          bg: "bg-info-tint",
        },
      ]
    : [];

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
          <Btn
            icon={<RefreshCw size={13} />}
            onClick={() => {
              fetchStats();
              fetchAdjustments();
              fetchSkuProfiles();
            }}
          >
            Refresh
          </Btn>
        }
      />

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
