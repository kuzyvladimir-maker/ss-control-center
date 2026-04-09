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
import { ChevronDown, ChevronRight, Star } from "lucide-react";

interface FeedbackItem {
  id: string;
  orderId: string;
  rating: number;
  comments: string | null;
  feedbackDate: string;
  store: string | null;
  removable: boolean | null;
  removalCategory: string | null;
  removalConfidence: string | null;
  suggestedAction: string | null;
  aiReasoning: string | null;
  removalRequestText: string | null;
  status: string;
  removalDecision: string | null;
  vladimirNotes: string | null;
}

const statusColors: Record<string, string> = {
  NEW: "bg-slate-100 text-slate-600",
  ANALYZED: "bg-blue-100 text-blue-700",
  REMOVAL_SUBMITTED: "bg-amber-100 text-amber-700",
  REMOVED: "bg-green-100 text-green-700",
  DENIED: "bg-red-100 text-red-700",
  CONTACT_SENT: "bg-purple-100 text-purple-700",
  CLOSED: "bg-slate-100 text-slate-500",
};

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={12}
          className={s <= rating ? "fill-amber-400 text-amber-400" : "text-slate-200"}
        />
      ))}
    </span>
  );
}

interface FeedbackTableProps {
  items: FeedbackItem[];
  total: number;
  filters: { rating: string; store: string; status: string };
  onFiltersChange: (f: { rating: string; store: string; status: string }) => void;
}

export default function FeedbackTable({
  items,
  total,
  filters,
  onFiltersChange,
}: FeedbackTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filters.rating}
          onChange={(e) => onFiltersChange({ ...filters, rating: e.target.value })}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All Ratings</option>
          <option value="negative">Negative (1-2)</option>
          <option value="3">3 Stars</option>
          <option value="4">4 Stars</option>
          <option value="5">5 Stars</option>
        </select>
        <select
          value={filters.status}
          onChange={(e) => onFiltersChange({ ...filters, status: e.target.value })}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All Statuses</option>
          <option value="NEW">New</option>
          <option value="ANALYZED">Analyzed</option>
          <option value="REMOVAL_SUBMITTED">Removal Submitted</option>
          <option value="REMOVED">Removed</option>
          <option value="DENIED">Denied</option>
        </select>
        <span className="text-xs text-slate-500 ml-auto">
          {total} feedback{total !== 1 ? "s" : ""}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-slate-400 py-4 text-center">No feedback found</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Rating</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Comment</TableHead>
              <TableHead>AI Analysis</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((fb) => {
              const expanded = expandedId === fb.id;
              return (
                <Fragment key={fb.id}>
                  <TableRow
                    className={`cursor-pointer hover:bg-slate-50 ${fb.rating <= 2 ? "bg-red-50/30" : ""}`}
                    onClick={() => setExpandedId(expanded ? null : fb.id)}
                  >
                    <TableCell className="px-2">
                      {expanded ? (
                        <ChevronDown size={14} className="text-slate-400" />
                      ) : (
                        <ChevronRight size={14} className="text-slate-400" />
                      )}
                    </TableCell>
                    <TableCell>
                      <StarRating rating={fb.rating} />
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {fb.feedbackDate}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {fb.orderId.length > 15 ? `${fb.orderId.slice(0, 15)}...` : fb.orderId}
                    </TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">
                      {fb.comments || "—"}
                    </TableCell>
                    <TableCell>
                      {fb.removable === true && (
                        <Badge className="bg-green-100 text-green-700">Removable</Badge>
                      )}
                      {fb.removable === false && (
                        <Badge className="bg-slate-100 text-slate-500">Not removable</Badge>
                      )}
                      {fb.removable === null && (
                        <Badge className="bg-slate-100 text-slate-400">Pending</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[fb.status] || ""}>{fb.status}</Badge>
                    </TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow key={`${fb.id}-detail`}>
                      <TableCell colSpan={7} className="bg-slate-50 p-4">
                        <div className="space-y-3 text-xs">
                          <div>
                            <span className="text-slate-500">Full comment:</span>
                            <p className="mt-1 bg-white rounded border p-2">
                              {fb.comments || "No comment"}
                            </p>
                          </div>

                          {fb.aiReasoning && (
                            <div className="rounded bg-blue-50 p-2 text-blue-700">
                              <strong>AI Analysis:</strong> {fb.aiReasoning}
                              {fb.removalCategory && (
                                <span className="ml-2">
                                  Category: <strong>{fb.removalCategory}</strong>
                                </span>
                              )}
                            </div>
                          )}

                          {fb.removalRequestText && (
                            <div>
                              <span className="text-slate-500 font-medium">Removal request text:</span>
                              <div className="mt-1 bg-white rounded border p-2 whitespace-pre-wrap">
                                {fb.removalRequestText}
                              </div>
                            </div>
                          )}

                          {fb.vladimirNotes && (
                            <div className="rounded bg-amber-50 p-2 text-amber-800">
                              <strong>Notes:</strong> {fb.vladimirNotes}
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
