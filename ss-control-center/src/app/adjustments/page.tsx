"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, DollarSign, AlertTriangle, TrendingDown } from "lucide-react";
import {
  KpiCard,
  PageHead,
  Panel,
  PanelBody,
  PanelHeader,
  StoreAvatar,
} from "@/components/kit";
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
          color: "text-red-600",
          bg: "bg-red-50",
        },
        {
          title: "Last 30 Days",
          value: `$${Math.abs(stats.last30Days).toFixed(2)}`,
          sub: `${stats.last30Count} adj.`,
          color: "text-amber-600",
          bg: "bg-amber-50",
        },
        {
          title: "Amazon Total",
          value: `$${Math.abs(stats.amazonTotal).toFixed(2)}`,
          sub: "",
          color: "text-orange-600",
          bg: "bg-orange-50",
        },
        {
          title: "Walmart Total",
          value: `$${Math.abs(stats.walmartTotal).toFixed(2)}`,
          sub: "",
          color: "text-blue-600",
          bg: "bg-blue-50",
        },
      ]
    : [];

  return (
    <div className="space-y-5">
      <PageHead
        title="Adjustments"
        subtitle={
          stats ? (
            <span className="tabular">
              {stats.thisMonthCount + stats.last30Count} transactions tracked
            </span>
          ) : (
            <span>Loading…</span>
          )
        }
      />

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
            <strong>{stats.problematicSkus} SKU{stats.problematicSkus > 1 ? "s" : ""}</strong> with
            systematic issues (corrected 3+ times in 30 days)
          </span>
        </div>
      )}

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
