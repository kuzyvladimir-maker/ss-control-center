"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  DollarSign,
  ShoppingCart,
  TrendingUp,
  Package,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import StoreTabs from "@/components/cs/StoreTabs";

interface SalesData {
  summary: {
    totalRevenue: number;
    totalOrders: number;
    avgOrderValue: number;
    shipped: number;
    cancelled: number;
  };
  dailyRevenue: { date: string; revenue: number; orders: number }[];
  byStatus: { status: string; count: number }[];
}

interface StoreInfo {
  index: number;
  configured: boolean;
  channel: string;
  name: string;
  comingSoon?: boolean;
}

const statusColors: Record<string, string> = {
  Shipped: "bg-green-soft2 text-green-ink",
  Unshipped: "bg-warn-tint text-warn-strong",
  Pending: "bg-warn-tint text-warn-strong",
  Canceled: "bg-danger-tint text-danger",
  PartiallyShipped: "bg-green-soft2 text-green-deep",
};

export default function AnalyticsPage() {
  const [mounted, setMounted] = useState(false);
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [activeStore, setActiveStore] = useState(0); // 0 = all stores
  const [data, setData] = useState<SalesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setMounted(true);
    fetch("/api/amazon/stores")
      .then((r) => r.json())
      .then((d) => {
        // Add "All Stores" option
        const allStores = [
          { index: 0, configured: true, channel: "All", name: "All Stores" },
          ...(d.stores || []),
        ];
        setStores(allStores);
      })
      .catch(() => {});
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (activeStore > 0) params.set("store", String(activeStore));
      const res = await fetch(`/api/analytics/sales?${params}`);
      setData(await res.json());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [activeStore, days]);

  useEffect(() => {
    if (mounted) fetchData();
  }, [mounted, fetchData]);

  if (!mounted) return null;

  // Find max revenue for chart scaling
  const maxRevenue = data
    ? Math.max(...data.dailyRevenue.map((d) => d.revenue), 1)
    : 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">
          Sales Analytics
        </h1>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="rounded-md border border-rule bg-white px-3 py-1.5 text-xs"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            disabled={loading}
          >
            {loading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
          </Button>
        </div>
      </div>

      {/* Store tabs */}
      <StoreTabs
        stores={stores}
        activeStore={activeStore}
        onSelect={setActiveStore}
      />

      {/* No data state */}
      {data && data.summary.totalOrders === 0 && !loading && (
        <Card className="border-rule">
          <CardContent className="py-10 text-center">
            <DollarSign size={32} className="mx-auto text-ink-4 mb-3" />
            <p className="text-sm font-medium text-ink-2">
              No order data yet
            </p>
            <p className="text-xs text-ink-3 mt-1">
              Go to Settings &rarr; Data Synchronization &rarr; Sync Orders to
              pull data from Amazon SP-API
            </p>
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      {data && data.summary.totalOrders > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="rounded-lg bg-green-soft p-2.5">
                  <DollarSign size={18} className="text-green" />
                </div>
                <div>
                  <p className="text-xs text-ink-3">Revenue</p>
                  <p className="text-xl font-bold text-ink">
                    ${data.summary.totalRevenue.toLocaleString()}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="rounded-lg bg-green-soft p-2.5">
                  <ShoppingCart size={18} className="text-green" />
                </div>
                <div>
                  <p className="text-xs text-ink-3">Orders</p>
                  <p className="text-xl font-bold text-ink">
                    {data.summary.totalOrders}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="rounded-lg bg-warn-tint p-2.5">
                  <TrendingUp size={18} className="text-warn" />
                </div>
                <div>
                  <p className="text-xs text-ink-3">Avg Order</p>
                  <p className="text-xl font-bold text-ink">
                    ${data.summary.avgOrderValue.toFixed(2)}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="rounded-lg bg-emerald-50 p-2.5">
                  <Package size={18} className="text-emerald-600" />
                </div>
                <div>
                  <p className="text-xs text-ink-3">Shipped</p>
                  <p className="text-xl font-bold text-ink">
                    {data.summary.shipped}
                  </p>
                  {data.summary.cancelled > 0 && (
                    <p className="text-[10px] text-danger">
                      {data.summary.cancelled} cancelled
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Revenue chart (CSS bar chart) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                Daily Revenue ({days} days)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-end gap-px h-40">
                {data.dailyRevenue.map((day) => {
                  const height =
                    maxRevenue > 0
                      ? Math.max((day.revenue / maxRevenue) * 100, 1)
                      : 1;
                  const isToday =
                    day.date === new Date().toISOString().split("T")[0];
                  return (
                    <div
                      key={day.date}
                      className="group relative flex-1 min-w-0"
                    >
                      <div
                        className={`w-full rounded-t-sm transition-colors ${
                          isToday
                            ? "bg-green-soft0"
                            : day.revenue > 0
                              ? "bg-info-tint hover:bg-info"
                              : "bg-bg-elev"
                        }`}
                        style={{ height: `${height}%` }}
                      />
                      {/* Tooltip */}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                        <div className="bg-ink text-green-cream text-[9px] rounded px-1.5 py-1 whitespace-nowrap">
                          {new Date(day.date + "T12:00:00").toLocaleDateString(
                            "en-US",
                            { month: "short", day: "numeric" }
                          )}
                          <br />${day.revenue.toFixed(2)} ({day.orders} orders)
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* X-axis labels */}
              <div className="flex justify-between mt-1 text-[9px] text-ink-3">
                {data.dailyRevenue.length > 0 && (
                  <>
                    <span>
                      {new Date(
                        data.dailyRevenue[0].date + "T12:00:00"
                      ).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span>
                      {new Date(
                        data.dailyRevenue[data.dailyRevenue.length - 1].date +
                          "T12:00:00"
                      ).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Orders by status */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Orders by Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                {data.byStatus.map((s) => (
                  <div
                    key={s.status}
                    className="flex items-center gap-2 rounded-lg border border-rule px-3 py-2"
                  >
                    <Badge
                      className={
                        statusColors[s.status] || "bg-bg-elev text-ink-2"
                      }
                    >
                      {s.status}
                    </Badge>
                    <span className="text-sm font-bold text-ink">
                      {s.count}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
