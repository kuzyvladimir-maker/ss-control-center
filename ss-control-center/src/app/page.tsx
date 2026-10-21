"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { SalesCardsRow } from "@/components/dashboard/SalesCardsRow";
import {
  ShoppingCart,
  Truck,
  MessageSquare,
  HeartPulse,
  Receipt,
  Thermometer,
  RefreshCw,
  ArrowRight,
  AlertTriangle,
  Clock,
} from "lucide-react";
import {
  Btn,
  KpiCard,
  PageHead,
  Panel,
  PanelBody,
  PanelHeader,
  Sep,
  StatusChip,
  StoreAvatar,
  SyncChip,
  TypeTag,
  storeKeyFor,
} from "@/components/kit";

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
  ordersByStore?: Array<{ storeIndex: number; count: number; lastOrderAt: string | null }>;
  customerHub?: { lastAmazonMessageAt: string | null; stale: boolean };
  health: {
    issues: number;
    deactivated?: number;
    lastSnapshotAt?: string | null;
    stale?: boolean;
  };
  labelsBoughtToday?: number;
  procurement: { ordersToBuy: number; error?: string | null };
  frozen: { incidents30d: number; riskElevated?: number; riskLow?: number };
  // Plain-English broken-feed notices from /api/dashboard/summary.
  dataIssues?: string[];
  adjustments: {
    monthlyTotal: number;
    charged30d?: { amount: number; count: number };
  };
  walmart?: {
    ordersTotal30d: number;
    ordersToday: number;
    returnsPending: number;
    refundsLast7d: number;
    healthIssues: number;
    healthStatus: "no-data" | "healthy" | "warning" | "critical";
  } | null;
  syncedAt: string;
  sync?: {
    ordersStale: boolean;
    ordersLastAttemptAt: string | null;
    ordersLastError: string | null;
  };
  error?: string;
}

interface OrderRow {
  id: string;
  amazonOrderId?: string | null;
  storeIndex?: number | null;
  storeName?: string | null;
  marketplace?: string | null;
  productName?: string | null;
  productType?: string | null;
  shipBy?: string | null;
  status: string;
}

interface VeeqoOrder {
  id?: number | string;
  number?: string;
  store_name?: string;
  store?: { name?: string } | null;
  channel?: { name?: string } | null;
  due_date?: string | null;
  dispatch_date?: string | null;
  status?: string;
  line_items?: Array<{
    sellable?: { product_title?: string; tags?: Array<{ name?: string }> };
  }>;
}

// BuyerMessage rows from /api/customer-hub/messages (field names as stored).
interface CsCaseRow {
  id: string;
  channel?: string | null;
  storeName?: string | null;
  amazonOrderId?: string | null;
  walmartOrderId?: string | null;
  category?: string | null;
  categoryName?: string | null;
  priority?: string | null;
  createdAt: string;
}

