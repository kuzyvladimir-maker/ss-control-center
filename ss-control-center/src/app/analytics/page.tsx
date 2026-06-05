"use client";

/**
 * Sales Overview — unified analytics across Amazon + Walmart with custom
 * date range, period-over-period comparison, channel/store breakdowns,
 * top SKUs, and the full orders list under the chart. Reads our local
 * cache (AmazonOrder / WalmartOrder), no Veeqo live calls.
 *
 * Cost of goods (COGS) / net profit is out of scope for v1 — we don't
 * have a SKU→cost source wired up yet. Slated for Phase 2.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Search,
  ArrowUpDown,
  TrendingUp,
  TrendingDown,
  Package,
  ShoppingCart,
  DollarSign,
  AlertCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────
// Types — mirror /api/sales-overview response
// ─────────────────────────────────────────────────────────────────────
type Preset =
  | "today"
  | "yesterday"
  | "mtd"
  | "lastMonth"
  | "last7"
  | "last30"
  | "last90";

interface SummaryBlock {
  revenue: number;
  orders: number;
  avgOrder: number;
  shipped: number;
  cancelled: number;
  pending: number;
}

interface OverviewResponse {
  period: { from: string; to: string; days: number; label: string };
  comparison: { from: string; to: string; days: number; label: string };
  summary: SummaryBlock & { prior: SummaryBlock };
  dailyRevenue: Array<{ date: string; revenue: number; orders: number }>;
  byChannel: Array<{ channel: string; revenue: number; orders: number }>;
  byStore: Array<{
    storeIndex: number;
    storeName: string;
    channel: string;
    revenue: number;
    orders: number;
  }>;
  byStatus: Array<{ status: string; count: number }>;
  topSkus: Array<{ sku: string; productName: string | null; qty: number }>;
  orders: Array<{
    source: "amazon" | "walmart";
    id: string;
    number: string;
    date: string;
    total: number;
    currency: string;
    status: string;
    rawStatus: string;
    customer: string | null;
    city: string | null;
    state: string | null;
    itemsCount: number;
    storeIndex: number;
    storeName: string;
    channel: "amazon" | "walmart";
  }>;
  totalOrdersInWindow: number;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

const fmtMoneyExact = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const fmtDateShort = (iso: string) => {
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00" : ""));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Today (Eastern TZ) as a YYYY-MM-DD string — used to seed the date picker. */
function todayET(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "numeric",
  });
  return fmt.format(new Date());
}

function addDays(yyyyMmDd: string, days: number): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function pctDelta(curr: number, prior: number): {
  delta: number;
  pct: number;
  positive: boolean;
} {
  const delta = curr - prior;
  const pct = prior > 0 ? (delta / prior) * 100 : curr > 0 ? 100 : 0;
  return { delta, pct, positive: delta >= 0 };
}

const CHANNEL_COLOR: Record<string, string> = {
  amazon: "#ff9900",
  walmart: "#0071dc",
};

const STATUS_COLOR: Record<string, string> = {
  Shipped: "bg-green-soft2 text-green-ink",
  Cancelled: "bg-danger-tint text-danger",
  Pending: "bg-warn-tint text-warn-strong",
  Acknowledged: "bg-info-tint text-info",
  Unshipped: "bg-warn-tint text-warn-strong",
  Created: "bg-bg-elev text-ink-2",
};

