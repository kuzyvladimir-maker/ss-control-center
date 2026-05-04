"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ShoppingCart,
  Truck,
  MessageSquare,
  HeartPulse,
  Receipt,
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

interface CsCaseRow {
  id: string;
  channel?: string | null;
  store?: string | null;
  orderId?: string | null;
  category?: string | null;
  categoryName?: string | null;
  priority?: string | null;
  createdAt: string;
}

function formatTime(date: string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
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
  const [data, setData] = useState<DashboardData | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [cases, setCases] = useState<CsCaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [summary, veeqo, cs] = await Promise.all([
        fetch("/api/dashboard/summary").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/veeqo/orders?status=awaiting_fulfillment&page_size=10")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch("/api/customer-hub/messages?limit=4&status=NEW")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

      if (summary) setData(summary);

      const veeqoRows: VeeqoOrder[] = Array.isArray(veeqo)
        ? veeqo
        : Array.isArray(veeqo?.orders)
          ? veeqo.orders
          : [];

      const mapped: OrderRow[] = veeqoRows.slice(0, 8).map((o) => {
        const item = o.line_items?.[0];
        const productName = item?.sellable?.product_title;
        const tags = item?.sellable?.tags || [];
        const isFrozen = tags.some((t) => /frozen/i.test(t.name || ""));
        const isDry = tags.some((t) => /dry/i.test(t.name || ""));
        const channel =
          o.channel?.name?.toLowerCase().includes("walmart")
            ? "Walmart"
            : "Amazon";
        return {
          id: String(o.number ?? o.id ?? ""),
          amazonOrderId: o.number ?? null,
          storeIndex: null,
          storeName: o.store?.name ?? o.store_name ?? null,
          marketplace: channel,
          productName,
          productType: isFrozen ? "Frozen" : isDry ? "Dry" : null,
          shipBy: o.due_date ?? o.dispatch_date ?? null,
          status: o.status === "shipped" ? "Shipped" : "Ready",
        };
      });
      setOrders(mapped);

      const messages: CsCaseRow[] = Array.isArray(cs?.messages)
        ? cs.messages
        : Array.isArray(cs)
          ? cs
          : [];
      setCases(messages.slice(0, 4));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function syncNow() {
    setSyncing(true);
    await fetch("/api/sync", { method: "POST" }).catch(() => undefined);
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

  const totalToShip = data?.orders.awaitingShipment ?? 0;
  const shippedToday = data?.orders.shippedToday ?? 0;

  return (
    <div className="space-y-5">
      <PageHead
        title="Dashboard"
        syncChip={data?.syncedAt && <SyncChip when={data.syncedAt} />}
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
                Generate plan
              </Btn>
            </Link>
          </>
        }
      />

      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Orders 30d"
          value={data?.orders.total30d ?? "—"}
          icon={<ShoppingCart size={14} />}
          trend={{ value: `S1 ${data?.orders.store1 ?? 0} · S2 ${data?.orders.store2 ?? 0}`, subText: "by store" }}
        />
        <KpiCard
          label="Awaiting ship"
          value={totalToShip}
          icon={<Truck size={14} />}
          chips={[
            { label: `${shippedToday} shipped today`, variant: "ok" },
          ]}
        />
        <KpiCard
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
          label="Health issues"
          value={(data?.health.issues ?? 0) + (data?.walmart?.healthIssues ?? 0)}
          icon={<HeartPulse size={14} />}
          iconVariant={
            (data?.health.issues ?? 0) + (data?.walmart?.healthIssues ?? 0) > 0
              ? "danger"
              : "default"
          }
          trend={
            data?.adjustments.monthlyTotal && data.adjustments.monthlyTotal < 0
              ? {
                  value: `$${Math.abs(data.adjustments.monthlyTotal).toFixed(2)}`,
                  positive: false,
                  subText: "adj 30d",
                }
              : undefined
          }
        />
      </div>

      {/* Walmart row (if available) */}
      {data?.walmart && (
        <div className="grid gap-3 sm:grid-cols-4">
          <KpiCard
            label="Walmart 30d"
            value={data.walmart.ordersTotal30d}
            icon={<StoreAvatar store="walmart" size="sm" />}
            trend={{ value: `${data.walmart.ordersToday} today` }}
          />
          <KpiCard
            label="Walmart returns"
            value={data.walmart.returnsPending}
            icon={<Receipt size={14} />}
            iconVariant={data.walmart.returnsPending > 0 ? "warn" : "default"}
          />
          <KpiCard
            label="Walmart refunds 7d"
            value={`$${data.walmart.refundsLast7d.toFixed(0)}`}
            icon={<Receipt size={14} />}
          />
          <KpiCard
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
            count={orders.length}
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
                          className="border-b border-rule last:border-0 hover:bg-surface-tint"
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
                    <div key={o.id} className="px-4 py-3">
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
                    </div>
                  ))}
                </div>
              </>
            )}
          </PanelBody>
        </Panel>

        {/* Right column */}
        <div className="space-y-4">
          {/* Shipping progress */}
          <Panel className="bg-green-soft border-green-soft2">
            <PanelBody>
              <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-green-ink/70">
                Shipping progress
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-[34px] font-semibold leading-none tabular text-green-ink">
                  {shippedToday}
                </span>
                <span className="text-[14px] text-green-ink/60 tabular">
                  / {shippedToday + totalToShip}
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
                      (shippedToday + totalToShip) > 0
                        ? Math.round(
                            (shippedToday / (shippedToday + totalToShip)) * 100
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
                  <div className="text-green-ink/60">Shipped today</div>
                  <div className="text-green-ink font-semibold tabular">
                    {shippedToday}
                  </div>
                </div>
              </div>
            </PanelBody>
          </Panel>

          {/* Customer queue */}
          <Panel>
            <PanelHeader
              title="Customer queue"
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
                    <div
                      key={c.id}
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
                            {c.category} · {c.categoryName ?? "Open case"}
                          </div>
                          <div className="text-[10.5px] font-mono text-ink-3">
                            {timeAgo(c.createdAt)}
                          </div>
                        </div>
                        <div className="text-[11px] text-ink-3 truncate">
                          {c.channel ?? "Amazon"}
                          {c.store && ` · ${c.store}`}
                          {c.orderId && ` · ${c.orderId}`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </PanelBody>
          </Panel>
        </div>
      </div>
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