function formatTime(date: string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";
  // Veeqo's `due_date` is a date with a default UTC time (06:59:00Z) — so
  // rendering only the time made every row read "2:59 AM" in ET regardless
  // of which day was actually due. Show the date instead: "Fri, May 16".
  // Format keeps room for the year only if it isn't the current year.
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export default function DashboardPage() {
  const {
    selectedStoreIds,
    isLoading: filterLoading,
    hasWalmart,
    hasAmazon,
    isAllSelected,
    selectedStores,
    allStores,
    toQueryString,
  } = useStoreFilter();

  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [cases, setCases] = useState<CsCaseRow[]>([]);
  // Live "awaiting shipment" count from the SAME endpoint the Shipping
  // Labels page (and the sidebar badge) render — Veeqo awaiting_fulfillment.
  // The DB count (AmazonOrder.status = Unshipped) drifted to 72 vs Veeqo's
  // real 46 on 2026-10-18, and the tile links straight to /shipping, so the
  // two numbers must be identical. null = not loaded / Veeqo unavailable →
  // fall back to the DB number.
  const [liveAwaiting, setLiveAwaiting] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  // Cheap, stable key for the selection so the load effect re-runs only
  // when the actual set of selected stores changes.
  const filterKey = [...selectedStoreIds].sort().join(",");

  const load = useCallback(async () => {
    setLoading(true);
    // Slow (live Veeqo walk) — fired separately so it never delays the tiles.
    fetch("/api/shipping/dashboard")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { orders?: Array<{ storeId?: string }> } | null) => {
        if (!Array.isArray(j?.orders)) return setLiveAwaiting(null);
        // Respect the sidebar store filter (orders carry our Store.id).
        const picked = new Set(selectedStoreIds);
        setLiveAwaiting(
          isAllSelected
            ? j.orders.length
            : j.orders.filter((o) => o.storeId && picked.has(o.storeId)).length
        );
      })
      .catch(() => setLiveAwaiting(null));
    // Every page load/refresh pulls a fresh Amazon orders window (not just
    // the 2-hourly cron) so Sales/Awaiting reflect what changed since the
    // last view. Debounced server-side (SyncLog lock, ~45s) so rapid repeat
    // loads don't hammer SP-API; capped client-side at 9s so a slow/stuck
    // call never blocks the tiles from rendering with whatever's already
    // in the DB.
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 9000);
      await fetch("/api/sync/quick", { method: "POST", signal: ctrl.signal }).catch(() => null);
      clearTimeout(timeout);
    } catch {
      // ignore — summary below still loads whatever's in the DB
    }
    try {
      const summaryQs = toQueryString();
      // Selected store names so we can ask Veeqo for only those marketplaces.
      // Veeqo's filter is by channel/store name, not our id — best-effort.
      const veeqoQs = isAllSelected
        ? ""
        : `&store_names=${encodeURIComponent(
            selectedStores.map((s) => s.name).join(",")
          )}`;

      const [summary, veeqo, cs] = await Promise.all([
        fetch(`/api/dashboard/summary${summaryQs ? `?${summaryQs}` : ""}`).then(
          (r) => (r.ok ? r.json() : null)
        ),
        fetch(
          `/api/veeqo/orders?status=awaiting_fulfillment&page_size=10${veeqoQs}`
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        // limit=50, not 4: the API sorts active cases oldest-first (closest
        // to the reply deadline), so a tiny limit can return only ancient
        // abandoned messages that the 30-day filter below then drops to
        // zero — the panel read "No open cases" while the tile next to it
        // said "Cases open 9" (2026-10-21). Filter+slice(0,4) below still
        // caps what's rendered.
        fetch("/api/customer-hub/messages?limit=50&status=active")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

      if (summary) setData(summary);

      const veeqoRows: VeeqoOrder[] = Array.isArray(veeqo)
        ? veeqo
        : Array.isArray(veeqo?.orders)
          ? veeqo.orders
          : [];

      // Selected store-name set for client-side filtering of Veeqo rows
      // (Veeqo doesn't reliably accept a multi-store filter in its API).
      const selectedNamesLower = new Set(
        selectedStores.map((s) => s.name.toLowerCase())
      );

      const filteredVeeqo = isAllSelected
        ? veeqoRows
        : veeqoRows.filter((o) => {
            const channel = o.channel?.name?.toLowerCase() || "";
            const storeName = (
              o.store?.name ||
              o.store_name ||
              ""
            ).toLowerCase();
            // Walmart row → keep if any Walmart store selected.
            if (channel.includes("walmart")) return hasWalmart;
            // Amazon row → keep only if its store name matches one of the
            // selected Amazon stores. Fall back to "keep" if we can't match
            // (better to show an order than to silently hide it).
            if (!storeName) return hasAmazon;
            for (const n of selectedNamesLower) {
              if (storeName.includes(n) || n.includes(storeName)) return true;
            }
            return false;
          });

      // Most urgent first — same ship-by field the Shipping page buckets on
      // (dispatch_date, then due_date). Veeqo returns its own order, so the
      // 8 rows shown used to be arbitrary.
      const shipByOf = (o: VeeqoOrder) =>
        new Date(o.dispatch_date ?? o.due_date ?? "9999-12-31").getTime();
      const urgentFirst = [...filteredVeeqo].sort((a, b) => shipByOf(a) - shipByOf(b));
      const mapped: OrderRow[] = urgentFirst.slice(0, 8).map((o) => {
        const item = o.line_items?.[0];
        const productName = item?.sellable?.product_title;
        const tags = item?.sellable?.tags || [];
        const isFrozen = tags.some((t) => /frozen/i.test(t.name || ""));
        const isDry = tags.some((t) => /dry/i.test(t.name || ""));
        const channel =
          o.channel?.name?.toLowerCase().includes("walmart")
            ? "Walmart"
            : "Amazon";
        // Veeqo doesn't expose a nested `store` object on order payloads —
        // the seller account name lives in `channel.name` (e.g. "Salutem
        // Solutions", "Vladimir Personal"). Falling back to it stops the
        // Store column rendering "—" on every row.
        return {
          id: String(o.number ?? o.id ?? ""),
          amazonOrderId: o.number ?? null,
          storeIndex: null,
          storeName:
            o.store?.name ??
            o.store_name ??
            o.channel?.name ??
            null,
          marketplace: channel,
          productName,
          productType: isFrozen ? "Frozen" : isDry ? "Dry" : null,
          shipBy: o.dispatch_date ?? o.due_date ?? null,
          status: o.status === "shipped" ? "Shipped" : "Ready",
        };
      });
      setOrders(mapped);

      const allMessages: CsCaseRow[] = Array.isArray(cs?.messages)
        ? cs.messages
        : Array.isArray(cs)
          ? cs
          : [];
      // Customer queue follows channel selection — Walmart cases only when
      // hasWalmart, Amazon cases only when hasAmazon. Applied even for "All
      // stores": an inactive Walmart store isn't in the selection, and its
      // 70-day-old messages used to fill the whole queue. Anything older
      // than 30 days is history, not a queue.
      const queueCutoff = Date.now() - 30 * 86400000;
      const filteredMessages = allMessages.filter((m) => {
        if (new Date(m.createdAt).getTime() < queueCutoff) return false;
        const channel = (m.channel || "Amazon").toLowerCase();
        return channel.includes("walmart") ? hasWalmart : hasAmazon;
      });
      setCases(filteredMessages.slice(0, 4));
    } finally {
      setLoading(false);
    }
    // load is rebuilt whenever the active filter set changes — selectedStores
    // / hasAmazon etc. are derived from `filterKey`, so depending on that
    // single string keeps the dependency list tight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, isAllSelected, hasAmazon, hasWalmart]);

  useEffect(() => {
    if (filterLoading) return;
    if (selectedStoreIds.length === 0) {
      setData(null);
      setOrders([]);
      setCases([]);
      setLoading(false);
      return;
    }
    load();
  }, [load, filterLoading, selectedStoreIds.length]);

  // Result of the last manual Refresh — shown under the header so a failed
  // sync is visible (it used to be swallowed silently).
  const [syncNote, setSyncNote] = useState<string | null>(null);

  async function syncNow() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const j = await res.json().catch(() => null);
      // /api/sync returns `results` as a map: { orders_store1: {...}, ... }.
      const results: Array<{ success?: boolean; ok?: boolean; error?: string }> =
        j?.results && typeof j.results === "object" ? Object.values(j.results) : [];
      const failed = results.filter((r) => r.success === false || r.ok === false || r.error);
      if (!res.ok) setSyncNote(`Refresh failed (HTTP ${res.status}).`);
      else if (failed.length > 0)
        setSyncNote(`Refresh finished with ${failed.length} failed step(s): ${failed
          .map((f) => f.error)
          .filter(Boolean)
          .slice(0, 2)
          .join("; ")
          .slice(0, 220)}`);
      else setSyncNote("Refresh complete.");
    } catch {
      setSyncNote("Refresh failed — request timed out or network error.");
    }
    await load();
    setSyncing(false);
  }

  const dateString = now
    ? now.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      })
    : "";
  const timeString = now
    ? now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/New_York",
      })
    : "";
  const weekString = now ? `W${getWeek(now)}` : "";

  const totalToShip = liveAwaiting ?? data?.orders.awaitingShipment ?? 0;
  // Labels bought today via Shipping Labels (ShippingPlanItem → bought).
  const labelsToday = data?.labelsBoughtToday ?? 0;
  const noStoresSelected =
    !filterLoading && allStores.length > 0 && selectedStoreIds.length === 0;

  return (
    <div className="space-y-5">
      <PageHead
        title="Dashboard"
        syncChip={
          data?.syncedAt && (
            <SyncChip when={data.syncedAt} stale={data.sync?.ordersStale} />
          )
        }
        subtitle={
          <>
            <span>{dateString}</span>
            <Sep />
            <span>{timeString} ET</span>
            <Sep />
            <span className="rounded bg-bg-elev px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ink-2">
              {weekString}
            </span>
          </>
        }
        actions={
          <>
            <Btn icon={<RefreshCw size={13} />} onClick={syncNow} loading={syncing}>
              {syncing ? "Syncing…" : "Refresh"}
            </Btn>
            <Link href="/shipping">
              <Btn variant="primary" icon={<ArrowRight size={13} />}>
                Open shipping
              </Btn>
            </Link>
          </>
        }
      />

      {noStoresSelected && (
        <Panel>
          <PanelBody>
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <div className="text-[14px] font-medium text-ink">
                Select at least one store to view dashboard data.
              </div>
              <div className="text-[12px] text-ink-3">
                Use the store selector in the sidebar to choose which stores to include.
              </div>
            </div>
          </PanelBody>
        </Panel>
      )}

      {!noStoresSelected && (
      <>
      {syncNote && (
        <div className="rounded-md border border-rule bg-surface px-4 py-2 text-[12px] text-ink-2">
          {syncNote}
        </div>
      )}

      {/* Broken data feeds — one banner instead of tiles silently reading 0. */}
      {(data?.dataIssues?.length ?? 0) > 0 && (
        <div
          className="rounded-lg border px-4 py-3"
          style={{ background: "var(--warn-tint)", borderColor: "var(--warn)" }}
        >
          <div
            className="mb-1 flex items-center gap-2 text-[12px] font-semibold"
            style={{ color: "var(--warn-strong)" }}
          >
            <AlertTriangle size={14} />
            Data feeds need attention
          </div>
          <ul className="space-y-0.5 text-[12px] text-ink-2">
            {data?.dataIssues?.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {/* Sales row — 5-period gross revenue. Lives ABOVE the operations KPI row;
          see docs/SALES_CARDS_DASHBOARD_SPEC_v1_0.md */}
      <SalesCardsRow />

      {/* Operations KPI row — one tile per module, every tile clickable
          → opens the corresponding section so the operator can drill in
          from any number. Six columns at lg: Shipping, Procurement,
          Customer hub, Account Health, Frozen, Adjustments. Two rows on
          smaller screens (sm:grid-cols-2 / md:grid-cols-3). */}
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <KpiCard
          href="/shipping"
          label="Awaiting ship"
          value={totalToShip}
          icon={<Truck size={14} />}
          chips={[
            { label: `${labelsToday} labels today`, variant: "ok" },
          ]}
        />
        <KpiCard
          href="/procurement"
          label={data?.procurement.error ? "To buy (Veeqo key rejected)" : "To buy"}
          value={data?.procurement.ordersToBuy ?? 0}
          icon={<ShoppingCart size={14} />}
          iconVariant={
            (data?.procurement.ordersToBuy ?? 0) > 0 ? "warn" : "default"
          }
          trend={{
            value: `${data?.orders.total30d ?? 0} orders 30d`,
            // Every Amazon store with orders in the window (was hard-coded
            // S1/S2, which hid store3's 84 orders).
            subText:
              (data?.ordersByStore ?? [])
                .map((r) => `S${r.storeIndex} ${r.count}`)
                .join(" · ") || undefined,
          }}
        />
        <KpiCard
          href="/customer-hub"
          label="Cases open"
          value={data?.customerService.openCases ?? 0}
          icon={<MessageSquare size={14} />}
          iconVariant={(data?.customerService.openCases ?? 0) > 0 ? "warn" : "default"}
          chips={
            (data?.claims.active ?? 0) > 0
              ? [{ label: `${data?.claims.active} A-to-Z active`, variant: "urgent" }]
              : undefined
          }
        />
        <KpiCard
          href="/account-health"
          label="Health issues"
          value={(data?.health.issues ?? 0) + (data?.walmart?.healthIssues ?? 0)}
          icon={<HeartPulse size={14} />}
          iconVariant={
            (data?.health.issues ?? 0) + (data?.walmart?.healthIssues ?? 0) > 0
              ? "danger"
              : data?.health.stale
                ? "warn"
                : "default"
          }
          chips={
            (data?.health.deactivated ?? 0) > 0
              ? [{ label: `${data?.health.deactivated} deactivated`, variant: "urgent" }]
              : data?.health.stale
              ? [
                  {
                    label: data.health.lastSnapshotAt
                      ? `Stale · since ${shortDay(data.health.lastSnapshotAt)}`
                      : "No data",
                    variant: "urgent",
                  },
                ]
              : data?.health.lastSnapshotAt
                ? [{ label: `AHR < 200 · ${shortDay(data.health.lastSnapshotAt)}`, variant: "neutral" }]
                : undefined
          }
        />
        {/* Frozen — nightly weather-risk forecast for frozen orders shipping
            today or later (FrozenRiskAlert, written by
            /api/cron/frozen-analysis). Replaces the complaint-log count,
            which nothing populates automatically and read 0 forever. */}
        <KpiCard
          href="/frozen-analytics"
          label="Frozen at risk"
          // Same number as the "Today's risk" badge on /frozen-analytics:
          // pending alerts, low and above, ship date today or later.
          value={(data?.frozen.riskElevated ?? 0) + (data?.frozen.riskLow ?? 0)}
          icon={<Thermometer size={14} />}
          iconVariant={
            (data?.frozen.riskElevated ?? 0) > 0 ? "warn" : "default"
          }
          chips={[
            ...((data?.frozen.riskElevated ?? 0) > 0
              ? [{ label: `${data?.frozen.riskElevated} medium+`, variant: "urgent" as const }]
              : (data?.frozen.riskLow ?? 0) > 0
                ? [{ label: "all low", variant: "neutral" as const }]
                : []),
            ...((data?.frozen.incidents30d ?? 0) > 0
              ? [{ label: `${data?.frozen.incidents30d} incidents 30d`, variant: "urgent" as const }]
              : []),
          ]}
        />
        {/* Same number as the "Charged" figure on /adjustments for its
            "30 days" period (Amazon board accounts, by charge date). */}
        <KpiCard
          href="/adjustments?period=30d"
          label="Adjustments 30d"
          value={`$${Math.round(data?.adjustments.charged30d?.amount ?? 0).toLocaleString("en-US")}`}
          icon={<Receipt size={14} />}
          iconVariant={(data?.adjustments.charged30d?.amount ?? 0) > 0 ? "warn" : "default"}
          trend={
            (data?.adjustments.charged30d?.count ?? 0) > 0
              ? {
                  value: `${data?.adjustments.charged30d?.count} charges`,
                  positive: false,
                  subText: "dispute via Adjustments",
                }
              : undefined
          }
        />
      </div>

      {/* Walmart row — gated by both data presence AND at least one
          Walmart store being selected in the global filter. Hides
          entirely (no "—" placeholders) when Walmart is deselected. */}
      {data?.walmart && hasWalmart && (
        <div className="grid gap-3 sm:grid-cols-4">
          <KpiCard
            href="/shipping"
            label="Walmart 30d"
            value={data.walmart.ordersTotal30d}
            icon={<StoreAvatar store="walmart" size="sm" />}
            trend={{ value: `${data.walmart.ordersToday} today` }}
          />
          <KpiCard
            href="/customer-hub"
            label="Walmart returns"
            value={data.walmart.returnsPending}
            icon={<Receipt size={14} />}
            iconVariant={data.walmart.returnsPending > 0 ? "warn" : "default"}
          />
          <KpiCard
            href="/adjustments"
            label="Walmart refunds 7d"
            value={`$${data.walmart.refundsLast7d.toFixed(0)}`}
            icon={<Receipt size={14} />}
          />
          <KpiCard
            href="/account-health"
            label="Walmart health"
            value={
              data.walmart.healthStatus === "no-data"
                ? "—"
                : data.walmart.healthStatus === "healthy"
                  ? "✓"
                  : data.walmart.healthIssues
            }
            icon={<HeartPulse size={14} />}
            iconVariant={
              data.walmart.healthStatus === "critical"
                ? "danger"
                : data.walmart.healthStatus === "warning"
                  ? "warn"
                  : "default"
            }
          />
        </div>
      )}

      {/* Main grid */}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Today's orders */}
        <Panel>
          <PanelHeader
            title="Awaiting fulfilment"
            count={totalToShip}
            right={
              <Link
                href="/shipping"
                className="text-[12px] font-medium text-green hover:text-green-deep"
              >
                Open plan →
              </Link>
            }
          />
          <PanelBody className="p-0">
            {loading && orders.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-[12px] text-ink-3">
                Loading orders…
              </div>
            ) : orders.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-ink-3">
                No awaiting orders. Veeqo has nothing in queue.
              </div>
            ) : (
              <>
                {/* DESKTOP table (≥ md) */}
                <div className="hidden md:block">
                  <table className="w-full text-[12.5px]">
                    <thead className="border-b border-rule">
                      <tr className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-ink-3">
                        <th className="px-4 py-2.5 text-left font-medium">Order</th>
                        <th className="px-4 py-2.5 text-left font-medium">Store</th>
                        <th className="px-4 py-2.5 text-left font-medium">Product</th>
                        <th className="px-4 py-2.5 text-left font-medium">Type</th>
                        <th className="px-4 py-2.5 text-left font-medium">Ship by</th>
                        <th className="px-4 py-2.5 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((o) => (
                        <tr
                          key={o.id}
                          onClick={() => router.push(`/shipping?q=${encodeURIComponent(o.id)}`)}
                          title="Open this order in Shipping Labels"
                          className="cursor-pointer border-b border-rule last:border-0 hover:bg-surface-tint"
                        >
                          <td className="px-4 py-2.5 font-mono text-[12px] text-ink">
                            {o.id}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <StoreAvatar
                                store={storeKeyFor({
                                  marketplace: o.marketplace,
                                  storeIndex: o.storeIndex,
                                  storeName: o.storeName,
                                })}
                                size="sm"
                              />
                              <div className="leading-tight">
                                <div className="text-ink">{o.storeName ?? "—"}</div>
                                <div className="text-[10px] font-mono uppercase tracking-wider text-ink-3">
                                  {o.marketplace}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-ink-2 truncate max-w-[280px]">
                            {o.productName ?? "—"}
                          </td>
                          <td className="px-4 py-2.5">
                            <TypeTag type={o.productType} />
                          </td>
                          <td className="px-4 py-2.5 text-ink-2 tabular">
                            {formatTime(o.shipBy)}
                          </td>
                          <td className="px-4 py-2.5">
                            <StatusChip
                              variant={o.status === "Shipped" ? "delivered" : "ready"}
                            >
                              {o.status}
                            </StatusChip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* MOBILE cards (< md) */}
                <div className="md:hidden divide-y divide-rule">
                  {orders.map((o) => (
                    <Link
                      key={o.id}
                      href={`/shipping?q=${encodeURIComponent(o.id)}`}
                      className="block px-4 py-3"
                    >
                      {/* HEAD: order id + status */}
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <span className="font-mono text-[13px] text-ink truncate">
                          {o.id}
                        </span>
                        <StatusChip
                          variant={
                            o.status === "Shipped" ? "delivered" : "ready"
                          }
                        >
                          {o.status}
                        </StatusChip>
                      </div>

                      {/* SUB: store with avatar */}
                      <div className="flex items-center gap-2 mb-1.5">
                        <StoreAvatar
                          store={storeKeyFor({
                            marketplace: o.marketplace,
                            storeIndex: o.storeIndex,
                            storeName: o.storeName,
                          })}
                          size="sm"
                        />
                        <div className="min-w-0 flex-1 leading-tight">
                          <div className="text-[12px] text-ink truncate">
                            {o.storeName ?? "—"}
                          </div>
                          <div className="text-[10px] font-mono uppercase tracking-wider text-ink-3">
                            {o.marketplace}
                          </div>
                        </div>
                      </div>

                      {/* BODY: product */}
                      <div className="text-[12px] text-ink-2 truncate mb-1.5">
                        {o.productName ?? "—"}
                      </div>

                      {/* FOOTER: type + ship-by */}
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <TypeTag type={o.productType} />
                        <span className="text-ink-3 tabular">
                          {formatTime(o.shipBy)}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </>
            )}
          </PanelBody>
        </Panel>

        {/* Right column */}
        <div className="space-y-4">
          {/* Shipping progress */}
          <Link href="/shipping" className="block">
          <Panel className="bg-green-soft border-green-soft2 transition-colors hover:border-green-mid/40">
            <PanelBody>
              <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-green-ink/70">
                Shipping progress
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-[34px] font-semibold leading-none tabular text-green-ink">
                  {labelsToday}
                </span>
                <span className="text-[14px] text-green-ink/60 tabular">
                  / {labelsToday + totalToShip}
                </span>
              </div>
              <div className="text-[11.5px] text-green-ink/70 mt-1">
                labels purchased today
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-green/20">
                <div
                  className="h-full rounded-full bg-green"
                  style={{
                    width: `${
                      (labelsToday + totalToShip) > 0
                        ? Math.round(
                            (labelsToday / (labelsToday + totalToShip)) * 100
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-[11.5px]">
                <div>
                  <div className="text-green-ink/60">Awaiting</div>
                  <div className="text-green-ink font-semibold tabular">
                    {totalToShip}
                  </div>
                </div>
                <div>
                  <div className="text-green-ink/60">Labels today</div>
                  <div className="text-green-ink font-semibold tabular">
                    {labelsToday}
                  </div>
                </div>
              </div>
            </PanelBody>
          </Panel>
          </Link>

          {/* Customer queue */}
          <Panel>
            <PanelHeader
              title="Customer queue"
              // Count of what this panel actually lists (recent, live-channel
              // cases) — NOT the "Cases open" KPI tile's count, which also
              // includes cases older than 30 days. The two used to both read
              // from `openCases`, so the header said "9" over a list that
              // rendered "No open cases" whenever the oldest 4 of those 9
              // were all stale backlog (2026-10-21).
              count={cases.length}
              right={
                <Link
                  href="/customer-hub"
                  className="text-[12px] font-medium text-green hover:text-green-deep"
                >
                  Open →
                </Link>
              }
            />
            <PanelBody className="p-0">
              {cases.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-ink-3">
                  No open cases.
                </div>
              ) : (
                <div>
                  {cases.map((c) => (
                    <Link
                      key={c.id}
                      href={`/customer-hub?message=${encodeURIComponent(c.id)}`}
                      className="flex items-start gap-3 border-b border-rule px-4 py-3 last:border-0 hover:bg-surface-tint"
                    >
                      <div
                        className="grid h-7 w-7 place-items-center rounded-md"
                        style={{
                          background:
                            c.priority === "HIGH" || c.priority === "CRITICAL"
                              ? "var(--warn-tint)"
                              : "var(--green-soft)",
                          color:
                            c.priority === "HIGH" || c.priority === "CRITICAL"
                              ? "var(--warn-strong)"
                              : "var(--green-ink)",
                        }}
                      >
                        {c.priority === "HIGH" || c.priority === "CRITICAL" ? (
                          <AlertTriangle size={13} />
                        ) : (
                          <Clock size={13} />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="truncate text-[12.5px] font-medium text-ink">
                            {c.category ? `${c.category} · ` : ""}
                            {c.categoryName ?? "Buyer message"}
                          </div>
                          <div className="text-[10.5px] font-mono text-ink-3">
                            {timeAgo(c.createdAt)}
                          </div>
                        </div>
                        <div className="text-[11px] text-ink-3 truncate">
                          {c.channel ?? "Amazon"}
                          {c.storeName && ` · ${c.storeName}`}
                          {(c.amazonOrderId || c.walmartOrderId) &&
                            ` · ${c.amazonOrderId ?? c.walmartOrderId}`}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </PanelBody>
          </Panel>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

function getWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
