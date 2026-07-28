"use client";

import { Fragment, useState } from "react";
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
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  ExternalLink,
} from "lucide-react";

interface Adjustment {
  id: string;
  channel: string;
  // Which seller account the charge landed on — "store1".."store5" for
  // Amazon, "walmart-store1" for Walmart. Always populated by every sync
  // path (scan / settlement / walmart), so this is the one piece of
  // attribution we have on 100% of rows even when order/SKU are still
  // pending. Mapped to a human account name via accountName().
  storeId: string | null;
  // Nullable: Amazon PostageBilling_PostageAdjustment events (the common
  // carrier reweigh recharge) have no per-order attribution — see the
  // ShippingAdjustment model in prisma/schema.prisma. Must be guarded
  // before calling string methods, or the table crashes the whole page.
  orderId: string | null;
  adjustmentDate: string;
  adjustmentType: string;
  adjustmentAmount: number;
  adjustmentReason: string | null;
  sku: string | null;
  productName: string | null;
  productImageUrl: string | null;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  declaredWeightLbs: number | null;
  adjustedWeightLbs: number | null;
  declaredDimL: number | null;
  declaredDimW: number | null;
  declaredDimH: number | null;
  originalLabelCost: number | null;
  reviewed: boolean;
  notes: string | null;
  disputeCaseId: string | null;
  disputedAt: string | null;
}

/** Deep link to a specific Amazon support case dashboard. */
function caseDashboardUrl(caseId: string): string {
  return `https://sellercentral.amazon.com/cu/case-dashboard/view-case?caseID=${caseId}`;
}

const typeLabels: Record<string, string> = {
  WeightAdjustment: "Weight charge",
  WeightAdjustmentRefund: "Refund",
  ReturnShipping: "Return shipping",
  DIMadjustment: "DIM",
  CarrierAdjustment: "Carrier",
};

/** Plain-English explanation of what each charge type actually is. */
const typeDescriptions: Record<string, string> = {
  WeightAdjustment:
    "The carrier re-weighed or re-measured this package after pickup and Amazon re-charged the difference on the Buy Shipping label.",
  WeightAdjustmentRefund:
    "Amazon refunded part of an earlier shipping charge — the carrier's correction came back in your favour.",
  ReturnShipping:
    "Carrier charge for the label used to ship a customer return back to us.",
  CarrierAdjustment:
    "A carrier correction applied to the shipping label cost.",
};

/**
 * Map the internal seller-account id to the human account name shown in
 * the UI. Source of truth is CLAUDE.md (store1..5 → account). Walmart is a
 * single account, so we let the channel column speak for it and return null
 * here (no per-store breakdown to show).
 */
const ACCOUNT_NAMES: Record<string, string> = {
  store1: "Salutem Solutions",
  store2: "Vladimir Personal",
  store3: "AMZ Commerce",
  store4: "Sirius International",
  store5: "Retailer Distributor",
};

function accountName(storeId: string | null): string | null {
  if (!storeId) return null;
  if (storeId.startsWith("walmart")) return null;
  return ACCOUNT_NAMES[storeId] ?? null;
}

/**
 * A row is "pending details" when it's an Amazon charge that arrived via
 * the real-time Financial Events feed (date + amount only) and hasn't yet
 * been matched to its order. Amazon supplies order-id / SKU / product /
 * carrier later, via the weekly settlement report — these rows fill in
 * automatically on the next sync. Flagging them stops the empty cells from
 * looking like a bug.
 */
function isPendingDetails(a: Adjustment): boolean {
  return a.channel === "Amazon" && !a.orderId && !a.sku && !a.carrier;
}

/** Refund types — display as a positive (green) inflow, not red loss. */
function isRefund(a: { adjustmentAmount: number; adjustmentType: string }): boolean {
  if (a.adjustmentAmount > 0) return true;
  return /refund/i.test(a.adjustmentType);
}

