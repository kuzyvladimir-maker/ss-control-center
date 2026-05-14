"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Snowflake,
  Package,
  Loader2,
  ShoppingCart,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Btn,
  FilterTabs,
  KpiCard,
  PageHead,
  Panel,
  PanelHeader,
  PanelBody,
  StoreAvatar,
  storeKeyFor,
  TypeTag,
} from "@/components/kit";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// ─────────────────────────────────────────────────────────────────────────
// Types — mirror what /api/shipping/dashboard returns.
// ─────────────────────────────────────────────────────────────────────────

type State = "ready_to_buy" | "need_attention" | "waiting_placed" | "bought";
type ShipByBucket = "overdue" | "today" | "tomorrow" | "dayafter" | "later";
type AttentionReason =
  | "no_type"
  | "mixed_order"
  | "frozen_walmart"
  | "no_packing"
  | "no_sku"
  | "budget"
  | "no_service"
  | null;

interface DashboardItem {
  sku: string;
  productId: number | null;
  productTitle: string;
  quantity: number;
  knownType: "Frozen" | "Dry" | null;
}

interface DashboardOrder {
  orderId: string;
  orderNumber: string;
  storeId: string;
  storeName: string;
  channel: string | null;
  shipBy: string | null;
  timeBucket: ShipByBucket | null;
  deliverBy: string | null;
  state: State;
  needAttentionReason: AttentionReason;
  items: DashboardItem[];
  packingSignature: string | null;
  packingProfileFound: boolean | null;
  orderTotal: number;
  customerPaidShipping: number;
  currency: string;
}

interface PlanItem {
  id: string;
  orderNumber: string;
  carrier: string | null;
  service: string | null;
  price: number | null;
  edd: string | null;
  status: string;
  notes: string | null;
}

interface PlanResponse {
  planId: string;
  orders: PlanItem[];
}

interface StoreTotals {
  storeId: string;
  storeName: string;
  channel: string;
  all: number;
  readyToBuy: number;
  needAttention: number;
  waitingPlaced: number;
  boughtToday: number;
}

interface DashboardResponse {
  refreshedAt: string;
  storeBreakdown: StoreTotals[];
  timeBuckets: Record<ShipByBucket, number>;
  orders: DashboardOrder[];
}

const ATTENTION_LABELS: Record<NonNullable<AttentionReason>, string> = {
  no_type: "Product type unknown",
  mixed_order: "Mixed Frozen + Dry items",
  frozen_walmart: "Frozen on Walmart (not allowed)",
  no_packing: "Packing profile missing",
  no_sku: "SKU not in database",
  budget: "Over budget for any service",
  no_service: "No carrier service available",
};

const BUCKET_TABS: { id: ShipByBucket; label: string; activeCls: string }[] = [
  { id: "overdue",  label: "Overdue",  activeCls: "border-danger bg-danger-tint text-danger" },
  { id: "today",    label: "Today",    activeCls: "border-warn-strong bg-warn-tint text-warn-strong" },
  { id: "tomorrow", label: "Tomorrow", activeCls: "border-info bg-info-tint text-info" },
  { id: "dayafter", label: "Day after", activeCls: "border-green bg-green-soft text-green-ink" },
  { id: "later",    label: "Later",    activeCls: "border-rule bg-bg-elev text-ink-2" },
];

// ─────────────────────────────────────────────────────────────────────────
// Page component
// ─────────────────────────────────────────────────────────────────────────

