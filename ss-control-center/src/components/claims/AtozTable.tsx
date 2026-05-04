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
  APPEALED: "bg-purple-tint text-purple",
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

      {/* DESKTOP table */}
      <div className="hidden md:block">
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
                      <AlertCircle size={14} className="text-danger" />
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
                            <code className="bg-surface px-1 rounded">
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
                            <div className="whitespace-pre-wrap rounded bg-surface border p-3 text-xs">
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

      {/* MOBILE cards */}
      <div className="md:hidden divide-y divide-rule rounded-md border border-rule overflow-hidden">
        {claims.map((c) => {
          const expanded = expandedId === c.id;
          const urgent =
            c.daysUntilDeadline !== null && c.daysUntilDeadline <= 2;
          return (
            <div key={c.id}>
              <button
                onClick={() => setExpandedId(expanded ? null : c.id)}
                className={`w-full text-left px-4 py-3 transition-colors hover:bg-surface-tint active:bg-bg-elev ${
                  urgent && !expanded ? "bg-danger-tint/40" : ""
                }`}
              >
                {/* HEAD: order id + amount + urgent dot */}
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {urgent && (
                      <AlertCircle
                        size={13}
                        className="shrink-0 text-danger"
                      />
                    )}
                    <span className="font-mono text-[13px] text-ink truncate">
                      {c.amazonOrderId}
                    </span>
                  </div>
                  <span className="shrink-0 text-[13px] font-semibold tabular text-ink">
                    {c.amount ? `$${c.amount.toFixed(2)}` : "—"}
                  </span>
                </div>

                {/* SUB: type + strategy */}
                <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mb-2">
                  <Badge variant="outline" className="text-[10px]">
                    {c.claimType === "A_TO_Z" ? "A-to-Z" : "Chargeback"}
                  </Badge>
                  <DefenseStrategyBadge
                    strategyType={c.strategyType}
                    confidence={c.strategyConfidence}
                  />
                </div>

                {/* ACTION row: status + deadline */}
                <div className="flex items-center justify-between gap-2 mb-1">
                  {c.amazonDecision ? (
                    <Badge
                      className={`${decisionColors[c.amazonDecision] || ""} text-[10px]`}
                    >
                      {c.amazonDecision === "IN_OUR_FAVOR"
                        ? "Won"
                        : c.amazonDecision === "AMAZON_FUNDED"
                          ? "Amazon Funded"
                          : "Lost"}
                    </Badge>
                  ) : (
                    <Badge
                      className={`${statusColors[c.status] || ""} text-[10px]`}
                    >
                      {c.status}
                    </Badge>
                  )}
                  <div className="text-[10.5px] tabular text-ink-3">
                    {c.deadline || "—"}
                    {c.daysUntilDeadline !== null && (
                      <span
                        className={`ml-1 ${c.daysUntilDeadline <= 1 ? "text-danger font-bold" : c.daysUntilDeadline <= 3 ? "text-warn" : ""}`}
                      >
                        ({c.daysUntilDeadline}d)
                      </span>
                    )}
                  </div>
                </div>

                {/* FOOTER: chevron */}
                <div className="flex items-center justify-end text-[10.5px] text-ink-3">
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
                    <div className="text-ink-3">Reason</div>
                    <div className="text-ink-2">{c.claimReason || "—"}</div>
                  </div>
                  <div>
                    <div className="text-ink-3">Carrier</div>
                    <div className="text-ink-2">{c.carrier || "—"}</div>
                  </div>
                  <div>
                    <div className="text-ink-3">Tracking</div>
                    <code className="text-ink-2 font-mono break-all">
                      {c.trackingNumber || "—"}
                    </code>
                  </div>
                  <div>
                    <div className="text-ink-3">Ship date</div>
                    <div className="text-ink-2">{c.shipDate || "—"}</div>
                  </div>
                  <div>
                    <div className="text-ink-3">Delivered</div>
                    <div className="text-ink-2">{c.deliveredDate || "—"}</div>
                  </div>
                  {c.generatedResponse && (
                    <div className="sm:col-span-2">
                      <div className="text-ink-3 mb-1 font-medium">
                        Generated Response
                      </div>
                      <div className="whitespace-pre-wrap rounded bg-surface border border-rule p-3">
                        {c.generatedResponse}
                      </div>
                    </div>
                  )}
                  {c.vladimirNotes && (
                    <div className="sm:col-span-2 rounded bg-warn-tint p-2 text-warn-strong">
                      <strong>Notes:</strong> {c.vladimirNotes}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
