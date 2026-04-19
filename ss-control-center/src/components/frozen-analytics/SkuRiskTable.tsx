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
  productName: string;
  totalIncidents: number;
  thawedCount: number;
  thawRate: number | null;
  avgDaysInTransit: number | null;
  avgOriginTempF: number | null;
  avgDestTempF: number | null;
  mostCommonCarrier: string | null;
  mostCommonService: string | null;
  riskScore: number;
  riskLevel: string;
  lastIncidentDate: string | null;
}

const riskConfig: Record<string, { label: string; className: string }> = {
  critical: { label: "Critical", className: "bg-red-600 text-white" },
  high: { label: "High", className: "bg-danger-tint text-danger" },
  medium: { label: "Medium", className: "bg-warn-tint text-warn-strong" },
  low: { label: "Low", className: "bg-green-soft2 text-green-ink" },
  unknown: { label: "Unknown", className: "bg-bg-elev text-ink-3" },
};

interface SkuRiskTableProps {
  profiles: SkuProfile[];
}

export default function SkuRiskTable({ profiles }: SkuRiskTableProps) {
  if (profiles.length === 0) {
    return (
      <p className="text-sm text-ink-3 py-4 text-center">
        No SKU risk data yet. Data appears after frozen incidents are recorded.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>SKU</TableHead>
          <TableHead>Product</TableHead>
          <TableHead>Incidents</TableHead>
          <TableHead>Thaw Rate</TableHead>
          <TableHead>Avg Transit</TableHead>
          <TableHead>Common Carrier</TableHead>
          <TableHead>Risk Score</TableHead>
          <TableHead>Risk</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {profiles.map((p) => {
          const rc = riskConfig[p.riskLevel] || riskConfig.unknown;
          return (
            <TableRow key={p.id}>
              <TableCell className="font-mono text-xs">{p.sku}</TableCell>
              <TableCell className="text-xs max-w-[200px] truncate">
                {p.productName}
              </TableCell>
              <TableCell className="text-xs">
                {p.totalIncidents}
                {p.thawedCount > 0 && (
                  <span className="text-danger ml-1">
                    ({p.thawedCount} thawed)
                  </span>
                )}
              </TableCell>
              <TableCell className="text-xs">
                {p.thawRate !== null
                  ? `${Math.round(p.thawRate * 100)}%`
                  : "—"}
              </TableCell>
              <TableCell className="text-xs">
                {p.avgDaysInTransit !== null
                  ? `${p.avgDaysInTransit.toFixed(1)}d`
                  : "—"}
              </TableCell>
              <TableCell className="text-xs">
                {p.mostCommonCarrier || "—"}{" "}
                {p.mostCommonService && (
                  <span className="text-ink-3">{p.mostCommonService}</span>
                )}
              </TableCell>
              <TableCell className="text-xs font-mono">
                {p.riskScore}/100
              </TableCell>
              <TableCell>
                <Badge className={rc.className}>{rc.label}</Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