export default function ShippingLabelsPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  // Per-order plan results when "Refresh rates" runs on a subset (e.g. after
  // an attention reason is fixed, we re-fetch rates only for that one order).
  const [planLoading, setPlanLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [bucketFilter, setBucketFilter] = useState<ShipByBucket | null>(null);
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [buying, setBuying] = useState(false);
  const [buyMsg, setBuyMsg] = useState<string | null>(null);
  const [buyingRow, setBuyingRow] = useState<string | null>(null);

  // Modal state
  const [classifyModal, setClassifyModal] = useState<DashboardOrder | null>(
    null
  );
  const [manualModal, setManualModal] = useState<DashboardOrder | null>(null);
  const [packingModal, setPackingModal] = useState<DashboardOrder | null>(null);
  const [skuModal, setSkuModal] = useState<DashboardOrder | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Two-pass load:
      //   1. /api/shipping/dashboard — state, $ fields, time buckets. Cheap.
      //   2. /api/shipping/plan?orderIds=… — carrier / service / price for
      //      every order in ready_to_buy state. Slow (Veeqo rates per
      //      allocation, ~1s each), so run after dashboard renders.
      //
      // Passing orderIds bypasses plan's default "today's dispatch only"
      // filter — without that, orders shipping tomorrow / day-after look
      // ready in the dashboard but show no rates because plan ignored them.
      setPlanLoading(true);
      const dashRes = await fetch("/api/shipping/dashboard");
      if (!dashRes.ok) throw new Error(`HTTP ${dashRes.status}`);
      const dashJson = (await dashRes.json()) as DashboardResponse;
      setData(dashJson);
      setLoading(false);

      const readyOrderIds = dashJson.orders
        .filter((o) => o.state === "ready_to_buy")
        .map((o) => o.orderId);

      if (readyOrderIds.length === 0) {
        setPlan(null);
        return;
      }

      try {
        const planRes = await fetch(
          `/api/shipping/plan?orderIds=${readyOrderIds.join(",")}`
        );
        if (planRes.ok) {
          const planJson = (await planRes.json()) as PlanResponse;
          setPlan(planJson);
        }
      } catch {
        /* plan failure is non-fatal — page still shows dashboard */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    } finally {
      setPlanLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Derived view ────────────────────────────────────────────────────
  const orders = useMemo(() => data?.orders ?? [], [data]);
  const filteredOrders = useMemo(() => {
    // Sort by actionability: ready_to_buy → need_attention → waiting_placed
    // → bought. Inside each state, sort by time bucket (overdue first) so the
    // most urgent rows always sit at the top of the list.
    const stateRank: Record<State, number> = {
      ready_to_buy: 0,
      need_attention: 1,
      waiting_placed: 2,
      bought: 3,
    };
    const bucketRank: Record<ShipByBucket, number> = {
      overdue: 0,
      today: 1,
      tomorrow: 2,
      dayafter: 3,
      later: 4,
    };
    return orders
      .filter((o) => {
        if (bucketFilter && o.timeBucket !== bucketFilter) return false;
        if (storeFilter && o.storeId !== storeFilter) return false;
        return true;
      })
      .slice()
      .sort((a, b) => {
        const ds = stateRank[a.state] - stateRank[b.state];
        if (ds !== 0) return ds;
        const ab = a.timeBucket ? bucketRank[a.timeBucket] : 99;
        const bb = b.timeBucket ? bucketRank[b.timeBucket] : 99;
        return ab - bb;
      });
  }, [orders, bucketFilter, storeFilter]);

  const selectableIds = useMemo(
    () =>
      new Set(
        filteredOrders
          .filter((o) => o.state === "ready_to_buy")
          .map((o) => o.orderId)
      ),
    [filteredOrders]
  );

  const totals = useMemo(() => {
    const all = orders.length;
    const ready = orders.filter((o) => o.state === "ready_to_buy").length;
    const attention = orders.filter((o) => o.state === "need_attention").length;
    const waiting = orders.filter((o) => o.state === "waiting_placed").length;
    return { all, ready, attention, waiting };
  }, [orders]);

  // Index plan rows by orderNumber so the OrderRow can pick up carrier /
  // price / EDD without an extra lookup at render time. Plan keys on
  // orderNumber (Amazon-format), same as dashboard, so the merge is clean.
  const planByOrderNumber = useMemo(() => {
    const m = new Map<string, PlanItem>();
    if (plan) for (const p of plan.orders) m.set(p.orderNumber, p);
    return m;
  }, [plan]);

  // ── Actions ─────────────────────────────────────────────────────────
  function toggleAll() {
    if (selected.size === selectableIds.size) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableIds));
    }
  }

  function toggleOne(orderId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  async function buySelected() {
    if (selected.size === 0) return;
    setBuying(true);
    setBuyMsg(`Generating plan for ${selected.size} order(s)…`);
    try {
      // Build a plan filtered to just the selected orders, then buy.
      const ids = [...selected].join(",");
      const planRes = await fetch(`/api/shipping/plan?orderIds=${ids}`);
      const planJson = await planRes.json();
      if (!planRes.ok)
        throw new Error(planJson?.error || "Failed to plan labels");
      const planId: string = planJson.planId;
      const itemIds: string[] = (planJson.orders ?? [])
        .filter((o: { status: string }) => o.status === "pending")
        .map((o: { id: string }) => o.id);
      if (itemIds.length === 0) {
        setBuyMsg("Nothing buyable in the selection.");
        return;
      }
      setBuyMsg(`Buying ${itemIds.length} label(s)…`);
      const buyRes = await fetch("/api/shipping/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, itemIds }),
      });
      const buyJson = await buyRes.json();
      if (!buyRes.ok)
        throw new Error(buyJson?.error || "Failed to buy labels");
      const ok = (buyJson.bought ?? []).length;
      const fail = (buyJson.errors ?? []).length;
      setBuyMsg(`Bought ${ok} · ${fail} failed`);
      setSelected(new Set());
      await load();
    } catch (e) {
      setBuyMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBuying(false);
    }
  }

  // Per-row Buy — uses the planId fetched at page load. If the order is
  // missing from that plan (rare: just-resolved attention), we fall back
  // to re-running plan with ?orderIds=ID first.
  async function buyOne(o: DashboardOrder) {
    setBuyingRow(o.orderId);
    setBuyMsg(`Buying label for ${o.orderNumber}…`);
    try {
      let planId = plan?.planId ?? null;
      let planItemId =
        plan?.orders.find(
          (p) => p.orderNumber === o.orderNumber && p.status === "pending"
        )?.id ?? null;
      if (!planId || !planItemId) {
        const r = await fetch(
          `/api/shipping/plan?orderIds=${encodeURIComponent(o.orderId)}`
        );
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Failed to plan");
        planId = j.planId;
        const item = (j.orders ?? []).find(
          (p: { orderNumber: string; status: string }) =>
            p.orderNumber === o.orderNumber && p.status === "pending"
        );
        if (!item) throw new Error("No buyable rate found for this order");
        planItemId = item.id;
      }
      const buyRes = await fetch("/api/shipping/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, itemIds: [planItemId] }),
      });
      const buyJson = await buyRes.json();
      if (!buyRes.ok) throw new Error(buyJson?.error || "Failed to buy");
      setBuyMsg(`Bought ${o.orderNumber}`);
      await load();
    } catch (e) {
      setBuyMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBuyingRow(null);
    }
  }

  return (
    <div className="space-y-5">
      <PageHead
        title="Shipping labels"
        subtitle={
          data?.refreshedAt
            ? `Last refresh: ${new Date(data.refreshedAt).toLocaleString()}`
            : "Loading…"
        }
        actions={
          <Btn
            icon={<RefreshCw size={13} />}
            onClick={load}
            loading={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Btn>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/30 bg-danger-tint px-4 py-3 text-[12px] text-danger">
          {error}
        </div>
      )}

      {/* Totals row */}
      <div className="grid gap-3 sm:grid-cols-4">
        <KpiCard
          label="Awaiting fulfillment"
          value={totals.all}
          icon={<Package size={14} />}
        />
        <KpiCard
          label="Ready to buy"
          value={totals.ready}
          icon={<CheckCircle size={14} />}
          iconVariant={totals.ready > 0 ? "default" : "default"}
        />
        <KpiCard
          label="Need attention"
          value={totals.attention}
          icon={<AlertTriangle size={14} />}
          iconVariant={totals.attention > 0 ? "warn" : "default"}
        />
        <KpiCard
          label="Waiting for procurement"
          value={totals.waiting}
          icon={<Loader2 size={14} />}
        />
      </div>

      {/* Store breakdown */}
      {data && data.storeBreakdown.length > 0 && (
        <Panel>
          <PanelHeader title="By store" />
          <PanelBody>
            <div className="flex flex-wrap gap-2">
              {data.storeBreakdown.map((s) => (
                <button
                  key={s.storeId}
                  type="button"
                  onClick={() =>
                    setStoreFilter(storeFilter === s.storeId ? null : s.storeId)
                  }
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-[12px] min-w-[160px]",
                    storeFilter === s.storeId
                      ? "border-green bg-green-soft text-green-ink"
                      : "border-rule bg-surface hover:border-silver-line"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <StoreAvatar
                      store={storeKeyFor({
                        marketplace: s.channel,
                        storeName: s.storeName,
                      })}
                      size="sm"
                    />
                    <span className="font-medium truncate">{s.storeName}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-1 text-[11px]">
                    <div>
                      <div className="text-ink-3">all</div>
                      <div className="font-semibold tabular">{s.all}</div>
                    </div>
                    <div>
                      <div className="text-ink-3">ready</div>
                      <div className="font-semibold tabular">{s.readyToBuy}</div>
                    </div>
                    <div>
                      <div className="text-ink-3">⚠</div>
                      <div className="font-semibold tabular text-warn-strong">
                        {s.needAttention}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </PanelBody>
        </Panel>
      )}

      {/* Bucket filter */}
      {data && (
        <FilterTabs
          tabs={[
            { id: "all" as const, label: "All", count: orders.length },
            ...BUCKET_TABS.map((b) => ({
              id: b.id,
              label: b.label,
              count: data.timeBuckets[b.id] ?? 0,
            })),
          ]}
          active={bucketFilter ?? ("all" as const)}
          onChange={(id) =>
            setBucketFilter(id === "all" ? null : (id as ShipByBucket))
          }
        />
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between rounded-md border border-rule bg-surface px-3 py-2">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <input
            type="checkbox"
            checked={
              selectableIds.size > 0 && selected.size === selectableIds.size
            }
            onChange={toggleAll}
          />
          Select all ready ({selected.size}/{selectableIds.size})
        </label>
        <div className="flex items-center gap-2">
          {buyMsg && (
            <span className="text-[11px] text-ink-3">{buyMsg}</span>
          )}
          <Btn
            variant="primary"
            icon={<ShoppingCart size={13} />}
            onClick={buySelected}
            loading={buying}
            disabled={selected.size === 0}
          >
            {buying ? "Buying…" : `Buy selected (${selected.size})`}
          </Btn>
        </div>
      </div>

      {/* Order list */}
      <div className="space-y-2">
        {loading && !data ? (
          <div className="rounded-md border border-rule bg-surface px-4 py-10 text-center text-[12px] text-ink-3">
            Fetching orders from Veeqo…
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="rounded-md border border-rule bg-surface px-4 py-10 text-center text-[12px] text-ink-3">
            No orders match the current filter.
          </div>
        ) : (
          filteredOrders.map((o) => (
            <OrderRow
              key={o.orderId}
              order={o}
              plan={planByOrderNumber.get(o.orderNumber) ?? null}
              planLoading={planLoading}
              selected={selected.has(o.orderId)}
              buying={buyingRow === o.orderId}
              onToggleSelected={() => toggleOne(o.orderId)}
              onClassify={() => setClassifyModal(o)}
              onManual={() => setManualModal(o)}
              onPacking={() => setPackingModal(o)}
              onSku={() => setSkuModal(o)}
              onBuy={() => buyOne(o)}
            />
          ))
        )}
      </div>

      {classifyModal && (
        <ClassifyAiDialog
          order={classifyModal}
          onClose={(refresh) => {
            setClassifyModal(null);
            if (refresh) load();
          }}
        />
      )}
      {manualModal && (
        <ManualTypeDialog
          order={manualModal}
          onClose={(refresh) => {
            setManualModal(null);
            if (refresh) load();
          }}
        />
      )}
      {packingModal && (
        <PackingProfileDialog
          order={packingModal}
          onClose={(refresh) => {
            setPackingModal(null);
            if (refresh) load();
          }}
        />
      )}
      {skuModal && (
        <SkuDataDialog
          order={skuModal}
          onClose={(refresh) => {
            setSkuModal(null);
            if (refresh) load();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Order row
// ─────────────────────────────────────────────────────────────────────────

function OrderRow({
  order,
  plan,
  planLoading,
  selected,
  buying,
  onToggleSelected,
  onClassify,
  onManual,
  onPacking,
  onSku,
  onBuy,
}: {
  order: DashboardOrder;
  plan: PlanItem | null;
  planLoading: boolean;
  selected: boolean;
  buying: boolean;
  onToggleSelected: () => void;
  onClassify: () => void;
  onManual: () => void;
  onPacking: () => void;
  onSku: () => void;
  onBuy: () => void;
}) {
  const isReady = order.state === "ready_to_buy";
  const isAttn = order.state === "need_attention";
  const isWaiting = order.state === "waiting_placed";
  const isBought = order.state === "bought";

  const fmt$ = (v: number) =>
    `$${v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  // Label cost recommendation comes from /api/shipping/plan. If plan is
  // still in flight (planLoading) we show a spinner; if plan is in but
  // this order has status="stop", we show the stop reason from the plan.
  const planPending = plan && plan.status === "pending";
  const planStop = plan && plan.status !== "pending" && plan.notes;

  // Margin sanity: customer paid X for shipping, label costs Y. Positive
  // margin = we made money on shipping; negative = we ate the difference.
  const shippingMargin =
    plan?.price != null
      ? order.customerPaidShipping - plan.price
      : null;

  return (
    <div
      className={cn(
        "rounded-md border bg-surface p-3 text-[12.5px]",
        isAttn
          ? "border-warn-strong/40 bg-warn-tint/30"
          : isWaiting
            ? "border-rule opacity-70"
            : isBought
              ? "border-green/40 bg-green-soft/30"
              : "border-rule"
      )}
    >
      {/* Top row: select + identity + type tag */}
      <div className="flex items-start gap-3">
        {isReady ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            className="mt-1"
          />
        ) : (
          <div className="mt-1 h-3.5 w-3.5">
            {isAttn ? (
              <AlertTriangle size={14} className="text-warn-strong" />
            ) : isBought ? (
              <CheckCircle size={14} className="text-green" />
            ) : (
              <Loader2 size={14} className="text-ink-3" />
            )}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-[12px] text-ink">
              {order.orderNumber}
            </span>
            <span className="text-[11px] text-ink-3">
              · {order.storeName}
            </span>
            {order.shipBy && (
              <span className="text-[11px] text-ink-3">
                · Ship by {fmtDate(order.shipBy)}
              </span>
            )}
          </div>

          {/* Items list — each on its own line so multi-item orders read clearly. */}
          <ul className="mt-1 space-y-0.5">
            {order.items.map((i) => (
              <li key={i.sku} className="truncate text-[12px] text-ink-2">
                <span className="font-medium text-ink">{i.productTitle}</span>{" "}
                <span className="text-ink-3">× {i.quantity}</span>{" "}
                <span className="font-mono text-[10.5px] text-ink-3">
                  ({i.sku})
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="shrink-0">
          {order.items[0]?.knownType && (
            <TypeTag type={order.items[0].knownType} />
          )}
        </div>
      </div>

      {/* Money + carrier grid. Order total + customer-paid shipping are known
          for every Veeqo order regardless of state, so they always show.
          Label cost / carrier / EDD only appear when /api/shipping/plan has
          a rate for the order (ready_to_buy and just-bought rows). The
          marketplace deadline (Amazon / Walmart deliver-by) sits in its own
          cell so the operator can eyeball whether the carrier's EDD beats it. */}
      <div className="mt-2.5 ml-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-5 text-[11.5px]">
        <Cell label="Order total" value={fmt$(order.orderTotal)} />
        <Cell
          label="Customer paid shipping"
          value={fmt$(order.customerPaidShipping)}
        />
        <Cell
          label="Marketplace deadline"
          value={order.deliverBy ? fmtDate(order.deliverBy) : "—"}
          // When a carrier EDD is known we compare against it ("on time" /
          // "late by N days"). Otherwise we fall back to plain urgency
          // (days until deadline) so the operator can still tell at a glance
          // which orders need fixing first.
          sub={
            plan?.edd
              ? deadlineRiskNote(order.deliverBy, plan.edd)
              : urgencyNote(order.deliverBy)
          }
          valueClass={
            (plan?.edd
              ? deadlineRiskClass(order.deliverBy, plan.edd)
              : urgencyClass(order.deliverBy)) ?? "text-ink"
          }
        />
        {(isReady || isBought) && (
          <Cell
            label={isBought ? "Label cost (bought)" : "Label cost"}
            value={
              planLoading && !plan
                ? "loading…"
                : plan?.price != null
                  ? fmt$(plan.price)
                  : planStop
                    ? "stopped"
                    : "—"
            }
            valueClass={
              shippingMargin != null && shippingMargin < 0
                ? "text-danger"
                : "text-ink"
            }
            sub={
              shippingMargin != null
                ? `margin ${shippingMargin >= 0 ? "+" : ""}${fmt$(shippingMargin)}`
                : undefined
            }
          />
        )}
        {(isReady || isBought) && (
          <Cell
            label="Carrier"
            value={
              plan?.carrier && plan.service
                ? `${plan.carrier} ${plan.service}`
                : planLoading
                  ? "loading…"
                  : "—"
            }
            sub={plan?.edd ? `EDD ${fmtDate(plan.edd)}` : undefined}
          />
        )}
      </div>

      {/* Action area per state */}
      {isAttn && (
        <div className="mt-2 ml-6 flex flex-wrap items-center gap-2">
          <span className="rounded bg-warn-tint px-1.5 py-0.5 text-[11px] font-medium text-warn-strong">
            {order.needAttentionReason
              ? ATTENTION_LABELS[order.needAttentionReason]
              : "Needs review"}
          </span>
          {order.needAttentionReason === "no_type" && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11.5px]"
                onClick={onClassify}
              >
                <Sparkles size={12} className="mr-1" /> Classify with AI
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11.5px]"
                onClick={onManual}
              >
                Set manually
              </Button>
            </>
          )}
          {order.needAttentionReason === "no_packing" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11.5px]"
              onClick={onPacking}
            >
              <Package size={12} className="mr-1" /> Set packing profile
            </Button>
          )}
          {order.needAttentionReason === "no_sku" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11.5px]"
              onClick={onSku}
            >
              <Package size={12} className="mr-1" /> Add SKU data
            </Button>
          )}
          {order.needAttentionReason === "mixed_order" && (
            <span className="text-[11px] text-ink-3">
              Split the order in Veeqo (Frozen + Dry on one label isn&apos;t
              supported).
            </span>
          )}
          {order.needAttentionReason === "frozen_walmart" && (
            <span className="text-[11px] text-ink-3">
              Frozen items can&apos;t ship via Walmart — cancel or switch
              channel.
            </span>
          )}
          {(order.needAttentionReason === "budget" ||
            order.needAttentionReason === "no_service") && (
            <span className="text-[11px] text-ink-3">
              No carrier rate fits — review manually in Veeqo.
            </span>
          )}
        </div>
      )}

      {/* Ready row: per-row Buy + (when plan stopped) the reason. */}
      {isReady && (
        <div className="mt-2 ml-6 flex flex-wrap items-center justify-between gap-2">
          {planStop ? (
            <span className="rounded bg-danger-tint px-1.5 py-0.5 text-[11px] font-medium text-danger">
              {plan?.notes}
            </span>
          ) : (
            <span className="text-[11px] text-ink-3">
              {planPending
                ? "Rate ready — confirm to buy"
                : planLoading
                  ? "Calculating best rate…"
                  : "Awaiting rate"}
            </span>
          )}
          <Button
            size="sm"
            onClick={onBuy}
            disabled={buying || !planPending}
            className="h-7 text-[11.5px]"
          >
            {buying ? (
              <>
                <Loader2 size={12} className="mr-1 animate-spin" />
                Buying…
              </>
            ) : (
              <>
                <ShoppingCart size={12} className="mr-1" /> Buy label
              </>
            )}
          </Button>
        </div>
      )}

      {isWaiting && (
        <div className="mt-1 ml-6 text-[11px] text-ink-3">
          Waiting for procurement (no <code>Placed</code> tag yet).
        </div>
      )}
      {isBought && (
        <div className="mt-1 ml-6 text-[11px] text-green-ink">
          Label already purchased.
        </div>
      )}
    </div>
  );
}

/** Compact "5/14" date for dense grid cells. Falls back to the raw value
 *  if parsing fails, so we never blank out useful info. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}

/** Days between marketplace deadline and carrier EDD. Negative → carrier
 *  arrives before deadline (good). Positive → late. */
function daysLate(
  deliverBy: string | null | undefined,
  edd: string | null | undefined
): number | null {
  if (!deliverBy || !edd) return null;
  const a = new Date(edd);
  const b = new Date(deliverBy);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / 86400000);
}

function deadlineRiskNote(
  deliverBy: string | null | undefined,
  edd: string | null | undefined
): string | undefined {
  const d = daysLate(deliverBy, edd);
  if (d == null) return undefined;
  if (d <= -2) return `+${-d} days buffer`;
  if (d <= 0) return "on time";
  return `late by ${d} day${d === 1 ? "" : "s"}`;
}

function deadlineRiskClass(
  deliverBy: string | null | undefined,
  edd: string | null | undefined
): string | null {
  const d = daysLate(deliverBy, edd);
  if (d == null) return null;
  if (d > 0) return "text-danger";
  if (d === 0) return "text-warn-strong";
  return "text-green";
}

/** Days from today to the deadline, in calendar days. Negative = past. */
function daysUntilDeadline(deliverBy: string | null | undefined): number | null {
  if (!deliverBy) return null;
  const d = new Date(deliverBy);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  return Math.round(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
      86400000
  );
}

function urgencyNote(
  deliverBy: string | null | undefined
): string | undefined {
  const d = daysUntilDeadline(deliverBy);
  if (d == null) return undefined;
  if (d < 0) return `${-d}d past deadline`;
  if (d === 0) return "due today";
  if (d === 1) return "1 day left";
  return `${d} days left`;
}

function urgencyClass(
  deliverBy: string | null | undefined
): string | null {
  const d = daysUntilDeadline(deliverBy);
  if (d == null) return null;
  if (d < 0) return "text-danger";
  if (d <= 1) return "text-danger";
  if (d <= 3) return "text-warn-strong";
  return "text-green";
}

function Cell({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded bg-surface-tint px-2 py-1.5">
      <div className="text-[10px] font-mono uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 truncate font-semibold tabular",
          valueClass || "text-ink"
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="truncate text-[10.5px] text-ink-3">{sub}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────

function ClassifyAiDialog({
  order,
  onClose,
}: {
  order: DashboardOrder;
  onClose: (refresh: boolean) => void;
}) {
  const item = order.items[0];
  const productId = item?.productId ?? null;
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<{
    type: "Frozen" | "Dry";
    confidence: number;
    reasoning: string;
    productImage: string | null;
    productTitle: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!productId) {
      setError("Order has no productId");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const r = await fetch("/api/shipping/classify-ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId }),
        });
        const j = await r.json();
        if (!cancelled) {
          if (!r.ok) setError(j?.error || `HTTP ${r.status}`);
          else setResult(j);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  async function confirm(type: "Frozen" | "Dry", source: "ai" | "manual") {
    if (!productId || !result) return;
    setSaving(true);
    try {
      await fetch("/api/shipping/product-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          type,
          source,
          aiConfidence: source === "ai" ? result.confidence : undefined,
          aiReasoning: source === "ai" ? result.reasoning : undefined,
        }),
      });
      onClose(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose(false)}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>AI Classification</DialogTitle>
          <DialogDescription>
            {item?.productTitle || "Product"}
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3">
            <Loader2 size={14} className="animate-spin" />
            AI is analyzing the product…
          </div>
        )}
        {error && (
          <div className="rounded border border-danger/30 bg-danger-tint p-3 text-[12px] text-danger">
            {error}
          </div>
        )}
        {result && (
          <div className="space-y-3">
            {result.productImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={result.productImage}
                alt={result.productTitle}
                className="max-h-[180px] w-full rounded-md object-contain border border-rule bg-bg-elev"
              />
            )}
            <div className="rounded-md border border-rule bg-surface-tint p-3">
              <div className="flex items-center gap-2">
                {result.type === "Frozen" ? (
                  <Snowflake size={14} className="text-info" />
                ) : (
                  <Package size={14} className="text-ink-2" />
                )}
                <span className="font-semibold text-ink">
                  Result: {result.type}
                </span>
                <span className="ml-auto text-[11px] text-ink-3">
                  confidence {(result.confidence * 100).toFixed(0)}%
                </span>
              </div>
              <div className="mt-1 text-[12px] text-ink-2">
                {result.reasoning}
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onClose(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          {result && (
            <>
              <Button
                variant="outline"
                onClick={() =>
                  confirm(result.type === "Frozen" ? "Dry" : "Frozen", "manual")
                }
                disabled={saving}
              >
                Override to {result.type === "Frozen" ? "Dry" : "Frozen"}
              </Button>
              <Button
                onClick={() => confirm(result.type, "ai")}
                disabled={saving}
              >
                {saving ? "Saving…" : "Confirm"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManualTypeDialog({
  order,
  onClose,
}: {
  order: DashboardOrder;
  onClose: (refresh: boolean) => void;
}) {
  const item = order.items[0];
  const productId = item?.productId ?? null;
  const [saving, setSaving] = useState(false);

  async function save(type: "Frozen" | "Dry") {
    if (!productId) return;
    setSaving(true);
    try {
      await fetch("/api/shipping/product-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, type, source: "manual" }),
      });
      onClose(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose(false)}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Set product type manually</DialogTitle>
          <DialogDescription>{item?.productTitle}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="h-20"
            onClick={() => save("Frozen")}
            disabled={saving}
          >
            <Snowflake size={20} className="mr-2 text-info" /> Frozen
          </Button>
          <Button
            variant="outline"
            className="h-20"
            onClick={() => save("Dry")}
            disabled={saving}
          >
            <Package size={20} className="mr-2 text-ink-2" /> Dry
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PackingProfileDialog({
  order,
  onClose,
}: {
  order: DashboardOrder;
  onClose: (refresh: boolean) => void;
}) {
  const [boxSize, setBoxSize] = useState("M");
  const [weight, setWeight] = useState("");
  const [weightFedex, setWeightFedex] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const description = order.items
    .map((i) => `${i.productTitle} × ${i.quantity}`)
    .join(" + ");
  const totalQty = order.items.reduce((sum, i) => sum + i.quantity, 0);

  async function save() {
    if (!order.packingSignature) {
      setErr("Order has no packing signature");
      return;
    }
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) {
      setErr("Weight must be a positive number");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/shipping/packing-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signature: order.packingSignature,
          description,
          boxSize,
          weight: w,
          weightFedex: weightFedex
            ? Number(weightFedex)
            : undefined,
          itemCount: order.items.length,
          totalQty,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      onClose(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose(false)}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Packing profile</DialogTitle>
          <DialogDescription>
            Order #{order.orderNumber}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[12.5px]">
          <div>
            <div className="font-medium text-ink mb-1">Composition</div>
            <ul className="rounded border border-rule bg-surface-tint p-2 text-ink-2 space-y-0.5">
              {order.items.map((i) => (
                <li key={i.sku}>
                  • {i.productTitle} × {i.quantity} ({i.sku})
                </li>
              ))}
            </ul>
            <div className="mt-1 text-[11px] text-ink-3">
              Signature:{" "}
              <code className="font-mono">{order.packingSignature}</code>
            </div>
          </div>

          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Box size
            </label>
            <select
              value={boxSize}
              onChange={(e) => setBoxSize(e.target.value)}
              className="w-full rounded border border-rule bg-surface px-2 py-1.5 text-[12.5px]"
            >
              <option>XS</option>
              <option>S</option>
              <option>M</option>
              <option>L</option>
              <option>XL</option>
              <option>XXS</option>
              <option>12x12x8</option>
              <option>12x12x6</option>
              <option>7x7x6</option>
              <option>7x5x14</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Weight (lbs)
              </label>
              <Input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder="2.5"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                FedEx One Rate (lbs)
              </label>
              <Input
                value={weightFedex}
                onChange={(e) => setWeightFedex(e.target.value)}
                placeholder="auto = weight × 1.25"
              />
            </div>
          </div>

          {err && (
            <div className="rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger">
              {err}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onClose(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add SKU to the internal SkuShippingData table (the same data layer the
 * plan route reads). Used when the dashboard flagged an order as no_sku.
 *
 * Saving one row at a time per visible SKU keeps it simple — when an order
 * has multiple unknown SKUs the operator gets called back here for each.
 */
function SkuDataDialog({
  order,
  onClose,
}: {
  order: DashboardOrder;
  onClose: (refresh: boolean) => void;
}) {
  // Pick the first SKU as the one we're filling in. The rare case of
  // multiple unknown SKUs in one order will re-open the dialog on the
  // next render after dashboard refresh.
  const item = order.items[0];
  const [productTitle, setProductTitle] = useState(item?.productTitle ?? "");
  const [category, setCategory] = useState<"Frozen" | "Dry">(
    item?.knownType ?? "Dry"
  );
  const [marketplace, setMarketplace] = useState(
    order.channel?.toLowerCase().includes("walmart") ? "Walmart" : "Amazon"
  );
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");
  const [weightFedex, setWeightFedex] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!item) return;
    const L = Number(length);
    const W = Number(width);
    const H = Number(height);
    const wt = Number(weight);
    if (
      ![L, W, H, wt].every((n) => Number.isFinite(n) && n > 0)
    ) {
      setErr("Length, width, height, weight must all be positive numbers");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/shipping/fix-sku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: item.sku,
          productTitle,
          marketplace,
          category,
          length: L,
          width: W,
          height: H,
          weight: wt,
          weightFedex: weightFedex ? Number(weightFedex) : wt * 1.25,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      onClose(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose(false)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add SKU to database</DialogTitle>
          <DialogDescription>
            Order #{order.orderNumber} · SKU{" "}
            <code className="font-mono">{item?.sku}</code>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[12.5px]">
          <div>
            <label className="block text-[11.5px] font-medium text-ink mb-1">
              Product title
            </label>
            <Input
              value={productTitle}
              onChange={(e) => setProductTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Marketplace
              </label>
              <select
                value={marketplace}
                onChange={(e) => setMarketplace(e.target.value)}
                className="w-full rounded border border-rule bg-surface px-2 py-1.5 text-[12.5px]"
              >
                <option>Amazon</option>
                <option>Walmart</option>
                <option>Both</option>
              </select>
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Category
              </label>
              <select
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value as "Frozen" | "Dry")
                }
                className="w-full rounded border border-rule bg-surface px-2 py-1.5 text-[12.5px]"
              >
                <option>Dry</option>
                <option>Frozen</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Length (in)
              </label>
              <Input
                value={length}
                onChange={(e) => setLength(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Width (in)
              </label>
              <Input
                value={width}
                onChange={(e) => setWidth(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Height (in)
              </label>
              <Input
                value={height}
                onChange={(e) => setHeight(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                Weight (lbs)
              </label>
              <Input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder="standard"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-ink mb-1">
                FedEx One Rate (lbs)
              </label>
              <Input
                value={weightFedex}
                onChange={(e) => setWeightFedex(e.target.value)}
                placeholder="auto = weight × 1.25"
              />
            </div>
          </div>

          {err && (
            <div className="rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger">
              {err}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onClose(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

