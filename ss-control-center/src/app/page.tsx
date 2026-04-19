"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ShoppingCart,
  Truck,
  MessageSquare,
  Scale,
  HeartPulse,
  Loader2,
  ArrowRight,
  RefreshCw,
  Store,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface DashboardData {
  orders: {
    total30d: number;
    awaitingShipment: number;
    shippedToday: number;
    store1: number;
    store2: number;
  };
  customerService: { openCases: number };
  claims: { active: number };
  health: { issues: number };
  adjustments: { monthlyTotal: number };
  walmart?: {
    ordersTotal30d: number;
    ordersToday: number;
    returnsPending: number;
    refundsLast7d: number;
    healthIssues: number;
    healthStatus: "no-data" | "healthy" | "warning" | "critical";
  };
  syncedAt: string;
  error?: string;
}

interface SyncStatus {
  stores: { configured: number; total: number };
  data: {
    orders: { count: number; perStore: Record<number, number> };
    adjustments: { count: number };
    feedback: { count: number };
    claims: { count: number };
  };
  lastSync: string | null;
  error?: string;
}

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<DashboardData | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    setLoading(true);
    setPageError(null);
    Promise.all([
      fetch("/api/dashboard/summary").then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(data.error || `Dashboard summary failed (${r.status})`);
        }
        return data as DashboardData;
      }),
      fetch("/api/sync/status").then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(data.error || `Sync status failed (${r.status})`);
        }
        return data as SyncStatus;
      }),
    ]).then(([d, s]) => {
      setData(d);
      setSyncStatus(s);
      setLoading(false);
    }).catch((err) => {
      setData(null);
      setSyncStatus(null);
      setPageError(err instanceof Error ? err.message : "Failed to load dashboard");
      setLoading(false);
    });
  }, [mounted]);

  const runSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: "orders" }),
      });
      // Reload data
      const [d, s] = await Promise.all([
        fetch("/api/dashboard/summary").then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            throw new Error(data.error || `Dashboard summary failed (${r.status})`);
          }
          return data as DashboardData;
        }),
        fetch("/api/sync/status").then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            throw new Error(data.error || `Sync status failed (${r.status})`);
          }
          return data as SyncStatus;
        }),
      ]);
      setData(d);
      setSyncStatus(s);
      setPageError(null);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Failed to refresh dashboard");
    } finally {
      setSyncing(false);
    }
  };

  if (!mounted || loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="animate-spin text-slate-400" size={32} />
      </div>
    );
  }

  const hasData = syncStatus && syncStatus.data.orders.count > 0;

  const statCards = data
    ? [
        {
          title: "Orders (30d)",
          value: data.orders.total30d,
          icon: ShoppingCart,
          color: "text-blue-600",
          bg: "bg-blue-50",
          sub: `Store 1: ${data.orders.store1} | Store 2: ${data.orders.store2}`,
        },
        {
          title: "Awaiting Ship",
          value: data.orders.awaitingShipment,
          icon: Truck,
          color: "text-green-600",
          bg: "bg-green-50",
          sub: `Shipped today: ${data.orders.shippedToday}`,
        },
        {
          title: "CS Cases Open",
          value: data.customerService.openCases,
          icon: MessageSquare,
          color: "text-amber-600",
          bg: "bg-amber-50",
          sub: data.claims.active > 0 ? `${data.claims.active} A-to-Z active` : "",
        },
        {
          title: "Health Issues",
          value: data.health.issues,
          icon: HeartPulse,
          color: data.health.issues > 0 ? "text-red-600" : "text-green-600",
          bg: data.health.issues > 0 ? "bg-red-50" : "bg-green-50",
          sub:
            data.adjustments.monthlyTotal < 0
              ? `Adjustments: $${Math.abs(data.adjustments.monthlyTotal).toFixed(2)}`
              : "",
        },
        ...(data.walmart
          ? [
              {
                title: "Walmart (30d)",
                value: data.walmart.ordersTotal30d,
                icon: Store,
                color:
                  data.walmart.healthStatus === "critical"
                    ? "text-red-600"
                    : data.walmart.healthStatus === "warning"
                      ? "text-amber-600"
                      : "text-blue-600",
                bg:
                  data.walmart.healthStatus === "critical"
                    ? "bg-red-50"
                    : data.walmart.healthStatus === "warning"
                      ? "bg-amber-50"
                      : "bg-blue-50",
                sub: `Today: ${data.walmart.ordersToday} | Returns: ${data.walmart.returnsPending} | Refunds 7d: $${data.walmart.refundsLast7d.toFixed(2)}`,
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className="space-y-6">
      {pageError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-4 text-sm text-red-700">
            {pageError}
          </CardContent>
        </Card>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">Dashboard</h1>
          {syncStatus?.lastSync && (
            <p className="text-xs text-slate-400">
              Last sync:{" "}
              {new Date(syncStatus.lastSync).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={runSync}
          disabled={syncing}
        >
          {syncing ? (
            <Loader2 size={14} className="animate-spin mr-1" />
          ) : (
            <RefreshCw size={14} className="mr-1" />
          )}
          {syncing ? "Syncing..." : "Sync Orders"}
        </Button>
      </div>

      {/* First sync prompt */}
      {!hasData && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="py-6 text-center">
            <p className="text-sm font-medium text-blue-800 mb-2">
              Welcome to SS Control Center
            </p>
            <p className="text-xs text-blue-600 mb-4">
              Click &ldquo;Sync Orders&rdquo; to pull data from Amazon SP-API for the first
              time. This will populate all modules with real data.
            </p>
            <Button
              onClick={runSync}
              disabled={syncing}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {syncing ? (
                <Loader2 size={14} className="animate-spin mr-1" />
              ) : (
                <RefreshCw size={14} className="mr-1" />
              )}
              {syncing ? "Syncing..." : "Sync Now"}
            </Button>
            {syncStatus && (
              <p className="text-[10px] text-blue-400 mt-2">
                {syncStatus.stores.configured} of {syncStatus.stores.total}{" "}
                stores configured
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Stat cards */}
      {data && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statCards.map((stat) => (
            <Card key={stat.title}>
              <CardContent className="flex items-center gap-4 py-4">
                <div className={`rounded-lg p-2.5 ${stat.bg}`}>
                  <stat.icon size={20} className={stat.color} />
                </div>
                <div>
                  <p className="text-sm text-slate-500">{stat.title}</p>
                  <p className="text-2xl font-bold text-slate-800">
                    {stat.value}
                  </p>
                  {stat.sub && (
                    <p className="text-[10px] text-slate-400">{stat.sub}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Sync status overview */}
      {syncStatus && hasData && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Data Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-center">
              <div>
                <p className="text-2xl font-bold text-slate-800">
                  {syncStatus.data.orders.count}
                </p>
                <p className="text-xs text-slate-400">Orders synced</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-800">
                  {syncStatus.data.adjustments.count}
                </p>
                <p className="text-xs text-slate-400">Adjustments</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-800">
                  {syncStatus.data.feedback.count}
                </p>
                <p className="text-xs text-slate-400">Feedback records</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-800">
                  {syncStatus.data.claims.count}
                </p>
                <p className="text-xs text-slate-400">A-to-Z claims</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Link href="/shipping">
            <Button className="bg-blue-600 hover:bg-blue-700" size="sm">
              <Truck size={14} className="mr-1" /> Shipping Labels
            </Button>
          </Link>
          <Link href="/customer-hub">
            <Button variant="outline" size="sm">
              <MessageSquare size={14} className="mr-1" /> Customer Hub
            </Button>
          </Link>
          <Link href="/account-health">
            <Button variant="outline" size="sm">
              <HeartPulse size={14} className="mr-1" /> Account Health
            </Button>
          </Link>
          <Link href="/claims/atoz">
            <Button variant="outline" size="sm">
              <Scale size={14} className="mr-1" /> A-to-Z Claims
            </Button>
          </Link>
          <Link href="/settings">
            <Button variant="ghost" size="sm">
              Settings <ArrowRight size={12} className="ml-1" />
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
