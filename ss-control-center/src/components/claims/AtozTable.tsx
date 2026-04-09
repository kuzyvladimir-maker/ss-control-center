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
import { ChevronDown, ChevronRight, AlertCircle } from "lucide-react";
import DefenseStrategyBadge from "./DefenseStrategyBadge";

interface Claim {
  id: string;
  amazonOrderId: string;
  claimType: string;
  claimReason: string | null;
  amount: number | null;
  deadline: string | null;
  daysUntilDeadline: number | null;
  strategyType: string | null;
  strategyConfidence: string | null;
  status: string;
  amazonDecision: string | null;
  generatedResponse: string | null;
  vladimirNotes: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  shipDate: string | null;
  deliveredDate: string | null;
  createdAt: string;
}

const statusColors: Record<string, string> = {
  NEW: "bg-red-100 text-red-700",
  EVIDENCE_GATHERED: "bg-amber-100 text-amber-700",
  RESPONSE_READY: "bg-blue-100 text-blue-700",
  SUBMITTED: "bg-green-100 text-green-700",
  DECIDED: "bg-slate-100 text-slate-700",
  APPEALED: "bg-purple-100 text-purple-700",
  CLOSED: "bg-slate-100 text-slate-500",
};

const decisionColors: Record<string, string> = {
  IN_OUR_FAVOR: "bg-green-100 text-green-700",
  AMAZON_FUNDED: "bg-green-100 text-green-700",
  AGAINST_US: "bg-red-100 text-red-700",
};

interface AtozTableProps {
  claims: Claim[];
  total: number;
}

export default function AtozTable({ claims, total }: AtozTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (claims.length === 0) {
    return (
      <p className="text-sm text-slate-400 py-4 text-center">
        No claims found. Claims appear here when detected from Amazon notifications.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">{total} claim{total !== 1 ? "s" : ""}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8"></TableHead>
            <TableHead className="w-8"></TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Order ID</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Strategy</TableHead>
            <TableHead>Deadline</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {claims.map((c) => {
            const expanded = expandedId === c.id;
            const urgent = c.daysUntilDeadline !== null && c.daysUntilDeadline <= 2;
            return (
              <Fragment key={c.id}>
                <TableRow
                  className={`cursor-pointer hover:bg-slate-50 ${urgent ? "bg-red-50/50" : ""}`}
                  onClick={() => setExpandedId(expanded ? null : c.id)}
                >
                  <TableCell className="px-2">
                    {expanded ? (
                      <ChevronDown size={14} className="text-slate-400" />
                    ) : (
                      <ChevronRight size={14} className="text-slate-400" />
                    )}
                  </TableCell>
                  <TableCell className="px-1">
                    {urgent && (
                      <AlertCircle size={14} className="text-red-500" />
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline">
                      {c.claimType === "A_TO_Z" ? "A-to-Z" : "Chargeback"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {c.amazonOrderId}
                  </TableCell>
                  <TableCell className="text-right text-xs font-medium">
                    {c.amount ? `$${c.amount.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell>
                    <DefenseStrategyBadge
                      strategyType={c.strategyType}
                      confidence={c.strategyConfidence}
                    />
                  </TableCell>
                  <TableCell className="text-xs">
                    {c.deadline || "—"}
                    {c.daysUntilDeadline !== null && (
                      <span
                        className={`ml-1 ${c.daysUntilDeadline <= 1 ? "text-red-600 font-bold" : c.daysUntilDeadline <= 3 ? "text-amber-600" : "text-slate-400"}`}
                      >
                        ({c.daysUntilDeadline}d)
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {c.amazonDecision ? (
                      <Badge className={decisionColors[c.amazonDecision] || ""}>
                        {c.amazonDecision === "IN_OUR_FAVOR"
                          ? "Won"
                          : c.amazonDecision === "AMAZON_FUNDED"
                            ? "Amazon Funded"
                            : "Lost"}
                      </Badge>
                    ) : (
                      <Badge className={statusColors[c.status] || ""}>
                        {c.status}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
                {expanded && (
                  <TableRow key={`${c.id}-detail`}>
                    <TableCell colSpan={8} className="bg-slate-50 p-4">
                      <div className="space-y-3 text-xs">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <span className="text-slate-500">Reason:</span>{" "}
                            {c.claimReason || "—"}
                          </div>
                          <div>
                            <span className="text-slate-500">Carrier:</span>{" "}
                            {c.carrier || "—"}
                          </div>
                          <div>
                            <span className="text-slate-500">Tracking:</span>{" "}
                            <code className="bg-white px-1 rounded">
                              {c.trackingNumber || "—"}
                            </code>
                          </div>
                          <div>
                            <span className="text-slate-500">Ship date:</span>{" "}
                            {c.shipDate || "—"}
                          </div>
                          <div>
                            <span className="text-slate-500">Delivered:</span>{" "}
                            {c.deliveredDate || "—"}
                          </div>
                        </div>

                        {c.generatedResponse && (
                          <div>
                            <p className="text-slate-500 font-medium mb-1">
                              Generated Response:
                            </p>
                            <div className="whitespace-pre-wrap rounded bg-white border p-3 text-xs">
                              {c.generatedResponse}
                            </div>
                          </div>
                        )}

                        {c.vladimirNotes && (
                          <div className="rounded bg-amber-50 p-2 text-amber-800">
                            <strong>Notes:</strong> {c.vladimirNotes}
                          </div>
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
  );
}
