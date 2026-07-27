"use client";

import { useEffect, useState } from "react";
import { Loader2, Scale, Plus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import DefenseStrategyBadge from "@/components/claims/DefenseStrategyBadge";
import AtozDetail from "./AtozDetail";

interface Claim {
  id: string;
  amazonOrderId: string;
  claimType: string;
  claimReason: string | null;
  amount: number | null;
  deadline: string | null;
  strategyType: string | null;
  strategyConfidence: string | null;
  status: string;
  amazonDecision: string | null;
  amountCharged: number | null;
  amountSaved: number | null;
  appealSubmitted: boolean;
  carrier: string | null;
  shipDate: string | null;
  storeName: string | null;
  storeIndex: number;
}

function statusLabel(
  status: string,
  decision: string | null
): { text: string; color: string } {
  if (status === "DECIDED" || status === "CLOSED") {
    if (decision === "AMAZON_FUNDED")
      return { text: "Amazon Funded", color: "bg-green-soft2 text-green-ink" };
    if (decision === "IN_OUR_FAVOR")
      return { text: "Won", color: "bg-green-soft2 text-green-ink" };
    if (decision === "AGAINST_US")
      return { text: "We Lost", color: "bg-danger-tint text-danger" };
    return { text: "Decided", color: "bg-bg-elev text-ink" };
  }
  const map: Record<string, { text: string; color: string }> = {
    NEW: { text: "Needs Response", color: "bg-danger-tint text-danger" },
    EVIDENCE_GATHERED: {
      text: "Evidence Ready",
      color: "bg-warn-tint text-warn-strong",
    },
    RESPONSE_READY: {
      text: "Response Ready",
      color: "bg-green-soft2 text-green-deep",
    },
    SUBMITTED: { text: "Submitted", color: "bg-green-soft2 text-green-ink" },
    APPEALED: { text: "Appealed", color: "bg-purple-tint text-purple" },
  };
  return map[status] || { text: status, color: "bg-bg-elev text-ink-3" };
}

// Compute days until deadline from a YYYY-MM-DD string on the client.
function daysUntil(deadline: string | null): number | null {
  if (!deadline) return null;
  const [y, m, d] = deadline.split("-").map((v) => parseInt(v, 10));
  if (!y || !m || !d) return null;
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

export default function AtozTab({
  claimType = "A_TO_Z",
  period: parentPeriod,
  store: parentStore,
}: {
  claimType?: "A_TO_Z" | "CHARGEBACK";
  period?: number;
  store?: string;
}) {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [period, setPeriod] = useState(parentPeriod || 30);

  // Sync local period with parent when parent changes
  const effectivePeriod = parentPeriod || period;
  const effectiveStore = parentStore || "all";

  const label = claimType === "CHARGEBACK" ? "Chargeback" : "A-to-Z Claim";

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/customer-hub/atoz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync",
          type: claimType,
          period,
        }),
      });
      const data = await res.json();
      setSyncMessage(
        data.synced > 0
          ? `Synced ${data.synced} new ${label.toLowerCase()}${data.synced !== 1 ? "s" : ""}`
          : `No new ${label.toLowerCase()}s found`
      );
      fetchClaims();
    } catch {
      setSyncMessage("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const fetchClaims = () => {
    setLoading(true);
    const params = new URLSearchParams({
      type: claimType,
      limit: "50",
      period: String(effectivePeriod),
    });
    if (effectiveStore !== "all") params.set("store", effectiveStore);
    fetch(`/api/customer-hub/atoz?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setClaims(data.claims || []);
        setTotal(data.total || 0);
      })
      .catch(() => {
        setClaims([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchClaims();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimType, effectivePeriod, effectiveStore]);

  const handleAddClaim = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAddSaving(true);
    setAddError(null);
    const fd = new FormData(e.currentTarget);
    const orderId = (fd.get("orderId") as string) || "";
    if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId)) {
      setAddError("Order ID must be in format 123-1234567-1234567");
      setAddSaving(false);
      return;
    }
    try {
      const res = await fetch("/api/customer-hub/atoz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          data: {
            amazonOrderId: orderId,
            claimType,
            storeIndex: parseInt(fd.get("storeIndex") as string) || 1,
            claimReason: fd.get("reason") || "OTHER",
            amount: parseFloat(fd.get("amount") as string) || 0,
            deadline: fd.get("deadline") || null,
            vladimirNotes: fd.get("notes") || null,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAddOpen(false);
      fetchClaims();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed");
    } finally {
      setAddSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-ink-3 mr-2" />
          <span className="text-sm text-ink-3">Loading claims…</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-rule">
            <span className="text-xs text-ink-3">
              {total} {label.toLowerCase()}{total !== 1 ? "s" : ""}
              {syncMessage && (
                <span className="ml-2 text-[10px] text-ink-3">
                  {syncMessage}
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              <select
                value={period}
                onChange={(e) => setPeriod(parseInt(e.target.value))}
                className="rounded border px-2 py-1 text-xs"
              >
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 size={12} className="animate-spin mr-1" />
                ) : (
                  <RefreshCw size={12} className="mr-1" />
                )}
                Sync
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setAddOpen(true); setAddError(null); }}
              >
                <Plus size={12} className="mr-1" /> Add
              </Button>
            </div>
          </div>

          {/* Add claim/chargeback modal */}
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Add {label}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleAddClaim} className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-ink-3">Order ID *</label>
                  <Input name="orderId" placeholder="123-1234567-1234567" required />
                </div>
                <div>
                  <label className="text-xs font-medium text-ink-3">Store</label>
                  <select name="storeIndex" className="w-full rounded border px-3 py-2 text-sm">
                    <option value="1">Salutem Solutions</option>
                    <option value="2">Vladimir Personal</option>
                    <option value="3">AMZ Commerce</option>
                    <option value="4">Sirius International</option>
                    <option value="5">Retailer Distributor</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-ink-3">Reason</label>
                  <select name="reason" className="w-full rounded border px-3 py-2 text-sm">
                    <option value="INR">Item Not Received (INR)</option>
                    <option value="SNAD">Significantly Not As Described (SNAD)</option>
                    <option value="NOT_AS_DESCRIBED">Not As Described</option>
                    <option value="SERVICE_ISSUE">Service Issue</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium text-ink-3">Amount ($) *</label>
                    <Input name="amount" type="number" step="0.01" required />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-ink-3">Deadline</label>
                    <Input name="deadline" type="date" />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-ink-3">Notes</label>
                  <Textarea name="notes" rows={2} placeholder="Optional internal notes" />
                </div>
                {addError && (
                  <p className="text-xs text-danger">{addError}</p>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAddOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={addSaving}>
                    {addSaving ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
                    Create
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>

          {/* Summary cards */}
          {claims.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 px-4 py-3 border-b border-rule text-xs">
              <div className="rounded bg-surface-tint p-2 text-center">
                <div className="text-lg font-bold text-ink">{total}</div>
                <div className="text-ink-3">Total</div>
              </div>
              <div className="rounded bg-warn-tint p-2 text-center">
                <div className="text-lg font-bold text-warn-strong">
                  {claims.filter((c) => !c.amazonDecision && c.status !== "CLOSED").length}
                </div>
                <div className="text-warn">Pending</div>
              </div>
              <div className="rounded bg-green-soft p-2 text-center">
                <div className="text-lg font-bold text-green-ink">
                  {claims.filter((c) => c.amazonDecision === "AMAZON_FUNDED" || c.amazonDecision === "IN_OUR_FAVOR").length}
                </div>
                <div className="text-green">Won / Amazon Funded</div>
              </div>
              <div className="rounded bg-danger-tint p-2 text-center">
                <div className="text-lg font-bold text-danger">
                  {claims.filter((c) => c.amazonDecision === "AGAINST_US").length}
                </div>
                <div className="text-danger">We Lost</div>
              </div>
              <div className="rounded bg-surface-tint p-2 text-center">
                <div className="text-lg font-bold text-green-ink">
                  ${claims.reduce((sum, c) => sum + (c.amountSaved || 0), 0).toFixed(0)}
                </div>
                <div className="text-ink-3">
                  Saved / <span className="text-danger">${claims.reduce((sum, c) => sum + (c.amountCharged || 0), 0).toFixed(0)} Lost</span>
                </div>
              </div>
            </div>
          )}

          {claims.length === 0 ? (
            <div className="py-12 text-center">
              <Scale size={32} className="mx-auto text-ink-4 mb-3" />
              <p className="text-sm font-medium text-ink-2">
                No {label.toLowerCase()}s
              </p>
              <p className="text-xs text-ink-3 mt-1">
                Press Sync to load from Gmail notifications.
              </p>
            </div>
          ) : (
            <>
              {/* DESKTOP table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Store</TableHead>
                      <TableHead>Order ID</TableHead>
                      <TableHead>Carrier</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Deadline</TableHead>
                      <TableHead>Who Paid</TableHead>
                      <TableHead>Strategy</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {claims.map((c) => {
                      const days = daysUntil(c.deadline);
                      const urgent = days !== null && days <= 2;
                      const sl = statusLabel(c.status, c.amazonDecision);
                      const isLoss = c.amazonDecision === "AGAINST_US";
                      const isWon =
                        c.amazonDecision === "AMAZON_FUNDED" ||
                        c.amazonDecision === "IN_OUR_FAVOR";
                      return (
                        <TableRow
                          key={c.id}
                          className={`cursor-pointer hover:bg-surface-tint ${
                            selectedId === c.id ? "bg-green-soft" : ""
                          } ${urgent ? "bg-danger-tint/40" : ""} ${
                            isLoss ? "bg-danger-tint/30" : ""
                          }`}
                          onClick={() =>
                            setSelectedId(selectedId === c.id ? null : c.id)
                          }
                        >
                          <TableCell>
                            <Badge className={sl.color}>{sl.text}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-ink-2 max-w-[100px] truncate">
                            {c.storeName || `Store ${c.storeIndex}`}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {c.amazonOrderId}
                          </TableCell>
                          <TableCell className="text-xs">
                            {c.carrier || "—"}
                          </TableCell>
                          <TableCell
                            className={`text-right text-xs font-medium ${
                              isLoss
                                ? "text-danger"
                                : isWon
                                  ? "text-green"
                                  : ""
                            }`}
                          >
                            {c.amount != null ? `$${c.amount.toFixed(2)}` : "—"}
                          </TableCell>
                          <TableCell className="text-xs">
                            {c.deadline || "—"}
                            {days !== null && days <= 3 && (
                              <Badge className="ml-1 bg-danger-tint text-danger text-[9px]">
                                {days}d left
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {isWon ? (
                              <span className="text-green font-medium">
                                Amazon
                              </span>
                            ) : isLoss ? (
                              <span className="text-danger font-medium">
                                Us {!c.appealSubmitted && "(Appeal?)"}
                              </span>
                            ) : (
                              <span className="text-ink-3">Pending</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <DefenseStrategyBadge
                              strategyType={c.strategyType}
                              confidence={c.strategyConfidence}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* MOBILE cards */}
              <div className="md:hidden divide-y divide-rule">
                {claims.map((c) => {
                  const days = daysUntil(c.deadline);
                  const urgent = days !== null && days <= 2;
                  const sl = statusLabel(c.status, c.amazonDecision);
                  const isLoss = c.amazonDecision === "AGAINST_US";
                  const isWon =
                    c.amazonDecision === "AMAZON_FUNDED" ||
                    c.amazonDecision === "IN_OUR_FAVOR";
                  return (
                    <button
                      key={c.id}
                      onClick={() =>
                        setSelectedId(selectedId === c.id ? null : c.id)
                      }
                      className={`w-full text-left px-4 py-3 transition-colors hover:bg-surface-tint active:bg-bg-elev ${
                        selectedId === c.id ? "bg-green-soft" : ""
                      } ${urgent && selectedId !== c.id ? "bg-danger-tint/40" : ""} ${
                        isLoss && selectedId !== c.id ? "bg-danger-tint/30" : ""
                      }`}
                    >
                      {/* HEAD: order ID + amount */}
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <span className="font-mono text-[13px] text-ink truncate">
                          {c.amazonOrderId}
                        </span>
                        <span
                          className={`shrink-0 text-[13px] font-semibold tabular ${
                            isLoss
                              ? "text-danger"
                              : isWon
                                ? "text-green"
                                : "text-ink"
                          }`}
                        >
                          {c.amount != null ? `$${c.amount.toFixed(2)}` : "—"}
                        </span>
                      </div>

                      {/* SUB: store · carrier · strategy */}
                      <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-[11.5px] text-ink-3 mb-2">
                        <span className="truncate">
                          {c.storeName || `Store ${c.storeIndex}`}
                        </span>
                        {c.carrier && (
                          <>
                            <span className="text-ink-4">·</span>
                            <span>{c.carrier}</span>
                          </>
                        )}
                        <DefenseStrategyBadge
                          strategyType={c.strategyType}
                          confidence={c.strategyConfidence}
                        />
                      </div>

                      {/* ACTION row: status badge + deadline */}
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <Badge className={`${sl.color} text-[10px]`}>
                          {sl.text}
                        </Badge>
                        <div className="text-[10.5px] tabular text-ink-3 flex items-center gap-1">
                          {c.deadline || "—"}
                          {days !== null && days <= 3 && (
                            <Badge className="bg-danger-tint text-danger text-[9px]">
                              {days}d
                            </Badge>
                          )}
                        </div>
                      </div>

                      {/* FOOTER: who paid */}
                      <div className="text-[10.5px] text-ink-3">
                        {isWon ? (
                          <span className="text-green font-medium">
                            Amazon paid
                          </span>
                        ) : isLoss ? (
                          <span className="text-danger font-medium">
                            We paid {!c.appealSubmitted && "(Appeal?)"}
                          </span>
                        ) : (
                          <span>Pending</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selectedId && (
        <div className="mt-4">
          <AtozDetail
            key={selectedId}
            claimId={selectedId}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </>
  );
}
