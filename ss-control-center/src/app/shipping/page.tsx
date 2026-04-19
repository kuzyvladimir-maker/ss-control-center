"use client";

import { useState, useEffect, useMemo } from "react";
import {
  RefreshCw,
  ShoppingCart,
  Download,
  Loader2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Snowflake,
  Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Btn,
  CarrierBadge,
  KpiCard,
  PageHead,
  Panel,
  Sep,
  StatusChip,
  statusVariantFor,
  StoreAvatar,
  storeKeyFor,
  TypeTag,
} from "@/components/kit";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface PlanItem {
  id: string;
  orderNumber: string;
  orderId: string;
  channel: string;
  product: string;
  sku: string;
  qty: number;
  productType: string;
  weight: number | null;
  budgetMax: number | null;
  carrier: string | null;
  service: string | null;
  price: number | null;
  edd: string | null;
  deliveryBy: string | null;
  actualShipDay: string | null;
  notes: string | null;
  status: string;
  trackingNumber: string | null;
  _productId?: number | null;
}

interface PlanData {
  planId: string;
  date: string;
  dispatchDate: string;
  dispatchDateFormatted: string;
  isWeekend: boolean;
  dayName: string;
  orders: PlanItem[];
  total: number;
  readyCount: number;
  stopCount: number;
}

interface BuyResult {
  bought: { orderNumber: string; tracking: string; itemId: string }[];
  errors: { orderNumber: string; error: string; itemId: string }[];
  total: number;
}

const statusIcons: Record<string, React.ReactNode> = {
  pending: <Clock size={14} className="text-yellow-500" />,
  bought: <CheckCircle size={14} className="text-green-500" />,
  error: <XCircle size={14} className="text-red-500" />,
  stop: <AlertTriangle size={14} className="text-red-500" />,
};

const statusLabels: Record<string, string> = {
  pending: "Ready",
  bought: "Bought",
  error: "Error",
  stop: "Needs Review",
};

