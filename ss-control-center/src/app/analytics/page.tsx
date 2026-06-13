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
import { ChannelToggle, channelHex, channelLabel } from "@/lib/channel-brands";

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
  units: number;
  avgOrder: number;
  shipped: number;
  cancelled: number;
  pending: number;
}

interface PeriodTile {
  label: string;
  summary: {
    revenue: number;
    orders: number;
    units: number;
    avgOrder: number;
    shipped: number;
    cancelled: number;
  };
  prior: {
    revenue: number;
    orders: number;
    units: number;
    avgOrder: number;
    shipped: number;
    cancelled: number;
  };
  priorLabel: string;
  isForecast?: boolean;
}

interface PeriodsResponse {
  asOf: string;
  forecast: { daysInMonth: number; elapsedDays: number; scale: number };
  tiles: {
    today: PeriodTile;
    yesterday: PeriodTile;
    mtd: PeriodTile;
    thisMonth: PeriodTile;
    lastMonth: PeriodTile;
  };
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
    source: "amazon" | "walmart" | "veeqo";
    id: string;
    number: string;
    date: string;
    total: number;
    customerPaidShipping: number | null;
    currency: string;
    status: string;
    rawStatus: string;
    customer: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    itemsCount: number;
    storeIndex: number;
    storeName: string;
    channel: string;
    items: Array<{
      sku: string;
      productName: string;
      imageUrl: string | null;
      quantity: number;
      unitPrice: number;
    }>;
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

// Channel colours + labels come from the shared brand kit
// (@/lib/channel-brands) so Sales Overview matches Shipping Labels exactly.

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
  // Channel filter — MULTI-select. Empty array = "All channels". Otherwise
  // a list of Veeqo type_codes (amazon / walmart / ebay / direct / etc.).
  // Clicking a chip toggles it; the "All" chip clears the selection.
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  // Stable, growing list of every channel ever seen in the data — so a
  // channel's chip doesn't vanish once it's filtered out of the response.
  const [knownChannels, setKnownChannels] = useState<string[]>([]);
  // Serialised filter for the API + effect deps. "" ⇒ all channels.
  const channelsKey = [...selectedChannels].sort().join(",");
  const channelsParam = selectedChannels.length > 0 ? channelsKey : "all";

