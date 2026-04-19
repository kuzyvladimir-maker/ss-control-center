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
  NEW: "bg-danger-tint text-danger",
  EVIDENCE_GATHERED: "bg-warn-tint text-warn-strong",
  RESPONSE_READY: "bg-green-soft2 text-green-deep",
  SUBMITTED: "bg-green-soft2 text-green-ink",
  DECIDED: "bg-bg-elev text-ink",
  APPEALED: "bg-purple-100 text-purple-700",
  CLOSED: "bg-bg-elev text-ink-3",
};

const decisionColors: Record<string, string> = {
  IN_OUR_FAVOR: "bg-green-soft2 text-green-ink",
  AMAZON_FUNDED: "bg-green-soft2 text-green-ink",
  AGAINST_US: "bg-danger-tint text-danger",
};

interface AtozTableProps {
  claims: Claim[];
  total: number;
}

export default function AtozTable({ claims, total }: AtozTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (claims.length === 0) {
    return (
      <p className="text-sm text-ink-3 py-4 text-center">
        No claims found. Claims appear here when detected from Amazon notifications.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-3">{total} claim{total !== 1 ? "s" : ""}</p>
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
                  className={`cursor-pointer hover:bg-surface-tint ${urgent ? "bg-danger-tint/50" : ""}`}
                  onClick={() => setExpandedId(expanded ? null : c.id)}
                >
                  <TableCell className="px-2">
                    {expanded ? (
                      <ChevronDown size={14} className="text-ink-3" />
                    ) : (
                      <ChevronRight size={14} className="text-ink-3" />
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
                        className={`ml-1 ${c.daysUntilDeadline <= 1 ? "text-danger font-bold" : c.daysUntilDeadline <= 3 ? "text-warn" : "text-ink-3"}`}
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
                    <TableCell colSpan={8} className="bg-surface-tint p-4">
                      <div className="space-y-3 text-xs">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <span className="text-ink-3">Reason:</span>{" "}
                            {c.claimReason || "—"}
                          </div>
                          <div>
                            <span className="text-ink-3">Carrier:</span>{" "}
                            {c.carrier || "—"}
                          </div>
                          <div>
                            <span className="text-ink-3">Tracking:</span>{" "}
                            <code className="bg-white px-1 rounded">
                              {c.trackingNumber || "—"}
                            </code>
                          </div>
                          <div>
                            <span className="text-ink-3">Ship date:</span>{" "}
                            {c.shipDate || "—"}
                          </div>
                          <div>
                            <span className="text-ink-3">Delivered:</span>{" "}
                            {c.deliveredDate || "—"}
                          </div>
                        </div>

                        {c.generatedResponse && (
                          <div>
                            <p className="text-ink-3 font-medium mb-1">
                              Generated Response:
                            </p>
                            <div className="whitespace-pre-wrap rounded bg-white border p-3 text-xs">
                              {c.generatedResponse}
                            </div>
                          </div>
                        )}

                        {c.vladimirNotes && (
                          <div className="rounded bg-warn-tint p-2 text-warn-strong">
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