// ─────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────
export default function SalesOverviewPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [preset, setPreset] = useState<Preset | "custom">("last30");
  const [customFrom, setCustomFrom] = useState<string>(addDays(todayET(), -29));
  const [customTo, setCustomTo] = useState<string>(todayET());
  const [channel, setChannel] = useState<"all" | "amazon" | "walmart">("all");

  // Orders-list local controls (sort + filter + search). The list is
  // capped server-side at 200 rows; we sort/filter/search on whatever
  // we have client-side for instant feedback.
  const [orderSort, setOrderSort] = useState<"date" | "total">("date");
  const [orderSortDir, setOrderSortDir] = useState<"asc" | "desc">("desc");
  const [orderStatus, setOrderStatus] = useState<string>("all");
  const [orderSearch, setOrderSearch] = useState<string>("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (preset === "custom") {
        sp.set("from", customFrom);
        sp.set("to", customTo);
      } else {
        sp.set("preset", preset);
      }
      if (channel !== "all") sp.set("channel", channel);
      const res = await fetch(`/api/sales-overview?${sp.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as OverviewResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [preset, customFrom, customTo, channel]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Filtered / sorted order list for rendering
  const displayedOrders = useMemo(() => {
    if (!data) return [];
    const q = orderSearch.trim().toLowerCase();
    let rows = data.orders;
    if (orderStatus !== "all") {
      rows = rows.filter((o) => o.status === orderStatus);
    }
    if (q) {
      rows = rows.filter(
        (o) =>
          o.number.toLowerCase().includes(q) ||
          (o.customer ?? "").toLowerCase().includes(q) ||
          (o.city ?? "").toLowerCase().includes(q) ||
          (o.state ?? "").toLowerCase().includes(q) ||
          o.storeName.toLowerCase().includes(q),
      );
    }
    const sorted = [...rows].sort((a, b) => {
      if (orderSort === "date") {
        return orderSortDir === "desc"
          ? new Date(b.date).getTime() - new Date(a.date).getTime()
          : new Date(a.date).getTime() - new Date(b.date).getTime();
      }
      return orderSortDir === "desc" ? b.total - a.total : a.total - b.total;
    });
    return sorted;
  }, [data, orderSearch, orderStatus, orderSort, orderSortDir]);

  const maxRevenue = useMemo(() => {
    if (!data || data.dailyRevenue.length === 0) return 1;
    return Math.max(...data.dailyRevenue.map((d) => d.revenue), 1);
  }, [data]);

  return (
    <div className="space-y-4">
      {/* Header + Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Sales Overview</h1>
          <p className="text-[11px] text-ink-3">
            All channels we cache locally (Amazon + Walmart). Reads from our DB —
            no live Veeqo calls.
          </p>
        </div>
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
          <span className="ml-1.5">Refresh</span>
        </Button>
      </div>

      {/* Filters row — period preset, custom date range, channel chips */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          <div className="flex items-center gap-1">
            {(
              [
                ["today", "Today"],
                ["yesterday", "Yesterday"],
                ["last7", "7d"],
                ["last30", "30d"],
                ["last90", "90d"],
                ["mtd", "MTD"],
                ["lastMonth", "Last month"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setPreset(id)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition",
                  preset === id
                    ? "border-green bg-green-soft text-green-ink"
                    : "border-rule bg-surface text-ink-2 hover:border-silver-line",
                )}
              >
                {label}
              </button>
            ))}
            <span className="mx-1 text-ink-4">·</span>
            <button
              type="button"
              onClick={() => setPreset("custom")}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition",
                preset === "custom"
                  ? "border-green bg-green-soft text-green-ink"
                  : "border-rule bg-surface text-ink-2 hover:border-silver-line",
              )}
            >
              Custom
            </button>
          </div>

          {preset === "custom" && (
            <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-md border border-rule bg-surface px-2 py-1 text-[12px] text-ink focus:border-green focus:outline-none"
              />
              <span>→</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={todayET()}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-md border border-rule bg-surface px-2 py-1 text-[12px] text-ink focus:border-green focus:outline-none"
              />
            </div>
          )}

          <div className="ml-auto flex items-center gap-1">
            <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3 mr-1">
              Channel
            </span>
            {(
              [
                ["all", "All"],
                ["amazon", "Amazon"],
                ["walmart", "Walmart"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setChannel(id)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition",
                  channel === id
                    ? id === "amazon"
                      ? "border-[#ff9900] bg-[#ff9900]/10 text-[#232f3e]"
                      : id === "walmart"
                        ? "border-[#0071dc] bg-[#0071dc]/10 text-[#0071dc]"
                        : "border-green bg-green-soft text-green-ink"
                    : "border-rule bg-surface text-ink-2 hover:border-silver-line",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-danger">
          <CardContent className="flex items-center gap-2 py-3 text-[12.5px] text-danger">
            <AlertCircle size={14} />
            {error}
          </CardContent>
        </Card>
      )}

      {/* KPI tiles with prior-period comparison */}
      {data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Revenue"
            value={fmtMoney(data.summary.revenue)}
            tooltip={fmtMoneyExact(data.summary.revenue)}
            priorValue={fmtMoney(data.summary.prior.revenue)}
            delta={pctDelta(data.summary.revenue, data.summary.prior.revenue)}
            icon={<DollarSign size={14} />}
          />
          <KpiTile
            label="Orders"
            value={data.summary.orders.toLocaleString()}
            priorValue={data.summary.prior.orders.toLocaleString()}
            delta={pctDelta(data.summary.orders, data.summary.prior.orders)}
            icon={<ShoppingCart size={14} />}
          />
          <KpiTile
            label="Avg order"
            value={fmtMoneyExact(data.summary.avgOrder)}
            priorValue={fmtMoneyExact(data.summary.prior.avgOrder)}
            delta={pctDelta(data.summary.avgOrder, data.summary.prior.avgOrder)}
            icon={<TrendingUp size={14} />}
          />
          <KpiTile
            label="Shipped"
            value={data.summary.shipped.toLocaleString()}
            priorValue={data.summary.prior.shipped.toLocaleString()}
            delta={pctDelta(data.summary.shipped, data.summary.prior.shipped)}
            icon={<Package size={14} />}
            footer={
              data.summary.cancelled > 0
                ? `${data.summary.cancelled} cancelled`
                : undefined
            }
          />
        </div>
      )}

      {/* Daily revenue chart */}
      {data && data.dailyRevenue.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Daily revenue — {data.period.label}{" "}
              <span className="text-[11px] font-normal text-ink-3">
                ({data.period.days} day{data.period.days === 1 ? "" : "s"})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex h-48 items-end gap-[2px]">
              {data.dailyRevenue.map((day) => {
                const heightPct =
                  day.revenue > 0
                    ? Math.max((day.revenue / maxRevenue) * 100, 2)
                    : 0;
                return (
                  <div
                    key={day.date}
                    className="group relative flex h-full flex-1 flex-col justify-end"
                  >
                    <div
                      className={cn(
                        "w-full rounded-t transition-colors",
                        day.revenue > 0
                          ? "bg-green/70 hover:bg-green"
                          : "bg-bg-elev",
                      )}
                      style={{ height: `${heightPct}%`, minHeight: day.revenue > 0 ? 2 : 1 }}
                    />
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-2 py-1 text-[10.5px] text-green-cream group-hover:block">
                      {fmtDateShort(day.date)} · {fmtMoneyExact(day.revenue)} ·{" "}
                      {day.orders} order{day.orders === 1 ? "" : "s"}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex justify-between text-[10.5px] text-ink-3">
              <span>{fmtDateShort(data.dailyRevenue[0].date)}</span>
              <span>
                {fmtDateShort(
                  data.dailyRevenue[data.dailyRevenue.length - 1].date,
                )}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Channel + Status side-by-side */}
      {data && (
        <div className="grid gap-3 lg:grid-cols-2">
          {/* Channel split */}
          {data.byChannel.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">By channel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.byChannel.map((c) => {
                  const totalRev = data.byChannel.reduce(
                    (s, x) => s + x.revenue,
                    0,
                  );
                  const pct = totalRev > 0 ? (c.revenue / totalRev) * 100 : 0;
                  return (
                    <div key={c.channel}>
                      <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[12px]">
                        <span className="font-medium capitalize text-ink">
                          {c.channel}
                        </span>
                        <span className="tabular text-ink-3">
                          {fmtMoneyExact(c.revenue)} · {c.orders} orders ·{" "}
                          {pct.toFixed(1)}%
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-bg-elev">
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${pct}%`,
                            background:
                              CHANNEL_COLOR[c.channel] ?? "var(--ink-3)",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Status split */}
          {data.byStatus.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">By status</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {data.byStatus.map((s) => (
                  <span
                    key={s.status}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium",
                      STATUS_COLOR[s.status] ?? "bg-bg-elev text-ink-2",
                    )}
                  >
                    {s.status}
                    <span className="tabular font-semibold">{s.count}</span>
                  </span>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* By store + Top SKUs side-by-side */}
      {data && (
        <div className="grid gap-3 lg:grid-cols-2">
          {/* By store */}
          {data.byStore.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">By store</CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[10.5px] uppercase tracking-wider text-ink-3">
                      <th className="pb-1 pr-2 font-medium">Store</th>
                      <th className="pb-1 pr-2 text-right font-medium">
                        Orders
                      </th>
                      <th className="pb-1 text-right font-medium">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byStore.map((s) => (
                      <tr key={`${s.channel}-${s.storeIndex}`} className="border-t border-rule/60">
                        <td className="py-1.5 pr-2">
                          <span className="text-ink">{s.storeName}</span>
                          <span className="ml-1.5 text-[10.5px] capitalize text-ink-3">
                            {s.channel}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular text-ink">
                          {s.orders}
                        </td>
                        <td className="py-1.5 text-right tabular text-ink">
                          {fmtMoneyExact(s.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Top SKUs (Amazon only for now — Walmart needs raw_data parse) */}
          {data.topSkus.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Top SKUs{" "}
                  <span className="text-[11px] font-normal text-ink-3">
                    (Amazon · by units shipped)
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[10.5px] uppercase tracking-wider text-ink-3">
                      <th className="pb-1 pr-2 font-medium">SKU</th>
                      <th className="pb-1 pr-2 font-medium">Product</th>
                      <th className="pb-1 text-right font-medium">Units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topSkus.map((s) => (
                      <tr key={s.sku} className="border-t border-rule/60">
                        <td className="py-1.5 pr-2 font-mono text-[11px] text-ink">
                          {s.sku}
                        </td>
                        <td className="py-1.5 pr-2 max-w-[220px] truncate text-ink-2">
                          {s.productName ?? "—"}
                        </td>
                        <td className="py-1.5 text-right tabular text-ink">
                          {s.qty}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Orders list */}
      {data && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-sm">
                Orders{" "}
                <span className="text-[11px] font-normal text-ink-3">
                  ({displayedOrders.length} of {data.totalOrdersInWindow}
                  {data.totalOrdersInWindow > data.orders.length
                    ? ` — showing first ${data.orders.length}, narrow date range to load more`
                    : ""}
                  )
                </span>
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search
                    size={12}
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
                  />
                  <Input
                    value={orderSearch}
                    onChange={(e) => setOrderSearch(e.target.value)}
                    placeholder="Search order / customer / state…"
                    className="h-8 w-[260px] pl-7 text-[12px]"
                  />
                </div>
                <select
                  value={orderStatus}
                  onChange={(e) => setOrderStatus(e.target.value)}
                  className="h-8 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink focus:border-green focus:outline-none"
                >
                  <option value="all">All statuses</option>
                  {data.byStatus.map((s) => (
                    <option key={s.status} value={s.status}>
                      {s.status} ({s.count})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[860px] text-[12px]">
              <thead className="border-b border-rule bg-surface-tint text-[10.5px] uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Order #</th>
                  <th
                    className="px-3 py-2 text-left font-medium cursor-pointer select-none hover:text-ink-2"
                    onClick={() => {
                      if (orderSort === "date") {
                        setOrderSortDir(orderSortDir === "desc" ? "asc" : "desc");
                      } else {
                        setOrderSort("date");
                        setOrderSortDir("desc");
                      }
                    }}
                  >
                    Date <ArrowUpDown size={9} className="inline" />
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Channel</th>
                  <th className="px-3 py-2 text-left font-medium">Store</th>
                  <th className="px-3 py-2 text-left font-medium">Customer</th>
                  <th className="px-3 py-2 text-left font-medium">Ship-to</th>
                  <th className="px-3 py-2 text-right font-medium">Items</th>
                  <th
                    className="px-3 py-2 text-right font-medium cursor-pointer select-none hover:text-ink-2"
                    onClick={() => {
                      if (orderSort === "total") {
                        setOrderSortDir(orderSortDir === "desc" ? "asc" : "desc");
                      } else {
                        setOrderSort("total");
                        setOrderSortDir("desc");
                      }
                    }}
                  >
                    Total <ArrowUpDown size={9} className="inline" />
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {displayedOrders.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-ink-3">
                      No orders match the current filters.
                    </td>
                  </tr>
                )}
                {displayedOrders.map((o) => (
                  <tr
                    key={`${o.source}-${o.id}`}
                    className="border-t border-rule/60 hover:bg-bg-elev/30"
                  >
                    <td className="px-3 py-2 font-mono text-[11px] text-ink">
                      {o.number}
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      {fmtDateTime(o.date)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                        style={{
                          background: `${CHANNEL_COLOR[o.channel]}20`,
                          color: CHANNEL_COLOR[o.channel],
                        }}
                      >
                        {o.channel}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink-2">{o.storeName}</td>
                    <td className="px-3 py-2 text-ink-2">{o.customer ?? "—"}</td>
                    <td className="px-3 py-2 text-ink-3">
                      {o.city || o.state
                        ? `${o.city ?? ""}${o.city && o.state ? ", " : ""}${o.state ?? ""}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular text-ink-2">
                      {o.itemsCount}
                    </td>
                    <td className="px-3 py-2 text-right tabular font-medium text-ink">
                      {fmtMoneyExact(o.total)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-block rounded px-1.5 py-0.5 text-[10.5px] font-medium",
                          STATUS_COLOR[o.status] ?? "bg-bg-elev text-ink-2",
                        )}
                      >
                        {o.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {data && data.summary.orders === 0 && !loading && (
        <Card>
          <CardContent className="py-10 text-center">
            <Package size={32} className="mx-auto mb-3 text-ink-4" />
            <p className="text-sm font-medium text-ink-2">
              No orders in this window
            </p>
            <p className="mt-1 text-xs text-ink-3">
              Try a wider date range or check that the orders-amazon / orders-walmart crons are running.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Small components
// ─────────────────────────────────────────────────────────────────────
function KpiTile({
  label,
  value,
  priorValue,
  delta,
  icon,
  tooltip,
  footer,
}: {
  label: string;
  value: string;
  priorValue: string;
  delta: { delta: number; pct: number; positive: boolean };
  icon: React.ReactNode;
  tooltip?: string;
  footer?: string;
}) {
  const hasPrior = delta.pct !== 0 || priorValue !== "0";
  return (
    <div className="rounded-lg border border-rule bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-ink-3">
          {label}
        </div>
        <div
          className="grid h-7 w-7 place-items-center rounded-md bg-bg-elev text-ink-2"
          title={tooltip}
        >
          {icon}
        </div>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <div className="kpi-number" title={tooltip}>
          {value}
        </div>
        {hasPrior && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
              delta.positive
                ? "bg-green-soft text-green-ink"
                : "bg-danger-tint text-danger",
            )}
            title={`Prior period: ${priorValue}`}
          >
            {delta.positive ? (
              <TrendingUp size={10} />
            ) : (
              <TrendingDown size={10} />
            )}
            {delta.positive ? "+" : ""}
            {Math.abs(delta.pct).toFixed(1)}%
          </span>
        )}
      </div>
      <div className="mt-1 text-[10.5px] text-ink-3">
        Prior: {priorValue}
        {footer ? ` · ${footer}` : ""}
      </div>
    </div>
  );
}
