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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [bucketFilter, setBucketFilter] = useState<ShipByBucket | null>(null);
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [buying, setBuying] = useState(false);
  const [buyMsg, setBuyMsg] = useState<string | null>(null);

  // Modal state
  const [classifyModal, setClassifyModal] = useState<DashboardOrder | null>(
    null
  );
  const [manualModal, setManualModal] = useState<DashboardOrder | null>(null);
  const [packingModal, setPackingModal] = useState<DashboardOrder | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/shipping/dashboard");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as DashboardResponse;
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Derived view ────────────────────────────────────────────────────
  const orders = useMemo(() => data?.orders ?? [], [data]);
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (bucketFilter && o.timeBucket !== bucketFilter) return false;
      if (storeFilter && o.storeId !== storeFilter) return false;
      return true;
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
              selected={selected.has(o.orderId)}
              onToggleSelected={() => toggleOne(o.orderId)}
              onClassify={() => setClassifyModal(o)}
              onManual={() => setManualModal(o)}
              onPacking={() => setPackingModal(o)}
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Order row
// ─────────────────────────────────────────────────────────────────────────

function OrderRow({
  order,
  selected,
  onToggleSelected,
  onClassify,
  onManual,
  onPacking,
}: {
  order: DashboardOrder;
  selected: boolean;
  onToggleSelected: () => void;
  onClassify: () => void;
  onManual: () => void;
  onPacking: () => void;
}) {
  const isReady = order.state === "ready_to_buy";
  const isAttn = order.state === "need_attention";
  const isWaiting = order.state === "waiting_placed";
  const isBought = order.state === "bought";

  const itemLine = order.items
    .map(
      (i) =>
        `${i.productTitle} × ${i.quantity}${
          i.knownType ? "" : " (unknown type)"
        }`
    )
    .join(" + ");

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
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[12px] text-ink">
              {order.orderNumber}
            </span>
            <span className="text-[11px] text-ink-3">
              · {order.storeName}
            </span>
            {order.shipBy && (
              <span className="text-[11px] text-ink-3">
                · Ship by {order.shipBy}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-ink-2">
            {itemLine}
          </div>

          {/* Action area per state */}
          {isAttn && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
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
            </div>
          )}
          {isWaiting && (
            <div className="mt-1 text-[11px] text-ink-3">
              Waiting for procurement (no <code>Placed</code> tag yet).
            </div>
          )}
          {isBought && (
            <div className="mt-1 text-[11px] text-green-ink">
              Label already purchased.
            </div>
          )}
        </div>

        <div className="shrink-0">
          {order.items[0]?.knownType && (
            <TypeTag type={order.items[0].knownType} />
          )}
        </div>
      </div>
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
