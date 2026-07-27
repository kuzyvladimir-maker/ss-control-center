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

function typeLabel(t: string | null): string {
  if (t === "WeightAdjustment") return "Weight";
  if (t === "DIMadjustment") return "DIM";
  return t || "—";
}

export default function SkuIssuesPanel({ profiles }: SkuIssuesPanelProps) {
  if (profiles.length === 0) {
    return (
      <p className="text-sm text-ink-3 py-4 text-center">
        No SKU adjustment data yet
      </p>
    );
  }

  return (
    <>
      {/* DESKTOP table */}
      <div className="hidden md:block">
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
                        ? "text-danger font-bold"
                        : p.totalAdjustments >= 3
                          ? "text-warn font-semibold"
                          : ""
                    }
                  >
                    {p.totalAdjustments}x
                  </span>
                </TableCell>
                <TableCell className="text-right text-xs font-medium text-danger">
                  -${Math.abs(p.totalAmountLost).toFixed(2)}
                </TableCell>
                <TableCell className="text-xs">
                  {typeLabel(p.mostCommonType)}
                </TableCell>
                <TableCell className="text-xs">
                  {p.suggestedWeight
                    ? `~${p.suggestedWeight.toFixed(1)} lbs`
                    : "—"}
                </TableCell>
                <TableCell>
                  {p.needsSkuDbUpdate ? (
                    <Badge className="bg-danger-tint text-danger">
                      Update SKU DB
                    </Badge>
                  ) : (
                    <Badge className="bg-green-soft2 text-green-ink">OK</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* MOBILE cards */}
      <div className="md:hidden divide-y divide-rule rounded-md border border-rule overflow-hidden">
        {profiles.map((p) => (
          <div key={p.id} className="px-4 py-3">
            {/* HEAD: SKU + status */}
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <span className="font-mono text-[13px] font-medium text-ink truncate">
                {p.sku}
              </span>
              {p.needsSkuDbUpdate ? (
                <Badge className="bg-danger-tint text-danger text-[10px] shrink-0">
                  Update SKU DB
                </Badge>
              ) : (
                <Badge className="bg-green-soft2 text-green-ink text-[10px] shrink-0">
                  OK
                </Badge>
              )}
            </div>

            {/* SUB: product */}
            <div className="text-[12px] text-ink-2 line-clamp-2 mb-2">
              {p.productName || "—"}
            </div>

            {/* GRID: corrections + total loss */}
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
              <div className="flex justify-between">
                <span className="text-ink-3">Corrections:</span>
                <span
                  className={
                    p.totalAdjustments >= 5
                      ? "text-danger font-bold"
                      : p.totalAdjustments >= 3
                        ? "text-warn font-semibold"
                        : "text-ink"
                  }
                >
                  {p.totalAdjustments}x
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-3">Loss:</span>
                <span className="text-danger font-medium tabular">
                  -${Math.abs(p.totalAmountLost).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-3">Type:</span>
                <span className="text-ink">
                  {typeLabel(p.mostCommonType)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-3">Suggested:</span>
                <span className="text-ink tabular">
                  {p.suggestedWeight
                    ? `~${p.suggestedWeight.toFixed(1)} lb`
                    : "—"}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
