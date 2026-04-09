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
import type { CsCase } from "@/types";
import ActionBadge from "./ActionBadge";

const priorityColors: Record<string, string> = {
  LOW: "bg-slate-100 text-slate-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
  CRITICAL: "bg-red-600 text-white",
};

const statusColors: Record<string, string> = {
  open: "bg-blue-100 text-blue-700",
  responded: "bg-yellow-100 text-yellow-700",
  resolved: "bg-green-100 text-green-700",
};

interface CaseHistoryTableProps {
  cases: CsCase[];
  total: number;
  filters: {
    channel: string;
    category: string;
    priority: string;
    status: string;
  };
  onFiltersChange: (filters: {
    channel: string;
    category: string;
    priority: string;
    status: string;
  }) => void;
}

export default function CaseHistoryTable({
  cases,
  total,
  filters,
  onFiltersChange,
}: CaseHistoryTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const updateFilter = (key: string, value: string) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filters.channel}
          onChange={(e) => updateFilter("channel", e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All Channels</option>
          <option value="Amazon">Amazon</option>
          <option value="Walmart">Walmart</option>
        </select>
        <select
          value={filters.category}
          onChange={(e) => updateFilter("category", e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All Categories</option>
          {["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10"].map(
            (c) => (
              <option key={c} value={c}>
                {c}
              </option>
            )
          )}
        </select>
        <select
          value={filters.priority}
          onChange={(e) => updateFilter("priority", e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All Priorities</option>
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
          <option value="CRITICAL">Critical</option>
        </select>
        <select
          value={filters.status}
          onChange={(e) => updateFilter("status", e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="responded">Responded</option>
          <option value="resolved">Resolved</option>
        </select>
        <span className="text-xs text-slate-500 ml-auto">
          {total} case{total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      {cases.length === 0 ? (
        <p className="text-sm text-slate-400 py-4 text-center">
          No cases found
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cases.map((c) => {
              const isExpanded = expandedId === c.id;
              return (
                <Fragment key={c.id}>
                  <TableRow
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() =>
                      setExpandedId(isExpanded ? null : c.id)
                    }
                  >
                    <TableCell className="px-2">
                      {isExpanded ? (
                        <ChevronDown size={14} className="text-slate-400" />
                      ) : (
                        <ChevronRight size={14} className="text-slate-400" />
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {new Date(c.createdAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </TableCell>
                    <TableCell className="text-xs">{c.channel}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {c.orderId || "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.category} {c.categoryName ? `- ${c.categoryName}` : ""}
                    </TableCell>
                    <TableCell>
                      <ActionBadge action={c.action || "INFO"} />
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={
                          priorityColors[c.priority || "MEDIUM"] || ""
                        }
                      >
                        {c.priority || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[c.status] || ""}>
                        {c.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow key={`${c.id}-detail`}>
                      <TableCell colSpan={8} className="bg-slate-50 p-4">
                        <div className="space-y-3 text-sm">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <span className="text-slate-500">
                                Customer:
                              </span>{" "}
                              {c.customerName || "—"}
                            </div>
                            <div>
                              <span className="text-slate-500">
                                Product:
                              </span>{" "}
                              {c.product || "—"}
                            </div>
                            <div>
                              <span className="text-slate-500">Type:</span>{" "}
                              {c.productType || "—"}
                            </div>
                            <div>
                              <span className="text-slate-500">
                                Language:
                              </span>{" "}
                              {c.language || "—"}
                            </div>
                          </div>
                          {c.carrierDelayDetected && (
                            <div className="rounded bg-blue-50 border border-blue-200 p-2 text-xs text-blue-700">
                              Carrier delay: {c.promisedEdd} &rarr;{" "}
                              {c.actualDelivery}
                              {c.daysLate
                                ? ` (+${c.daysLate}d)`
                                : ""}{" "}
                              | Badge: {c.carrierBadge || "Unknown"}
                            </div>
                          )}
                          {c.response && (
                            <div>
                              <p className="text-slate-500 mb-1 font-medium">
                                Response:
                              </p>
                              <div className="whitespace-pre-wrap rounded bg-white border p-3 text-xs">
                                {c.response}
                              </div>
                            </div>
                          )}
                          {c.internalNotes && (
                            <div className="rounded bg-amber-50 p-2 text-xs text-amber-800">
                              <strong>Internal:</strong> {c.internalNotes}
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
      )}
    </div>
  );
}