export default function ShippingPage() {
  const [mounted, setMounted] = useState(false);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(false);
  const [buying, setBuying] = useState(false);
  const [buyProgress, setBuyProgress] = useState("");
  const [buyResult, setBuyResult] = useState<BuyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setMounted(true);
    setToday(
      new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      })
    );
  }, []);

  // Selectable items = pending only
  const selectableIds = useMemo(() => {
    if (!plan) return new Set<string>();
    return new Set(
      plan.orders.filter((o) => o.status === "pending").map((o) => o.id)
    );
  }, [plan]);

  const allSelected =
    selectableIds.size > 0 &&
    [...selectableIds].every((id) => selected.has(id));

  const selectedCount = [...selected].filter((id) =>
    selectableIds.has(id)
  ).length;

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableIds));
    }
  };

  const selectByType = (type: "Frozen" | "Dry") => {
    if (!plan) return;
    const ids = new Set<string>(
      plan.orders
        .filter((o) => o.status === "pending" && o.productType === type)
        .map((o) => o.id)
    );
    setSelected(ids);
  };

  const deselectAll = () => setSelected(new Set());

  // ── Fix modals ──
  const [tagModal, setTagModal] = useState<PlanItem | null>(null);
  const [skuModal, setSkuModal] = useState<PlanItem | null>(null);
  const [fixLoading, setFixLoading] = useState(false);
  const [skuForm, setSkuForm] = useState({
    weight: "",
    length: "",
    width: "",
    height: "",
    weightFedex: "",
  });

  const handleErrorClick = (item: PlanItem) => {
    const notes = item.notes || "";
    if (notes.includes("Missing Frozen/Dry tag")) {
      setTagModal(item);
    } else if (notes.includes("not in SKU Database")) {
      setSkuForm({ weight: "", length: "", width: "", height: "", weightFedex: "" });
      setSkuModal(item);
    }
  };

  const fixTag = async (tag: "Frozen" | "Dry") => {
    if (!tagModal?._productId || !plan) return;
    setFixLoading(true);
    try {
      const res = await fetch("/api/shipping/fix-tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: tagModal._productId, tag }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Failed");
      }
      setTagModal(null);
      await generatePlan();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set tag");
    } finally {
      setFixLoading(false);
    }
  };

  const fixSku = async () => {
    if (!skuModal || !plan) return;
    setFixLoading(true);
    try {
      const res = await fetch("/api/shipping/fix-sku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: skuModal.sku,
          productTitle: skuModal.product,
          marketplace: skuModal.channel,
          category: skuModal.productType !== "Unknown" ? skuModal.productType : "Dry",
          ...skuForm,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed");
      setSkuModal(null);
      if (d.message) setError(d.message); // manual entry warning
      await generatePlan();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save SKU");
    } finally {
      setFixLoading(false);
    }
  };

  const isClickableError = (notes: string | null) => {
    if (!notes) return false;
    return notes.includes("Missing Frozen/Dry tag") || notes.includes("not in SKU Database");
  };

  const generatePlan = async () => {
    setLoading(true);
    setError(null);
    setBuyResult(null);
    try {
      const res = await fetch("/api/shipping/plan");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate plan");
      setPlan(data);
      // Auto-select all pending
      const pendingIds = new Set<string>(
        data.orders
          .filter((o: PlanItem) => o.status === "pending")
          .map((o: PlanItem) => o.id)
      );
      setSelected(pendingIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate plan");
    } finally {
      setLoading(false);
    }
  };

  const buySelectedLabels = async () => {
    if (!plan || selectedCount === 0) return;
    setBuying(true);
    setError(null);
    setBuyResult(null);
    setBuyProgress(`Buying 0/${selectedCount}...`);

    try {
      const itemIds = [...selected].filter((id) => selectableIds.has(id));

      const res = await fetch("/api/shipping/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.planId, itemIds }),
      });
      const data: BuyResult = await res.json();
      if (!res.ok)
        throw new Error(
          (data as unknown as { error: string }).error ||
            "Failed to buy labels"
        );

      setBuyResult(data);
      setBuyProgress("");

      // Update plan items locally
      setPlan((prev) => {
        if (!prev) return prev;
        const updated = prev.orders.map((o) => {
          const bought = data.bought.find((b) => b.itemId === o.id);
          if (bought)
            return {
              ...o,
              status: "bought",
              trackingNumber: bought.tracking,
            };
          const errored = data.errors.find((e) => e.itemId === o.id);
          if (errored)
            return { ...o, status: "error", notes: errored.error };
          return o;
        });
        const readyCount = updated.filter(
          (o) => o.status === "pending"
        ).length;
        const stopCount = updated.filter(
          (o) => o.status === "stop" || o.status === "error"
        ).length;
        return { ...prev, orders: updated, readyCount, stopCount };
      });

      // Clear selection for bought/errored
      setSelected((prev) => {
        const next = new Set(prev);
        for (const b of data.bought) next.delete(b.itemId);
        for (const e of data.errors) next.delete(e.itemId);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to buy labels");
    } finally {
      setBuying(false);
      setBuyProgress("");
    }
  };

  if (!mounted) return null;

  return (
    <div className="space-y-5">
      {/* Page head */}
      <PageHead
        title="Shipping labels"
        subtitle={
          plan ? (
            <>
              <span>{plan.dispatchDateFormatted}</span>
              {plan.isWeekend && (
                <>
                  <Sep />
                  <span className="text-warn">weekend → next biz day</span>
                </>
              )}
              <Sep />
              <span className="tabular">
                {plan.total} orders · {plan.readyCount} ready · {plan.stopCount} need attention
              </span>
            </>
          ) : (
            <span>Today: {today} (ET)</span>
          )
        }
        actions={
          <>
            <Btn
              icon={<RefreshCw size={13} />}
              onClick={generatePlan}
              disabled={loading || buying}
              loading={loading}
            >
              {loading ? "Generating…" : "Generate plan"}
            </Btn>
            <Btn
              variant="primary"
              icon={<ShoppingCart size={13} />}
              onClick={buySelectedLabels}
              disabled={buying || selectedCount === 0}
              loading={buying}
            >
              {buying ? buyProgress : `Buy selected (${selectedCount})`}
            </Btn>
            <Btn variant="ghost" icon={<Download size={13} />} disabled={!plan}>
              Export
            </Btn>
          </>
        }
      />

      {/* KPI row */}
      {plan && (
        <div className="grid gap-3 sm:grid-cols-4">
          <KpiCard label="In plan" value={plan.total} icon={<Package size={14} />} />
          <KpiCard
            label="Ready to buy"
            value={plan.readyCount}
            icon={<ShoppingCart size={14} />}
            iconVariant={plan.readyCount > 0 ? "default" : "warn"}
          />
          <KpiCard
            label="Need attention"
            value={plan.stopCount}
            icon={<AlertTriangle size={14} />}
            iconVariant={plan.stopCount > 0 ? "warn" : "default"}
          />
          <KpiCard
            label="Selected"
            value={selectedCount}
            icon={<CheckCircle size={14} />}
          />
        </div>
      )}

      {/* Buy result summary */}
      {buyResult && (
        <div
          className={`rounded-lg border p-3 text-[13px] ${buyResult.errors.length > 0 ? "border-warn/30 bg-warn-tint text-warn-strong" : "border-green/20 bg-green-soft text-green-ink"}`}
        >
          <p className="font-medium">
            {buyResult.bought.length > 0 && (
              <span>
                ✅ {buyResult.bought.length} bought
              </span>
            )}
            {buyResult.errors.length > 0 && (
              <span className="ml-2">
                ❌ {buyResult.errors.length} errors
              </span>
            )}
          </p>
          {buyResult.errors.length > 0 && (
            <ul className="mt-1 text-xs">
              {buyResult.errors.map((e) => (
                <li key={e.itemId}>
                  {e.orderNumber}: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Plan table */}
      {plan && plan.orders.length > 0 ? (
        <>
          <Panel>
            <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2.5">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                disabled={buying || selectableIds.size === 0}
                className="h-3.5 w-3.5 rounded border-silver-line accent-[var(--green)]"
              />
              <Btn
                size="sm"
                variant={allSelected ? "primary" : "default"}
                onClick={toggleSelectAll}
                disabled={buying || selectableIds.size === 0}
              >
                Select all
              </Btn>
              <Btn
                size="sm"
                variant="default"
                icon={<Snowflake size={12} />}
                onClick={() => selectByType("Frozen")}
                disabled={buying}
              >
                Frozen
              </Btn>
              <Btn
                size="sm"
                variant="default"
                icon={<Package size={12} />}
                onClick={() => selectByType("Dry")}
                disabled={buying}
              >
                Dry
              </Btn>
              <Btn
                size="sm"
                variant="ghost"
                onClick={deselectAll}
                disabled={buying || selectedCount === 0}
              >
                Deselect
              </Btn>
              <div className="flex-1" />
              <span className="text-[11px] font-mono uppercase tracking-wider text-ink-3 tabular">
                {plan.total} orders · {plan.readyCount} ready · {plan.stopCount} attention
              </span>
            </div>

            {/* Grid-based ship table — matches design/shipping_labels_salutem.html */}
            <div className="grid grid-cols-[36px_minmax(160px,1.3fr)_minmax(180px,1.8fr)_90px_90px_140px_minmax(120px,1fr)_120px] border-b border-rule bg-surface-tint px-4 py-2 text-[10px] font-mono uppercase tracking-[0.1em] text-ink-3">
              <div />
              <div>Order / Store</div>
              <div>Product</div>
              <div>Type</div>
              <div>Weight</div>
              <div>Ship to / by</div>
              <div>Service</div>
              <div className="text-right">Status</div>
            </div>

            <div>
              {plan.orders.map((item) => {
                const isSelectable = item.status === "pending";
                const isChecked = selected.has(item.id);
                const isBought = item.status === "bought";
                const needsAttention =
                  item.status === "stop" || item.status === "error";
                const channelIsWalmart = /walmart/i.test(item.channel);

                return (
                  <div
                    key={item.id}
                    className={cn(
                      "grid grid-cols-[36px_minmax(160px,1.3fr)_minmax(180px,1.8fr)_90px_90px_140px_minmax(120px,1fr)_120px] items-start gap-2 border-b border-rule px-4 py-3 text-[12.5px] last:border-0",
                      isBought && "opacity-70",
                      needsAttention && "bg-warn-tint/30",
                      isChecked && !needsAttention && "bg-green-soft/40"
                    )}
                  >
                    <div className="pt-0.5">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(item.id)}
                        disabled={!isSelectable || buying}
                        className="h-3.5 w-3.5 rounded border-silver-line accent-[var(--green)] disabled:opacity-30"
                      />
                    </div>

                    {/* Order / Store */}
                    <div className="min-w-0">
                      <div className="font-mono text-[12px] text-ink">
                        {item.orderNumber}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <StoreAvatar
                          store={
                            channelIsWalmart
                              ? "walmart"
                              : storeKeyFor({ storeName: item.channel })
                          }
                          size="sm"
                        />
                        <span className="truncate text-[11.5px] text-ink-2">
                          {item.channel}
                        </span>
                      </div>
                    </div>

                    {/* Product */}
                    <div className="min-w-0">
                      <div className="truncate text-ink">{item.product}</div>
                      <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
                        {item.sku}
                      </div>
                    </div>

                    {/* Type */}
                    <div>
                      <TypeTag type={item.productType} />
                    </div>

                    {/* Weight */}
                    <div className="tabular text-[12px] text-ink-2">
                      {item.weight != null ? (
                        <>
                          {item.weight}
                          <span className="ml-0.5 text-[10.5px] text-ink-3">lb</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </div>

                    {/* Dest / by */}
                    <div className="min-w-0">
                      <div className="truncate text-[11.5px] text-ink-2">
                        {item.notes?.match(/to \w+/)?.[0] ?? "—"}
                      </div>
                      <div className="mt-0.5 text-[11px] tabular text-ink-3">
                        {item.deliveryBy ? (
                          <>
                            by{" "}
                            <span className="text-ink">{item.deliveryBy}</span>
                          </>
                        ) : item.edd ? (
                          `EDD ${item.edd}`
                        ) : (
                          "—"
                        )}
                      </div>
                    </div>

                    {/* Service */}
                    <div className="min-w-0">
                      {item.carrier ? (
                        <div className="flex items-center gap-1.5">
                          <CarrierBadge carrier={item.carrier} />
                          <span className="truncate text-[11.5px] text-ink-2">
                            {item.service ?? ""}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[11.5px] text-ink-3">—</span>
                      )}
                      {item.price != null && (
                        <div className="mt-0.5 text-[12px] font-semibold tabular text-ink">
                          ${item.price.toFixed(2)}
                        </div>
                      )}
                    </div>

                    {/* Status */}
                    <div className="flex flex-col items-end gap-1">
                      <StatusChip variant={statusVariantFor(item.status)}>
                        {statusLabels[item.status] || item.status}
                      </StatusChip>
                      {item.status === "bought" && item.trackingNumber &&
                        typeof item.trackingNumber === "string" &&
                        !item.trackingNumber.startsWith("[") && (
                          <div className="font-mono text-[10px] text-ink-3">
                            {item.trackingNumber}
                          </div>
                        )}
                      {item.notes && (
                        <div
                          className={cn(
                            "text-right text-[10.5px] leading-tight",
                            needsAttention ? "text-warn-strong" : "text-ink-3",
                            isClickableError(item.notes) &&
                              "cursor-pointer underline hover:text-danger"
                          )}
                          onClick={() =>
                            isClickableError(item.notes) && handleErrorClick(item)
                          }
                        >
                          {item.notes}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* Sticky action bar — appears when something is selected */}
          {selectedCount > 0 && (
            <div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-rule bg-surface/95 px-4 py-3 backdrop-blur-md">
              <div className="leading-tight">
                <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ink-3">
                  Selected to buy
                </div>
                <div className="text-[14px] font-semibold text-ink">
                  <span className="kpi-number" style={{ fontSize: 20 }}>
                    {selectedCount}
                  </span>
                  <span className="ml-1 text-ink-3 font-normal tabular">
                    of {plan.readyCount} ready labels
                  </span>
                </div>
              </div>
              <div className="flex-1" />
              <Btn
                variant="ghost"
                onClick={deselectAll}
                disabled={buying}
              >
                Clear selection
              </Btn>
              <Btn
                variant="primary"
                icon={<ShoppingCart size={13} />}
                onClick={buySelectedLabels}
                disabled={buying}
                loading={buying}
              >
                {buying ? buyProgress : "Buy selected"}
              </Btn>
              <div className="hidden items-center gap-1.5 text-[11px] text-ink-3 sm:flex">
                <span className="kbd">B</span>
                <span>to buy</span>
              </div>
            </div>
          )}
        </>
      ) : plan ? (
        <Panel>
          <div className="py-8 text-center text-[13px] text-ink-3">
            No orders found for today
          </div>
        </Panel>
      ) : (
        <Panel>
          <div className="py-8 text-center text-[13px] text-ink-3">
            Click <strong className="text-ink">Generate plan</strong> to fetch today&apos;s orders
          </div>
        </Panel>
      )}

      {/* ── Tag Fix Modal ── */}
      <Dialog open={!!tagModal} onOpenChange={(open) => !open && setTagModal(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set Product Type</DialogTitle>
            <DialogDescription>
              This product has no Frozen/Dry tag in Veeqo. Select the correct type.
            </DialogDescription>
          </DialogHeader>
          {tagModal && (
            <div className="space-y-3 text-sm">
              <div>
                <Label className="text-slate-500">Product</Label>
                <p className="font-medium">{tagModal.product}</p>
              </div>
              <div>
                <Label className="text-slate-500">SKU</Label>
                <p className="font-mono text-xs">{tagModal.sku}</p>
              </div>
              <div>
                <Label className="text-slate-500">Order</Label>
                <p className="font-mono text-xs">{tagModal.orderNumber}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={() => fixTag("Frozen")}
              disabled={fixLoading}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {fixLoading ? <Loader2 className="mr-1 animate-spin" size={14} /> : <Snowflake size={14} className="mr-1" />}
              Set Frozen
            </Button>
            <Button
              onClick={() => fixTag("Dry")}
              disabled={fixLoading}
              variant="outline"
            >
              {fixLoading ? <Loader2 className="mr-1 animate-spin" size={14} /> : <Package size={14} className="mr-1" />}
              Set Dry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── SKU Fix Modal ── */}
      <Dialog open={!!skuModal} onOpenChange={(open) => !open && setSkuModal(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add SKU to Database</DialogTitle>
            <DialogDescription>
              This SKU is missing from SKU Database v2. Enter weight and dimensions.
            </DialogDescription>
          </DialogHeader>
          {skuModal && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <Label className="text-slate-500">SKU</Label>
                  <Input value={skuModal.sku} disabled className="font-mono" />
                </div>
                <div>
                  <Label className="text-slate-500">Product</Label>
                  <Input value={skuModal.product} disabled className="text-xs" />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <Label>Weight (lbs)</Label>
                  <Input
                    type="number"
                    step="0.1"
                    placeholder="0.0"
                    value={skuForm.weight}
                    onChange={(e) => setSkuForm((f) => ({ ...f, weight: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Length (in)</Label>
                  <Input
                    type="number"
                    step="0.1"
                    placeholder="0"
                    value={skuForm.length}
                    onChange={(e) => setSkuForm((f) => ({ ...f, length: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Width (in)</Label>
                  <Input
                    type="number"
                    step="0.1"
                    placeholder="0"
                    value={skuForm.width}
                    onChange={(e) => setSkuForm((f) => ({ ...f, width: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Height (in)</Label>
                  <Input
                    type="number"
                    step="0.1"
                    placeholder="0"
                    value={skuForm.height}
                    onChange={(e) => setSkuForm((f) => ({ ...f, height: e.target.value }))}
                  />
                </div>
              </div>
              <div className="w-1/2">
                <Label>FedEx One Rate Weight (lbs)</Label>
                <Input
                  type="number"
                  step="0.1"
                  placeholder="auto: weight x 1.25"
                  value={skuForm.weightFedex}
                  onChange={(e) => setSkuForm((f) => ({ ...f, weightFedex: e.target.value }))}
                />
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Leave empty to auto-calculate (weight x 1.25)
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={fixSku}
              disabled={fixLoading || !skuForm.weight || !skuForm.length || !skuForm.width || !skuForm.height}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {fixLoading && <Loader2 className="mr-1 animate-spin" size={14} />}
              Save to SKU Database
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