/** Build a tracking URL from carrier + tracking number. */
function trackingUrl(carrier: string | null, tracking: string | null): string | null {
  if (!tracking) return null;
  const c = (carrier || "").toUpperCase();
  if (c === "UPS") return `https://www.ups.com/track?tracknum=${tracking}`;
  if (c === "FEDEX") return `https://www.fedex.com/fedextrack/?trknbr=${tracking}`;
  if (c === "USPS") return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking}`;
  if (c === "DHL") return `https://www.dhl.com/en/express/tracking.html?AWB=${tracking}`;
  return null;
}

/**
 * Compose the text body Vladimir pastes into Amazon's Buy Shipping
 * adjustment dispute form (Seller Central → Help → Buy Shipping →
 * "I have a question about a Buy Shipping label charge or adjustment").
 *
 * Includes all the evidence Amazon support needs to evaluate the
 * dispute: declared weight/dims (proves we measured correctly), original
 * label cost, carrier + tracking, and the percentage overcharge so the
 * agent can immediately see how extreme the adjustment is.
 */
function buildDisputeText(adj: Adjustment): string {
  const overcharge = Math.abs(adj.adjustmentAmount);
  const net =
    adj.originalLabelCost != null
      ? Math.max(0, adj.originalLabelCost - adj.adjustmentAmount)
      : null;
  const pctText =
    adj.originalLabelCost && adj.originalLabelCost > 0
      ? ` (${Math.round((overcharge / adj.originalLabelCost) * 100)}% above original)`
      : "";

  const lines: Array<string | null> = [
    "Subject: Buy Shipping adjustment dispute",
    "",
    "Hello Amazon Buy Shipping team,",
    "",
    `We are disputing a shipping adjustment posted on ${adj.adjustmentDate} for the following order.`,
    "",
    `Order ID:        ${adj.orderId ?? "—"}`,
    adj.trackingNumber
      ? `Tracking #:      ${adj.trackingNumber}${adj.carrier ? ` (${adj.carrier})` : ""}`
      : adj.carrier
        ? `Carrier:         ${adj.carrier}`
        : null,
    adj.service ? `Service:         ${adj.service}` : null,
    adj.productName ? `Product:         ${adj.productName}` : null,
    adj.sku ? `SKU:             ${adj.sku}` : null,
    "",
    "Package declared at purchase:",
    adj.declaredWeightLbs != null
      ? `  Weight:        ${adj.declaredWeightLbs.toFixed(2)} lbs`
      : "  Weight:        (not recorded on our side)",
    adj.declaredDimL != null
      ? `  Dimensions:    ${adj.declaredDimL} × ${adj.declaredDimW} × ${adj.declaredDimH} inches`
      : "  Dimensions:    (not recorded on our side)",
    "",
    "Cost breakdown:",
    adj.originalLabelCost != null
      ? `  Original label cost: $${adj.originalLabelCost.toFixed(2)}`
      : null,
    `  Adjustment charge:   -$${overcharge.toFixed(2)}${pctText}`,
    net != null ? `  Net we paid:         $${net.toFixed(2)}` : null,
    "",
    "Our package was correctly weighed and measured on a calibrated scale before purchasing the Buy Shipping label, and the declared values match what we shipped. The adjustment significantly exceeds typical carrier reweigh corrections (which are normally $0.50–$3.00 for accurate declarations).",
    "",
    "Please review the carrier reweigh data for this shipment and, if our declaration matches the carrier-measured values, refund the over-charge.",
    "",
    "Thank you.",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

const BUY_SHIPPING_SUPPORT_URL =
  "https://sellercentral.amazon.com/cu/contact-us";

interface AdjustmentFilters {
  channel: string;
  days: string;
  sku: string;
  carrier?: string;
}

interface AdjustmentsTableProps {
  adjustments: Adjustment[];
  total: number;
  filters: AdjustmentFilters;
  onFiltersChange: (f: AdjustmentFilters) => void;
}

export default function AdjustmentsTable({
  adjustments: adjustmentsProp,
  total,
  filters,
  onFiltersChange,
}: AdjustmentsTableProps) {
  // Local copy so "Mark as disputed" updates render immediately without
  // waiting for a parent re-fetch.
  const [adjustments, setAdjustments] = useState(adjustmentsProp);
  if (adjustments !== adjustmentsProp && adjustments.length === 0) {
    setAdjustments(adjustmentsProp);
  }
  // Sync when parent's array reference changes (filter / refresh).
  if (
    adjustmentsProp.length !== adjustments.length ||
    (adjustmentsProp[0]?.id !== adjustments[0]?.id)
  ) {
    setAdjustments(adjustmentsProp);
  }
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [disputeInputFor, setDisputeInputFor] = useState<string | null>(null);
  const [disputeCaseInput, setDisputeCaseInput] = useState("");
  const [savingDispute, setSavingDispute] = useState(false);

  async function copyDispute(adj: Adjustment) {
    const text = buildDisputeText(adj);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(adj.id);
      setTimeout(() => {
        setCopiedId((c) => (c === adj.id ? null : c));
      }, 2000);
    } catch (err) {
      console.error("Clipboard write failed:", err);
      // Fallback — open a textarea so user can copy manually
      window.prompt("Copy dispute text:", text);
    }
  }

  async function saveDispute(adj: Adjustment) {
    const caseId = disputeCaseInput.trim();
    if (!caseId) return;
    setSavingDispute(true);
    try {
      const res = await fetch(`/api/adjustments/${adj.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disputeCaseId: caseId }),
      });
      if (!res.ok) throw new Error(`PATCH failed (${res.status})`);
      const updated = await res.json();
      setAdjustments((rows) =>
        rows.map((r) => (r.id === adj.id ? { ...r, ...updated } : r)),
      );
      setDisputeInputFor(null);
      setDisputeCaseInput("");
    } catch (err) {
      console.error("Save dispute failed:", err);
      alert("Failed to save dispute Case ID. Try again or refresh.");
    } finally {
      setSavingDispute(false);
    }
  }

  async function clearDispute(adj: Adjustment) {
    if (!confirm("Remove the dispute Case ID from this row?")) return;
    setSavingDispute(true);
    try {
      const res = await fetch(`/api/adjustments/${adj.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disputeCaseId: null }),
      });
      if (!res.ok) throw new Error(`PATCH failed (${res.status})`);
      const updated = await res.json();
      setAdjustments((rows) =>
        rows.map((r) => (r.id === adj.id ? { ...r, ...updated } : r)),
      );
    } catch (err) {
      console.error("Clear dispute failed:", err);
    } finally {
      setSavingDispute(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filters.channel}
          onChange={(e) =>
            onFiltersChange({ ...filters, channel: e.target.value })
          }
          className="rounded-md border border-rule bg-surface px-3 py-1.5 text-sm"
        >
          <option value="">All Channels</option>
          <option value="Amazon">Amazon</option>
          <option value="Walmart">Walmart</option>
        </select>
        <select
          value={filters.days}
          onChange={(e) =>
            onFiltersChange({ ...filters, days: e.target.value })
          }
          className="rounded-md border border-rule bg-surface px-3 py-1.5 text-sm"
        >
          <option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option>
          <option value="60">Last 60 days</option>
          <option value="90">Last 90 days</option>
        </select>
        <span className="text-xs text-ink-3 ml-auto">
          {total} adjustment{total !== 1 ? "s" : ""}
        </span>
      </div>

      {adjustments.length === 0 ? (
        <p className="text-sm text-ink-3 py-4 text-center">
          No adjustments found
        </p>
      ) : (
        <>
        <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Order ID</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adjustments.map((adj) => {
              const expanded = expandedId === adj.id;
              return (
                <Fragment key={adj.id}>
                  <TableRow
                    className="cursor-pointer hover:bg-surface-tint"
                    onClick={() => setExpandedId(expanded ? null : adj.id)}
                  >
                    <TableCell className="px-2">
                      {expanded ? (
                        <ChevronDown size={14} className="text-ink-3" />
                      ) : (
                        <ChevronRight size={14} className="text-ink-3" />
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-ink-3">
                      {adj.adjustmentDate}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium text-ink leading-tight">
                        {accountName(adj.storeId) ?? adj.channel}
                      </div>
                      <div className="text-[10.5px] text-ink-3">
                        {adj.channel}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {adj.orderId ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {adj.sku || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {typeLabels[adj.adjustmentType] || adj.adjustmentType}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className={`text-right text-xs font-medium tabular ${
                        isRefund(adj) ? "text-success" : "text-danger"
                      }`}
                    >
                      {isRefund(adj) ? "+" : "−"}$
                      {Math.abs(adj.adjustmentAmount).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      {adj.disputeCaseId ? (
                        <Badge className="bg-blue-soft2 text-blue-ink">
                          Disputed #{adj.disputeCaseId}
                        </Badge>
                      ) : adj.reviewed ? (
                        <Badge className="bg-green-soft2 text-green-ink">
                          Reviewed
                        </Badge>
                      ) : isPendingDetails(adj) ? (
                        <Badge className="bg-warn-tint text-warn-strong">
                          Pending details
                        </Badge>
                      ) : (
                        <Badge className="bg-bg-elev text-ink-3">New</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow key={`${adj.id}-detail`}>
                      <TableCell colSpan={8} className="bg-surface-tint p-4">
                        <div className="space-y-3 text-xs">
                          {/* Account + what-is-this header */}
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="text-ink-3">Account:</span>
                            <span className="font-medium text-ink">
                              {accountName(adj.storeId) ?? adj.channel}
                            </span>
                            <span className="text-ink-4">·</span>
                            <span className="text-ink-3">{adj.channel}</span>
                          </div>
                          {typeDescriptions[adj.adjustmentType] && (
                            <p className="text-ink-2 leading-snug">
                              {typeDescriptions[adj.adjustmentType]}
                            </p>
                          )}

                          {/* Pending-details notice — explains the empty fields */}
                          {isPendingDetails(adj) && (
                            <div className="rounded-lg border border-warn/20 bg-warn-tint p-3 text-warn-strong">
                              <p className="font-medium mb-0.5">
                                Order & product details are still pending.
                              </p>
                              <p className="leading-snug">
                                Amazon&apos;s real-time feed only reports the
                                date and amount for this charge. The order ID,
                                SKU, product, carrier and declared weight arrive
                                with the weekly settlement report (typically
                                within 1–2 weeks) and fill in automatically on
                                the next sync — well inside the 90-day dispute
                                window.
                              </p>
                            </div>
                          )}

                          {/* Product row — image + name */}
                          <div className="flex items-start gap-3">
                            {adj.productImageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={adj.productImageUrl}
                                alt={adj.productName ?? "product"}
                                className="w-14 h-14 rounded border border-rule object-cover bg-surface shrink-0"
                              />
                            ) : (
                              <div className="w-14 h-14 rounded border border-rule bg-surface shrink-0 flex items-center justify-center text-ink-4 text-[10px]">
                                no img
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="text-ink font-medium leading-tight">
                                {adj.productName || "—"}
                              </div>
                              <div className="text-ink-3 mt-0.5">
                                {adj.sku && (
                                  <span className="font-mono">
                                    SKU: {adj.sku}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Carrier + tracking + service */}
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <span className="text-ink-3">Carrier:</span>{" "}
                              <span className="font-medium">
                                {adj.carrier || "—"}
                              </span>{" "}
                              {adj.service && (
                                <span className="text-ink-3">
                                  · {adj.service}
                                </span>
                              )}
                            </div>
                            <div>
                              <span className="text-ink-3">Tracking:</span>{" "}
                              {adj.trackingNumber ? (
                                trackingUrl(adj.carrier, adj.trackingNumber) ? (
                                  <a
                                    href={
                                      trackingUrl(
                                        adj.carrier,
                                        adj.trackingNumber,
                                      )!
                                    }
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-mono text-blue-600 hover:underline"
                                  >
                                    {adj.trackingNumber}
                                  </a>
                                ) : (
                                  <span className="font-mono">
                                    {adj.trackingNumber}
                                  </span>
                                )
                              ) : (
                                "—"
                              )}
                            </div>
                          </div>

                          {/* Declared package — what Vladimir told the carrier */}
                          {(adj.declaredWeightLbs || adj.declaredDimL) && (
                            <div className="rounded-lg border border-rule p-3 bg-surface">
                              <p className="text-ink-3 font-medium mb-1">
                                Declared package (what we sent the carrier)
                              </p>
                              <div className="flex flex-wrap gap-x-4 gap-y-1">
                                {adj.declaredWeightLbs != null && (
                                  <span>
                                    <span className="text-ink-3">Weight:</span>{" "}
                                    <strong>
                                      {adj.declaredWeightLbs.toFixed(2)} lbs
                                    </strong>
                                  </span>
                                )}
                                {adj.declaredDimL != null && (
                                  <span>
                                    <span className="text-ink-3">Dims:</span>{" "}
                                    <strong>
                                      {adj.declaredDimL}×{adj.declaredDimW}×
                                      {adj.declaredDimH} in
                                    </strong>
                                  </span>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Label cost math */}
                          {adj.originalLabelCost != null && (
                            <p>
                              <span className="text-ink-3">
                                Original label cost:
                              </span>{" "}
                              ${adj.originalLabelCost.toFixed(2)}{" "}
                              <span className="text-ink-3">→</span>{" "}
                              <span className="font-medium">
                                Net cost: $
                                {Math.max(
                                  0,
                                  adj.originalLabelCost -
                                    adj.adjustmentAmount,
                                ).toFixed(2)}
                              </span>{" "}
                              <span
                                className={
                                  isRefund(adj)
                                    ? "text-success"
                                    : "text-danger"
                                }
                              >
                                ({isRefund(adj) ? "−" : "+"}$
                                {Math.abs(adj.adjustmentAmount).toFixed(2)})
                              </span>
                            </p>
                          )}

                          {/* Dispute helpers — only for charges, not refunds */}
                          {!isRefund(adj) && adj.orderId && (
                            <div className="space-y-2 pt-1">
                              {adj.disputeCaseId ? (
                                // Already disputed — show case link + clear option
                                <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-soft bg-blue-tint px-3 py-2">
                                  <Check size={13} className="text-blue-ink" />
                                  <span className="text-[12px] text-blue-ink">
                                    Disputed{" "}
                                    {adj.disputedAt && (
                                      <span className="opacity-70">
                                        on{" "}
                                        {new Date(adj.disputedAt).toLocaleDateString()}
                                      </span>
                                    )}{" "}
                                    — Case{" "}
                                  </span>
                                  <a
                                    href={caseDashboardUrl(adj.disputeCaseId)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="font-mono text-[12px] text-blue-ink underline"
                                  >
                                    #{adj.disputeCaseId}
                                  </a>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearDispute(adj);
                                    }}
                                    disabled={savingDispute}
                                    className="ml-auto text-[10.5px] text-ink-3 hover:text-danger"
                                  >
                                    Clear
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        copyDispute(adj);
                                      }}
                                      className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-surface-tint"
                                    >
                                      {copiedId === adj.id ? (
                                        <>
                                          <Check
                                            size={12}
                                            className="text-success"
                                          />
                                          Copied
                                        </>
                                      ) : (
                                        <>
                                          <Copy size={12} />
                                          Copy dispute text
                                        </>
                                      )}
                                    </button>
                                    <a
                                      href={BUY_SHIPPING_SUPPORT_URL}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-surface-tint"
                                    >
                                      <ExternalLink size={12} />
                                      Open Amazon Buy Shipping support
                                    </a>
                                    {disputeInputFor === adj.id ? null : (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setDisputeInputFor(adj.id);
                                          setDisputeCaseInput("");
                                        }}
                                        className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-surface-tint"
                                      >
                                        <Check size={12} />
                                        Mark as disputed
                                      </button>
                                    )}
                                    <span className="text-[10.5px] text-ink-3">
                                      Dispute window: 90 days from{" "}
                                      {adj.adjustmentDate}
                                    </span>
                                  </div>

                                  {disputeInputFor === adj.id && (
                                    <div
                                      className="flex flex-wrap items-center gap-2 rounded-md border border-rule bg-surface p-2"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <label className="text-[11.5px] text-ink-2">
                                        Amazon Case ID:
                                      </label>
                                      <input
                                        type="text"
                                        autoFocus
                                        value={disputeCaseInput}
                                        onChange={(e) =>
                                          setDisputeCaseInput(e.target.value)
                                        }
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") saveDispute(adj);
                                          if (e.key === "Escape") {
                                            setDisputeInputFor(null);
                                            setDisputeCaseInput("");
                                          }
                                        }}
                                        placeholder="e.g. 20424098481"
                                        className="font-mono text-[12px] rounded border border-rule bg-bg px-2 py-1 w-40"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => saveDispute(adj)}
                                        disabled={
                                          savingDispute ||
                                          !disputeCaseInput.trim()
                                        }
                                        className="inline-flex items-center gap-1 rounded-md bg-ink px-2.5 py-1 text-[11.5px] font-medium text-bg disabled:opacity-50"
                                      >
                                        Save
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setDisputeInputFor(null);
                                          setDisputeCaseInput("");
                                        }}
                                        className="text-[11.5px] text-ink-3 hover:text-ink"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          )}

                          {adj.notes && (
                            <p className="text-ink-3 bg-surface rounded p-2 border border-rule">
                              {adj.notes}
                            </p>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
        </div>

        {/* MOBILE cards (< md) */}
        <div className="md:hidden divide-y divide-rule rounded-md border border-rule overflow-hidden">
          {adjustments.map((adj) => {
            const expanded = expandedId === adj.id;
            return (
              <div key={adj.id}>
                <button
                  onClick={() => setExpandedId(expanded ? null : adj.id)}
                  className="w-full text-left px-4 py-3 transition-colors hover:bg-surface-tint active:bg-bg-elev"
                >
                  {/* HEAD: order id + amount */}
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span className="font-mono text-[13px] text-ink truncate">
                      {adj.orderId || "—"}
                    </span>
                    <span
                      className={`shrink-0 text-[13px] font-semibold tabular ${
                        isRefund(adj) ? "text-success" : "text-danger"
                      }`}
                    >
                      {isRefund(adj) ? "+" : "−"}$
                      {Math.abs(adj.adjustmentAmount).toFixed(2)}
                    </span>
                  </div>

                  {/* SUB: sku + type */}
                  <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-[11.5px] text-ink-3 mb-2">
                    {adj.sku && (
                      <span className="font-mono">{adj.sku}</span>
                    )}
                    {adj.sku && (
                      <span className="text-ink-4">·</span>
                    )}
                    <Badge variant="outline" className="text-[10px]">
                      {typeLabels[adj.adjustmentType] || adj.adjustmentType}
                    </Badge>
                  </div>

                  {/* ACTION row: account + status */}
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[11.5px] text-ink-2">
                      {accountName(adj.storeId) ?? adj.channel}
                    </span>
                    {adj.reviewed ? (
                      <Badge className="bg-green-soft2 text-green-ink text-[10px]">
                        Reviewed
                      </Badge>
                    ) : isPendingDetails(adj) ? (
                      <Badge className="bg-warn-tint text-warn-strong text-[10px]">
                        Pending details
                      </Badge>
                    ) : (
                      <Badge className="bg-bg-elev text-ink-3 text-[10px]">
                        New
                      </Badge>
                    )}
                  </div>

                  {/* FOOTER: date */}
                  <div className="flex items-center justify-between gap-2 text-[10.5px] text-ink-3">
                    <span className="tabular">{adj.adjustmentDate}</span>
                    {expanded ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </div>
                </button>

                {expanded && (
                  <div className="bg-surface-tint px-4 pb-3 pt-2 space-y-3 text-[11.5px]">
                    {/* Account + what-is-this */}
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-ink-3">Account:</span>
                      <span className="font-medium text-ink">
                        {accountName(adj.storeId) ?? adj.channel}
                      </span>
                      <span className="text-ink-4">·</span>
                      <span className="text-ink-3">{adj.channel}</span>
                    </div>
                    {typeDescriptions[adj.adjustmentType] && (
                      <p className="text-ink-2 leading-snug">
                        {typeDescriptions[adj.adjustmentType]}
                      </p>
                    )}
                    {isPendingDetails(adj) && (
                      <div className="rounded-lg border border-warn/20 bg-warn-tint p-3 text-warn-strong">
                        <p className="font-medium mb-0.5">
                          Order &amp; product details are still pending.
                        </p>
                        <p className="leading-snug">
                          Amazon reports only the date and amount in real time.
                          Order ID, SKU, product and carrier arrive with the
                          weekly settlement report (1–2 weeks) and fill in
                          automatically on the next sync.
                        </p>
                      </div>
                    )}

                    {/* Product row — image + name */}
                    <div className="flex items-start gap-3">
                      {adj.productImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={adj.productImageUrl}
                          alt={adj.productName ?? "product"}
                          className="w-14 h-14 rounded border border-rule object-cover bg-surface shrink-0"
                        />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <div className="text-ink font-medium leading-tight">
                          {adj.productName ?? "—"}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-ink-3">Carrier</div>
                        <div className="text-ink-2">
                          {adj.carrier ?? "—"}{" "}
                          {adj.service ? `· ${adj.service}` : ""}
                        </div>
                      </div>
                      <div>
                        <div className="text-ink-3">Tracking</div>
                        <div className="text-ink-2 font-mono break-all">
                          {adj.trackingNumber ? (
                            trackingUrl(adj.carrier, adj.trackingNumber) ? (
                              <a
                                href={
                                  trackingUrl(adj.carrier, adj.trackingNumber)!
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600"
                              >
                                {adj.trackingNumber}
                              </a>
                            ) : (
                              adj.trackingNumber
                            )
                          ) : (
                            "—"
                          )}
                        </div>
                      </div>
                    </div>

                    {(adj.declaredWeightLbs || adj.declaredDimL) && (
                      <div className="rounded-lg border border-rule p-3 bg-surface">
                        <p className="text-ink-3 font-medium mb-1">
                          Declared package
                        </p>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {adj.declaredWeightLbs != null && (
                            <span>
                              <strong>
                                {adj.declaredWeightLbs.toFixed(2)} lbs
                              </strong>
                            </span>
                          )}
                          {adj.declaredDimL != null && (
                            <span>
                              <strong>
                                {adj.declaredDimL}×{adj.declaredDimW}×
                                {adj.declaredDimH} in
                              </strong>
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {adj.originalLabelCost != null && (
                      <div className="text-ink-2">
                        <span className="text-ink-3">Label:</span> $
                        {adj.originalLabelCost.toFixed(2)} →{" "}
                        <strong>
                          ${" "}
                          {Math.max(
                            0,
                            adj.originalLabelCost - adj.adjustmentAmount,
                          ).toFixed(2)}
                        </strong>{" "}
                        <span
                          className={
                            isRefund(adj) ? "text-success" : "text-danger"
                          }
                        >
                          ({isRefund(adj) ? "−" : "+"}$
                          {Math.abs(adj.adjustmentAmount).toFixed(2)})
                        </span>
                      </div>
                    )}

                    {!isRefund(adj) && adj.orderId && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyDispute(adj);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 py-1 text-[11px] font-medium text-ink"
                        >
                          {copiedId === adj.id ? (
                            <>
                              <Check size={12} className="text-success" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy size={12} />
                              Copy dispute
                            </>
                          )}
                        </button>
                        <a
                          href={BUY_SHIPPING_SUPPORT_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-2.5 py-1 text-[11px] font-medium text-ink"
                        >
                          <ExternalLink size={12} />
                          Open support
                        </a>
                      </div>
                    )}

                    {adj.notes && (
                      <div className="text-ink-3 bg-surface rounded p-2 border border-rule">
                        {adj.notes}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
