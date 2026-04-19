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
          className="rounded-md border border-rule bg-white px-3 py-1.5 text-sm"
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
          className="rounded-md border border-rule bg-white px-3 py-1.5 text-sm"
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
                            <p className="text-ink-3 bg-white rounded p-2 border">
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
      )}
    </div>
  );
}
