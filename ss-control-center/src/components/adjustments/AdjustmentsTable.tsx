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
}

const typeLabels: Record<string, string> = {
  WeightAdjustment: "Weight charge",
  WeightAdjustmentRefund: "Refund",
  ReturnShipping: "Return shipping",
  DIMadjustment: "DIM",
  CarrierAdjustment: "Carrier",
};

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
  adjustments,
  total,
  filters,
  onFiltersChange,
}: AdjustmentsTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
              <TableHead>Channel</TableHead>
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
                    <TableCell className="text-xs">{adj.channel}</TableCell>
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
                      <Badge
                        className={
                          adj.reviewed
                            ? "bg-green-soft2 text-green-ink"
                            : "bg-bg-elev text-ink-3"
                        }
                      >
                        {adj.reviewed ? "Reviewed" : "New"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow key={`${adj.id}-detail`}>
                      <TableCell colSpan={8} className="bg-surface-tint p-4">
                        <div className="space-y-3 text-xs">
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
                            <div className="flex flex-wrap items-center gap-2 pt-1">
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
                                    <Check size={12} className="text-success" />
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
                              <span className="text-[10.5px] text-ink-3">
                                Dispute window: 90 days from{" "}
                                {adj.adjustmentDate}
                              </span>
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

                  {/* ACTION row: channel + status */}
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[11.5px] text-ink-2">
                      {adj.channel}
                    </span>
                    <Badge
                      className={
                        adj.reviewed
                          ? "bg-green-soft2 text-green-ink text-[10px]"
                          : "bg-bg-elev text-ink-3 text-[10px]"
                      }
                    >
                      {adj.reviewed ? "Reviewed" : "New"}
                    </Badge>
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
