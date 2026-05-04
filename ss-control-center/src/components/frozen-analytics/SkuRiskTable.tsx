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
  critical: { label: "Critical", className: "bg-danger text-green-cream" },
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
    <>
      {/* DESKTOP table */}
      <div className="hidden md:block">
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
      </div>

      {/* MOBILE cards */}
      <div className="md:hidden divide-y divide-rule rounded-md border border-rule overflow-hidden">
        {profiles.map((p) => {
          const rc = riskConfig[p.riskLevel] || riskConfig.unknown;
          return (
            <div key={p.id} className="px-4 py-3">
              {/* HEAD: SKU + risk badge */}
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <span className="font-mono text-[13px] font-medium text-ink truncate">
                  {p.sku}
                </span>
                <Badge className={`${rc.className} text-[10px] shrink-0`}>
                  {rc.label} · {p.riskScore}
                </Badge>
              </div>

              {/* SUB: product */}
              <div className="text-[12px] text-ink-2 line-clamp-2 mb-2">
                {p.productName}
              </div>

              {/* GRID: stats */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
                <div className="flex justify-between">
                  <span className="text-ink-3">Incidents:</span>
                  <span className="text-ink tabular">
                    {p.totalIncidents}
                    {p.thawedCount > 0 && (
                      <span className="text-danger ml-1">
                        ({p.thawedCount})
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Thaw rate:</span>
                  <span className="text-ink tabular">
                    {p.thawRate !== null
                      ? `${Math.round(p.thawRate * 100)}%`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Avg transit:</span>
                  <span className="text-ink tabular">
                    {p.avgDaysInTransit !== null
                      ? `${p.avgDaysInTransit.toFixed(1)}d`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Carrier:</span>
                  <span className="text-ink truncate">
                    {p.mostCommonCarrier || "—"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
