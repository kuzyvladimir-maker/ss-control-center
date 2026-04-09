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
    <div className="space-y-6">
      {/* Status bar */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">Today: {today} (ET)</p>
              {plan && (
                <>
                  <p className="text-sm mt-1">
                    <span className="text-slate-500">
                      Showing orders for:{" "}
                    </span>
                    <span className="font-medium">
                      {plan.dispatchDateFormatted}
                    </span>
                    {plan.isWeekend && (
                      <span className="ml-2 text-xs text-amber-600">
                        (weekend — showing next business day)
                      </span>
                    )}
                  </p>
                  <p className="text-sm mt-0.5">
                    Status:{" "}
                    <span className="font-medium">
                      {plan.total} orders / {plan.readyCount} ready /{" "}
                      {plan.stopCount} need attention
                    </span>
                    {selectedCount > 0 && (
                      <span className="ml-2 text-blue-600">
                        ({selectedCount} selected)
                      </span>
                    )}
                  </p>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                onClick={generatePlan}
                disabled={loading || buying}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {loading ? (
                  <Loader2 className="mr-2 animate-spin" size={16} />
                ) : (
                  <RefreshCw className="mr-2" size={16} />
                )}
                Generate Plan
              </Button>
              <Button
                onClick={buySelectedLabels}
                disabled={buying || selectedCount === 0}
                variant="default"
                className="bg-green-600 hover:bg-green-700"
              >
                {buying ? (
                  <Loader2 className="mr-2 animate-spin" size={16} />
                ) : (
                  <ShoppingCart className="mr-2" size={16} />
                )}
                {buying
                  ? buyProgress
                  : `Buy Selected (${selectedCount})`}
              </Button>
              <Button variant="outline" disabled={!plan}>
                <Download className="mr-2" size={16} />
                Export
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Buy result summary */}
      {buyResult && (
        <div
          className={`rounded-md p-3 text-sm ${buyResult.errors.length > 0 ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-800"}`}
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
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">
              Shipping Plan — {plan.date}
            </CardTitle>
            <div className="flex items-center gap-1">
              <Button
                variant={allSelected ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={toggleSelectAll}
                disabled={buying || selectableIds.size === 0}
              >
                Select All
              </Button>
              <Button
                variant={
                  selectedCount > 0 &&
                  [...selected].every((id) => {
                    const o = plan.orders.find((x) => x.id === id);
                    return o?.productType === "Frozen";
                  }) &&
                  plan.orders.filter(
                    (o) =>
                      o.status === "pending" && o.productType === "Frozen"
                  ).length === selectedCount
                    ? "default"
                    : "outline"
                }
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={() => selectByType("Frozen")}
                disabled={buying}
              >
                <Snowflake size={12} className="mr-1" />
                Frozen
              </Button>
              <Button
                variant={
                  selectedCount > 0 &&
                  [...selected].every((id) => {
                    const o = plan.orders.find((x) => x.id === id);
                    return o?.productType === "Dry";
                  }) &&
                  plan.orders.filter(
                    (o) =>
                      o.status === "pending" && o.productType === "Dry"
                  ).length === selectedCount
                    ? "default"
                    : "outline"
                }
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={() => selectByType("Dry")}
                disabled={buying}
              >
                <Package size={12} className="mr-1" />
                Dry
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={deselectAll}
                disabled={buying || selectedCount === 0}
              >
                Deselect
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px]">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      disabled={buying || selectableIds.size === 0}
                      className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                    />
                  </TableHead>
                  <TableHead className="w-[40px]">#</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead>EDD</TableHead>
                  <TableHead>Delivery By</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.orders.map((item, idx) => {
                  const isSelectable = item.status === "pending";
                  const isChecked = selected.has(item.id);

                  return (
                    <TableRow
                      key={item.id}
                      className={
                        item.status === "stop" || item.status === "error"
                          ? "bg-red-50"
                          : item.status === "bought"
                            ? "bg-green-50"
                            : isChecked
                              ? "bg-blue-50/50"
                              : ""
                      }
                    >
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelect(item.id)}
                          disabled={!isSelectable || buying}
                          className="h-4 w-4 rounded border-slate-300 accent-blue-600 disabled:opacity-30"
                        />
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {idx + 1}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {item.orderNumber}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.channel}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-xs">
                        {item.product}
                      </TableCell>
                      <TableCell>
                        {item.productType === "Frozen" ? (
                          <Badge
                            variant="outline"
                            className="border-blue-300 text-blue-600"
                          >
                            <Snowflake size={12} className="mr-1" />
                            Frozen
                          </Badge>
                        ) : (
                          <Badge variant="outline">
                            <Package size={12} className="mr-1" />
                            Dry
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.carrier || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.service || "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {item.price != null
                          ? `$${item.price.toFixed(2)}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.edd || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.deliveryBy || "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {statusIcons[item.status]}
                          <span className="text-xs">
                            {statusLabels[item.status] || item.status}
                          </span>
                        </div>
                        {item.notes && (
                          <p
                            className={`text-[10px] text-red-500 mt-0.5 ${isClickableError(item.notes) ? "underline cursor-pointer hover:text-red-700" : ""}`}
                            onClick={() => isClickableError(item.notes) && handleErrorClick(item)}
                          >
                            {item.notes}
                          </p>
                        )}
                        {item.status === "bought" && (
                          <p className="text-[10px] text-green-600 mt-0.5">
                            {item.carrier} {item.service} ${item.price?.toFixed(2)}
                            {item.trackingNumber &&
                              typeof item.trackingNumber === "string" &&
                              !item.trackingNumber.startsWith("[") &&
                              ` | ${item.trackingNumber}`}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : plan ? (
        <Card>
          <CardContent className="py-8 text-center text-slate-400">
            No orders found for today
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-slate-400">
            Click &quot;Generate Plan&quot; to fetch today&apos;s orders
          </CardContent>
        </Card>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-slate-500">
        <span>Legend:</span>
        <span className="flex items-center gap-1">
          <Snowflake size={12} className="text-blue-500" /> Frozen
        </span>
        <span className="flex items-center gap-1">
          <Package size={12} /> Dry
        </span>
        <span className="flex items-center gap-1">
          <CheckCircle size={12} className="text-green-500" /> Bought
        </span>
        <span className="flex items-center gap-1">
          <XCircle size={12} className="text-red-500" /> Needs Review
        </span>
      </div>

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