  const toggleChannel = useCallback((c: string) => {
    setSelectedChannels((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  }, []);

  // Orders-list local controls (sort + filter + search). The list is
  // capped server-side at 200 rows; we sort/filter/search on whatever
  // we have client-side for instant feedback.
  const [orderSort, setOrderSort] = useState<"date" | "total">("date");
  const [orderSortDir, setOrderSortDir] = useState<"asc" | "desc">("desc");
  const [orderStatus, setOrderStatus] = useState<string>("all");
  const [orderChannel, setOrderChannel] = useState<string>("all");
  const [orderSearch, setOrderSearch] = useState<string>("");
  const [ordersPage, setOrdersPage] = useState<number>(1);
  const ORDERS_PER_PAGE = 50;

  // Top-of-page tile row (Today / Yesterday / MTD / This-month forecast /
  // Last month). Fetched separately so the heavier per-period detail call
  // below doesn't block the row from rendering. The selected tile drives
  // the `preset` filter that powers everything else on the page.
  const [periods, setPeriods] = useState<PeriodsResponse | null>(null);
  const [periodsLoading, setPeriodsLoading] = useState(true);

  const fetchPeriods = useCallback(async () => {
    setPeriodsLoading(true);
    try {
      const sp = new URLSearchParams();
      if (channelsParam !== "all") sp.set("channels", channelsParam);
      const res = await fetch(`/api/sales-overview/periods?${sp.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PeriodsResponse;
      setPeriods(json);
    } catch {
      /* tile row is best-effort; the rest of the page still works */
    } finally {
      setPeriodsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey]);

  useEffect(() => {
    void fetchPeriods();
  }, [fetchPeriods]);

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
      if (channelsParam !== "all") sp.set("channels", channelsParam);
      const res = await fetch(`/api/sales-overview?${sp.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as OverviewResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, customFrom, customTo, channelsKey]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Grow the stable channel-chip list (union, never shrink) so a channel's
  // filter chip stays put even after it's been filtered out of the data.
  useEffect(() => {
    if (!data) return;
    const seen = data.byChannel.map((c) => c.channel);
    setKnownChannels((prev) => {
      const next = new Set(prev);
      for (const c of seen) next.add(c);
      return next.size === prev.length ? prev : [...next];
    });
  }, [data]);

  // Filtered / sorted order list for rendering
  const displayedOrders = useMemo(() => {
    if (!data) return [];
    const q = orderSearch.trim().toLowerCase();
    let rows = data.orders;
    if (orderStatus !== "all") {
      rows = rows.filter((o) => o.status === orderStatus);
    }
    if (orderChannel !== "all") {
      rows = rows.filter((o) => o.channel === orderChannel);
    }
    if (q) {
      // Veeqo-style smart search: single field matches against order
      // number, customer name, ship-to (city/state/zip), store, AND
      // every line item's SKU + product name.
      rows = rows.filter(
        (o) =>
          o.number.toLowerCase().includes(q) ||
          (o.customer ?? "").toLowerCase().includes(q) ||
          (o.city ?? "").toLowerCase().includes(q) ||
          (o.state ?? "").toLowerCase().includes(q) ||
          (o.zip ?? "").toLowerCase().includes(q) ||
          o.storeName.toLowerCase().includes(q) ||
          (o.items ?? []).some(
            (it) =>
              it.sku.toLowerCase().includes(q) ||
              it.productName.toLowerCase().includes(q),
          ),
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
  }, [data, orderSearch, orderStatus, orderChannel, orderSort, orderSortDir]);

  // Reset to page 1 whenever a filter that changes the result set fires.
  useEffect(() => {
    setOrdersPage(1);
  }, [orderSearch, orderStatus, orderChannel, orderSort, orderSortDir]);

  const totalOrderPages = Math.max(
    1,
    Math.ceil(displayedOrders.length / ORDERS_PER_PAGE),
  );
  const pageRows = displayedOrders.slice(
    (ordersPage - 1) * ORDERS_PER_PAGE,
    ordersPage * ORDERS_PER_PAGE,
  );

  // Channel chips for the Orders panel — derived from whatever channels
  // are actually present in the visible response, so eBay/TikTok/etc.
  // pills automatically appear when those orders are in the window.
  const orderChannels = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const o of data.orders) set.add(o.channel);
    return [...set].sort();
  }, [data]);

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
            Amazon + Walmart from our DB (matches the dashboard); other channels
            live from Veeqo. NAN health (client fulfilment) is excluded.
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

      {/* Channel chips + Custom-range toggle. Period selection itself
          lives in the 5 period tiles below. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          {/* Channel filter — multi-select, brand-styled chips matching the
              Shipping Labels page. "All" clears the selection; any other
              chip toggles in/out so the operator can view e.g. Amazon +
              Walmart together. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3 mr-1">
              Channel
            </span>
            <button
              type="button"
              onClick={() => setSelectedChannels([])}
              aria-pressed={selectedChannels.length === 0}
              className={cn(
                "rounded-md border px-3.5 py-1.5 text-[13px] font-bold leading-none tracking-tight transition",
                selectedChannels.length === 0
                  ? "border-green bg-green-soft text-green-ink shadow-sm"
                  : "border-rule bg-surface text-ink-2 hover:border-silver-line",
              )}
            >
              All
            </button>
            {/* Amazon + Walmart always available; other channels appear once
                they've been seen in the data (knownChannels grows, never
                shrinks, so chips stay put while filtering). */}
            {Array.from(
              new Set(["amazon", "walmart", ...knownChannels]),
            ).map((c) => (
              <ChannelToggle
                key={c}
                channel={c}
                active={selectedChannels.includes(c)}
                onClick={() => toggleChannel(c)}
              />
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPreset(preset === "custom" ? "mtd" : "custom")}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition",
                preset === "custom"
                  ? "border-green bg-green-soft text-green-ink"
                  : "border-rule bg-surface text-ink-2 hover:border-silver-line",
              )}
            >
              Custom range
            </button>
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

      {/* Period tiles — Sellerboard / Veeqo Profit Analyzer style. Each
          tile is a clickable filter that drives the chart + breakdowns +
          orders list below. The selected tile gets accent color. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {(
          [
            { key: "today", presetId: "today" as const, accent: "blue" },
            { key: "yesterday", presetId: "yesterday" as const, accent: "slate" },
            { key: "mtd", presetId: "mtd" as const, accent: "teal" },
            { key: "thisMonth", presetId: "mtd" as const, accent: "indigo" },
            { key: "lastMonth", presetId: "lastMonth" as const, accent: "green" },
          ] as const
        ).map((cfg) => {
          const tile = periods?.tiles[cfg.key];
          const active =
            preset !== "custom" &&
            ((cfg.key === "thisMonth" && preset === "mtd") ||
              (cfg.key !== "thisMonth" && preset === cfg.presetId));
          return (
            <PeriodTileCard
              key={cfg.key}
              accent={cfg.accent}
              loading={periodsLoading && !tile}
              active={active}
              tile={tile}
              onClick={() => setPreset(cfg.presetId)}
            />
          );
        })}
      </div>

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
                        <span className="flex items-center gap-1.5 font-medium text-ink">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: channelHex(c.channel) }}
                          />
                          {channelLabel(c.channel)}
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
                            background: channelHex(c.channel),
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
                          <span className="ml-1.5 text-[10.5px] text-ink-3">
                            {channelLabel(s.channel)}
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
                  ({displayedOrders.length.toLocaleString()} of{" "}
                  {data.totalOrdersInWindow.toLocaleString()}
                  {data.totalOrdersInWindow > data.orders.length
                    ? ` — server cap ${data.orders.length}, narrow date range to load more`
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
                    placeholder="Order #, customer, city, state, ZIP, store…"
                    className="h-8 w-[300px] pl-7 text-[12px]"
                  />
                </div>
                {orderChannels.length > 1 && (
                  <select
                    value={orderChannel}
                    onChange={(e) => setOrderChannel(e.target.value)}
                    className="h-8 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink focus:border-green focus:outline-none"
                  >
                    <option value="all">All channels</option>
                    {orderChannels.map((c) => (
                      <option key={c} value={c}>
                        {channelLabel(c)}
                      </option>
                    ))}
                  </select>
                )}
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
            <table className="w-full min-w-[1180px] text-[12px]">
              <thead className="border-b border-rule bg-surface-tint text-[10.5px] uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Order #</th>
                  <th
                    className="whitespace-nowrap px-3 py-2 text-left font-medium cursor-pointer select-none hover:text-ink-2"
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
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Channel</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Store</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Customer</th>
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Ship-to</th>
                  <th className="px-3 py-2 text-left font-medium">Items</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Units</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Shipping</th>
                  <th
                    className="whitespace-nowrap px-3 py-2 text-right font-medium cursor-pointer select-none hover:text-ink-2"
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
                  <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {displayedOrders.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-8 text-center text-ink-3">
                      No orders match the current filters.
                    </td>
                  </tr>
                )}
                {pageRows.map((o) => (
                  <tr
                    key={`${o.source}-${o.id}`}
                    className="border-t border-rule/60 align-top hover:bg-bg-elev/30"
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-ink">
                      {o.number}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-2">
                      {fmtDateTime(o.date)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                        style={{
                          background: `${channelHex(o.channel)}20`,
                          color: channelHex(o.channel),
                        }}
                      >
                        {channelLabel(o.channel)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-2">{o.storeName}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-2">{o.customer ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-3">
                      {o.city || o.state || o.zip
                        ? [o.city, o.state, o.zip].filter(Boolean).join(", ")
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {(o.items ?? []).length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {(o.items ?? []).slice(0, 3).map((it, idx) => (
                            <div
                              key={`${it.sku || "noSku"}-${idx}`}
                              className="flex items-center gap-2"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={it.imageUrl ?? "/img-placeholder.svg"}
                                alt=""
                                width={28}
                                height={28}
                                className="h-7 w-7 shrink-0 rounded border border-rule bg-bg-elev object-cover"
                                loading="lazy"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.opacity = "0.3";
                                }}
                              />
                              <div className="min-w-0 leading-tight">
                                <div className="truncate text-[11.5px] font-medium text-ink" title={it.productName}>
                                  {it.productName}
                                </div>
                                <div className="text-[10px] text-ink-3 tabular">
                                  {it.sku ? `${it.sku} · ` : ""}× {it.quantity}
                                </div>
                              </div>
                            </div>
                          ))}
                          {(o.items ?? []).length > 3 && (
                            <div className="text-[10px] text-ink-3">
                              + {(o.items ?? []).length - 3} more line
                              {(o.items ?? []).length - 3 === 1 ? "" : "s"}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10.5px] tabular text-ink-3">
                          {o.itemsCount} item{o.itemsCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    {/* Units — sum of qty across the order's line items.
                        For cached Amazon/Walmart rows without items[]
                        we fall back to itemsCount which is the same
                        thing (numberOfItems in the source schemas). */}
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular text-ink-2">
                      {(o.items ?? []).length > 0
                        ? (o.items ?? []).reduce((s, it) => s + it.quantity, 0)
                        : o.itemsCount}
                    </td>
                    {/* Customer-paid shipping (Veeqo's delivery_cost).
                        Cached AmazonOrder/WalmartOrder don't store this
                        so they render "—" — only Veeqo-sourced rows
                        currently have a value. */}
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular text-ink-2">
                      {o.customerPaidShipping != null
                        ? fmtMoneyExact(o.customerPaidShipping)
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular font-medium text-ink">
                      {fmtMoneyExact(o.total)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
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

            {/* Pagination — only shown when there's more than one page. */}
            {totalOrderPages > 1 && (
              <div className="flex items-center justify-between gap-2 border-t border-rule px-3 py-2 text-[11.5px] text-ink-3">
                <span>
                  Showing{" "}
                  <span className="font-medium text-ink-2">
                    {(ordersPage - 1) * ORDERS_PER_PAGE + 1}
                    {"–"}
                    {Math.min(
                      ordersPage * ORDERS_PER_PAGE,
                      displayedOrders.length,
                    )}
                  </span>{" "}
                  of{" "}
                  <span className="font-medium text-ink-2">
                    {displayedOrders.length.toLocaleString()}
                  </span>
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setOrdersPage(1)}
                    disabled={ordersPage === 1}
                    className="rounded border border-rule px-2 py-0.5 text-[11px] disabled:opacity-40 hover:bg-bg-elev"
                  >
                    «
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrdersPage((p) => Math.max(1, p - 1))}
                    disabled={ordersPage === 1}
                    className="rounded border border-rule px-2 py-0.5 text-[11px] disabled:opacity-40 hover:bg-bg-elev"
                  >
                    ‹
                  </button>
                  <span className="px-1.5 tabular text-ink">
                    {ordersPage} / {totalOrderPages}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setOrdersPage((p) => Math.min(totalOrderPages, p + 1))
                    }
                    disabled={ordersPage === totalOrderPages}
                    className="rounded border border-rule px-2 py-0.5 text-[11px] disabled:opacity-40 hover:bg-bg-elev"
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrdersPage(totalOrderPages)}
                    disabled={ordersPage === totalOrderPages}
                    className="rounded border border-rule px-2 py-0.5 text-[11px] disabled:opacity-40 hover:bg-bg-elev"
                  >
                    »
                  </button>
                </div>
              </div>
            )}
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
// PeriodTileCard — Sellerboard / Veeqo Profit Analyzer style.
// Each tile is clickable: clicking it sets the page's `preset` so the
// chart, breakdowns, and orders list below all re-derive against that
// period. The selected tile gets a coloured top stripe + accent border.
// ─────────────────────────────────────────────────────────────────────

const ACCENT_BG: Record<string, string> = {
  blue: "bg-info-tint",
  slate: "bg-bg-elev",
  teal: "bg-green-soft",
  indigo: "bg-info-tint",
  green: "bg-green-soft",
};
const ACCENT_BORDER: Record<string, string> = {
  blue: "border-info",
  slate: "border-ink-3",
  teal: "border-green",
  indigo: "border-info",
  green: "border-green",
};

function PeriodTileCard({
  tile,
  accent,
  loading,
  active,
  onClick,
}: {
  tile?: PeriodTile;
  accent: string;
  loading: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-surface text-left transition-all hover:border-ink-3 hover:shadow-sm",
        active ? `${ACCENT_BORDER[accent] ?? "border-green"} shadow` : "border-rule",
      )}
    >
      {/* Coloured header stripe carries the period label — matches the
          Sellerboard tile aesthetic and gives the active state a strong
          visual anchor. */}
      <div
        className={cn(
          "border-b border-rule px-3 py-1.5 text-[11px] font-semibold text-ink-2",
          ACCENT_BG[accent] ?? "bg-bg-elev",
        )}
      >
        {tile?.label ?? "—"}
        {tile?.isForecast && (
          <span className="ml-1 rounded bg-surface px-1 py-px text-[9px] font-medium uppercase tracking-wider text-ink-3">
            forecast
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex h-[140px] items-center justify-center">
          <Loader2 size={16} className="animate-spin text-ink-3" />
        </div>
      ) : !tile ? (
        <div className="flex h-[140px] items-center justify-center text-[11px] text-ink-3">
          No data
        </div>
      ) : (
        <div className="space-y-2 p-3">
          {/* Sales — big number + delta vs prior */}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.10em] text-ink-3">
              Sales
              <PriorDelta
                current={tile.summary.revenue}
                prior={tile.prior.revenue}
              />
            </div>
            <div className="mt-0.5 text-[20px] font-bold tabular text-ink">
              {fmtMoneyExact(tile.summary.revenue)}
            </div>
          </div>

          {/* Two-up: Orders / Units, Refunds (=cancelled here) */}
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.10em] text-ink-3">
                Orders / Units
              </div>
              <div className="tabular text-ink">
                {tile.summary.orders}
                <span className="text-ink-3"> / </span>
                {tile.summary.units}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.10em] text-ink-3">
                Cancelled
              </div>
              <div
                className={cn(
                  "tabular",
                  tile.summary.cancelled > 0 ? "text-danger" : "text-ink-3",
                )}
              >
                {tile.summary.cancelled}
              </div>
            </div>
          </div>

          {/* Two-up: Shipped, Avg order */}
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.10em] text-ink-3">
                Shipped
              </div>
              <div className="tabular text-ink">{tile.summary.shipped}</div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.10em] text-ink-3">
                Avg order
              </div>
              <div className="tabular text-ink">
                {fmtMoneyExact(tile.summary.avgOrder)}
              </div>
            </div>
          </div>

          {/* Prior-period label so the operator knows what the delta
              arrow above is comparing against. */}
          <div className="border-t border-rule/60 pt-1.5 text-[10px] text-ink-4">
            vs {tile.priorLabel}: {fmtMoneyExact(tile.prior.revenue)}
          </div>
        </div>
      )}
    </button>
  );
}

function PriorDelta({ current, prior }: { current: number; prior: number }) {
  if (prior === 0 && current === 0) return null;
  const d = pctDelta(current, prior);
  return (
    <span
      className={cn(
        "ml-1 inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-[9px] font-semibold normal-case tracking-normal",
        d.positive
          ? "bg-green-soft text-green-ink"
          : "bg-danger-tint text-danger",
      )}
    >
      {d.positive ? <TrendingUp size={8} /> : <TrendingDown size={8} />}
      {d.positive ? "+" : ""}
      {Math.abs(d.pct).toFixed(1)}%
    </span>
  );
}
