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
import { ChevronDown, ChevronRight } from "lucide-react";

interface Adjustment {
  id: string;
  channel: string;
  orderId: string;
  adjustmentDate: string;
  adjustmentType: string;
  adjustmentAmount: number;
  adjustmentReason: string | null;
  sku: string | null;
  productName: string | null;
  carrier: string | null;
  service: string | null;
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
  WeightAdjustment: "Weight",
  DIMadjustment: "DIM",
  CarrierAdjustment: "Carrier",
};

interface AdjustmentsTableProps {
  adjustments: Adjustment[];
  total: number;
  filters: { channel: string; days: string; sku: string };
  onFiltersChange: (f: { channel: string; days: string; sku: string }) => void;
}

export default function AdjustmentsTable({
  adjustments,
  total,
  filters,
  onFiltersChange,
}: AdjustmentsTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
                    <TableCell className="font-mono text-xs">
                      {adj.orderId.length > 15
                        ? `${adj.orderId.slice(0, 15)}...`
                        : adj.orderId}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {adj.sku || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {typeLabels[adj.adjustmentType] || adj.adjustmentType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs font-medium text-danger">
                      ${Math.abs(adj.adjustmentAmount).toFixed(2)}
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
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <span className="text-ink-3">Product:</span>{" "}
                              {adj.productName || "—"}
                            </div>
                            <div>
                              <span className="text-ink-3">Carrier:</span>{" "}
                              {adj.carrier || "—"} {adj.service || ""}
                            </div>
                          </div>

                          {/* Weight comparison */}
                          {(adj.declaredWeightLbs || adj.adjustedWeightLbs) && (
                            <div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
                              <div>
                                <p className="text-ink-3 font-medium mb-1">
                                  Declared
                                </p>
                                {adj.declaredWeightLbs && (
                                  <p>Weight: {adj.declaredWeightLbs} lbs</p>
                                )}
                                {adj.declaredDimL && (
                                  <p>
                                    Dims: {adj.declaredDimL}x{adj.declaredDimW}x
                                    {adj.declaredDimH}
                                  </p>
                                )}
                              </div>
                              <div>
                                <p className="text-danger font-medium mb-1">
                                  Adjusted by carrier
                                </p>
                                {adj.adjustedWeightLbs && (
                                  <p>
                                    Weight: {adj.adjustedWeightLbs} lbs
                                    {adj.declaredWeightLbs && (
                                      <span className="text-danger ml-1">
                                        (+
                                        {(
                                          adj.adjustedWeightLbs -
                                          adj.declaredWeightLbs
                                        ).toFixed(1)}{" "}
                                        lbs)
                                      </span>
                                    )}
                                  </p>
                                )}
                              </div>
                            </div>
                          )}

                          {adj.originalLabelCost && (
                            <p>
                              <span className="text-ink-3">
                                Label cost:
                              </span>{" "}
                              ${adj.originalLabelCost.toFixed(2)} &rarr;{" "}
                              <span className="font-medium">
                                Effective: $
                                {(
                                  adj.originalLabelCost +
                                  Math.abs(adj.adjustmentAmount)
                                ).toFixed(2)}
                              </span>{" "}
                              <span className="text-danger">
                                (+${Math.abs(adj.adjustmentAmount).toFixed(2)})
                              </span>
                            </p>
                          )}

                          {adj.notes && (
                            <p className="text-ink-3 bg-surface rounded p-2 border">
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
                      {adj.orderId}
                    </span>
                    <span className="shrink-0 text-[13px] font-semibold tabular text-danger">
                      ${Math.abs(adj.adjustmentAmount).toFixed(2)}
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
                  <div className="bg-surface-tint px-4 pb-3 pt-1 grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11.5px]">
                    <div>
                      <div className="text-ink-3">Product</div>
                      <div className="text-ink-2">{adj.productName ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-ink-3">Carrier</div>
                      <div className="text-ink-2">
                        {adj.carrier ?? "—"} {adj.service ?? ""}
                      </div>
                    </div>
                    {(adj.declaredWeightLbs || adj.adjustedWeightLbs) && (
                      <div className="sm:col-span-2 rounded-lg border border-rule p-3 grid grid-cols-2 gap-3 bg-surface">
                        <div>
                          <p className="text-ink-3 font-medium mb-1">Declared</p>
                          {adj.declaredWeightLbs && (
                            <p>{adj.declaredWeightLbs} lbs</p>
                          )}
                          {adj.declaredDimL && (
                            <p>
                              {adj.declaredDimL}×{adj.declaredDimW}×
                              {adj.declaredDimH}
                            </p>
                          )}
                        </div>
                        <div>
                          <p className="text-danger font-medium mb-1">
                            Adjusted
                          </p>
                          {adj.adjustedWeightLbs && (
                            <p>
                              {adj.adjustedWeightLbs} lbs
                              {adj.declaredWeightLbs && (
                                <span className="text-danger ml-1">
                                  (+
                                  {(
                                    adj.adjustedWeightLbs -
                                    adj.declaredWeightLbs
                                  ).toFixed(1)}
                                  )
                                </span>
                              )}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                    {adj.originalLabelCost && (
                      <div className="sm:col-span-2 text-ink-2">
                        <span className="text-ink-3">Label:</span>{" "}
                        ${adj.originalLabelCost.toFixed(2)} →{" "}
                        ${(
                          adj.originalLabelCost +
                          Math.abs(adj.adjustmentAmount)
                        ).toFixed(2)}{" "}
                        <span className="text-danger">
                          (+${Math.abs(adj.adjustmentAmount).toFixed(2)})
                        </span>
                      </div>
                    )}
                    {adj.notes && (
                      <div className="sm:col-span-2 text-ink-3 bg-surface rounded p-2 border border-rule">
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
