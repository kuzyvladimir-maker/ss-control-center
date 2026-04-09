"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, DollarSign, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="space-y-6">
      {/* Stat cards */}
      {stats && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {statCards.map((stat) => (
              <Card key={stat.title}>
                <CardContent className="py-4">
                  <p className="text-xs text-slate-500">{stat.title}</p>
                  <p className={`text-2xl font-bold ${stat.color}`}>
                    -{stat.value}
                  </p>
                  {stat.sub && (
                    <p className="text-[10px] text-slate-400">{stat.sub}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {stats.problematicSkus > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertTriangle size={16} />
              <span>
                <strong>{stats.problematicSkus} SKU{stats.problematicSkus > 1 ? "s" : ""}</strong> with
                systematic issues (corrected 3+ times in 30 days)
              </span>
            </div>
          )}
        </>
      )}

      {/* Adjustments list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span className="flex items-center gap-2">
              <DollarSign size={18} />
              Shipping Adjustments
            </span>
            {adjLoading && (
              <Loader2 size={16} className="animate-spin text-slate-400" />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AdjustmentsTable
            adjustments={adjustments}
            total={adjTotal}
            filters={filters}
            onFiltersChange={setFilters}
          />
        </CardContent>
      </Card>

      {/* SKU Issues */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            SKU Issues — Need SKU Database v2 Update
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SkuIssuesPanel profiles={skuProfiles} />
        </CardContent>
      </Card>
    </div>
  );
}
