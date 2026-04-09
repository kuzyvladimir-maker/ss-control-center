"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface SkuProfile {
  id: string;
  sku: string;
  productName: string | null;
  totalAdjustments: number;
  totalAmountLost: number;
  avgAdjustmentAmount: number | null;
  mostCommonType: string | null;
  needsSkuDbUpdate: boolean;
  suggestedWeight: number | null;
  lastAdjustmentDate: string | null;
}

interface SkuIssuesPanelProps {
  profiles: SkuProfile[];
}

export default function SkuIssuesPanel({ profiles }: SkuIssuesPanelProps) {
  if (profiles.length === 0) {
    return (
      <p className="text-sm text-slate-400 py-4 text-center">
        No SKU adjustment data yet
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>SKU</TableHead>
          <TableHead>Product</TableHead>
          <TableHead>Corrections</TableHead>
          <TableHead className="text-right">Total Loss</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Suggested Weight</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {profiles.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="font-mono text-xs">{p.sku}</TableCell>
            <TableCell className="text-xs max-w-[180px] truncate">
              {p.productName || "—"}
            </TableCell>
            <TableCell className="text-xs">
              <span
                className={
                  p.totalAdjustments >= 5
                    ? "text-red-600 font-bold"
                    : p.totalAdjustments >= 3
                      ? "text-amber-600 font-semibold"
                      : ""
                }
              >
                {p.totalAdjustments}x
              </span>
            </TableCell>
            <TableCell className="text-right text-xs font-medium text-red-600">
              -${Math.abs(p.totalAmountLost).toFixed(2)}
            </TableCell>
            <TableCell className="text-xs">
              {p.mostCommonType === "WeightAdjustment"
                ? "Weight"
                : p.mostCommonType === "DIMadjustment"
                  ? "DIM"
                  : p.mostCommonType || "—"}
            </TableCell>
            <TableCell className="text-xs">
              {p.suggestedWeight
                ? `~${p.suggestedWeight.toFixed(1)} lbs`
                : "—"}
            </TableCell>
            <TableCell>
              {p.needsSkuDbUpdate ? (
                <Badge className="bg-red-100 text-red-700">
                  Update SKU DB
                </Badge>
              ) : (
                <Badge className="bg-green-100 text-green-700">OK</Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
