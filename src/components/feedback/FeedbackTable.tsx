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
  NEW: "bg-bg-elev text-ink-2",
  ANALYZED: "bg-green-soft2 text-green-deep",
  REMOVAL_SUBMITTED: "bg-warn-tint text-warn-strong",
  REMOVED: "bg-green-soft2 text-green-ink",
  DENIED: "bg-danger-tint text-danger",
  CONTACT_SENT: "bg-purple-tint text-purple",
  CLOSED: "bg-bg-elev text-ink-3",
};

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={12}
          className={s <= rating ? "fill-warn text-warn" : "text-ink-4"}
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
          className="rounded-md border border-rule bg-surface px-3 py-1.5 text-sm"
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
          className="rounded-md border border-rule bg-surface px-3 py-1.5 text-sm"
        >
          <option value="">All Statuses</option>
          <option value="NEW">New</option>
          <option value="ANALYZED">Analyzed</option>
          <option value="REMOVAL_SUBMITTED">Removal Submitted</option>
          <option value="REMOVED">Removed</option>
          <option value="DENIED">Denied</option>
        </select>
        <span className="text-xs text-ink-3 ml-auto">
          {total} feedback{total !== 1 ? "s" : ""}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-ink-3 py-4 text-center">No feedback found</p>
      ) : (
        <>
        <div className="hidden md:block">
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
                    className={`cursor-pointer hover:bg-surface-tint ${fb.rating <= 2 ? "bg-danger-tint/30" : ""}`}
                    onClick={() => setExpandedId(expanded ? null : fb.id)}
                  >
                    <TableCell className="px-2">
                      {expanded ? (
                        <ChevronDown size={14} className="text-ink-3" />
                      ) : (
                        <ChevronRight size={14} className="text-ink-3" />
                      )}
                    </TableCell>
                    <TableCell>
                      <StarRating rating={fb.rating} />
                    </TableCell>
                    <TableCell className="text-xs text-ink-3">
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
                        <Badge className="bg-green-soft2 text-green-ink">Removable</Badge>
                      )}
                      {fb.removable === false && (
                        <Badge className="bg-bg-elev text-ink-3">Not removable</Badge>
                      )}
                      {fb.removable === null && (
                        <Badge className="bg-bg-elev text-ink-3">Pending</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[fb.status] || ""}>{fb.status}</Badge>
                    </TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow key={`${fb.id}-detail`}>
                      <TableCell colSpan={7} className="bg-surface-tint p-4">
                        <div className="space-y-3 text-xs">
                          <div>
                            <span className="text-ink-3">Full comment:</span>
                            <p className="mt-1 bg-surface rounded border p-2">
                              {fb.comments || "No comment"}
                            </p>
                          </div>

                          {fb.aiReasoning && (
                            <div className="rounded bg-green-soft p-2 text-green-deep">
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
                              <span className="text-ink-3 font-medium">Removal request text:</span>
                              <div className="mt-1 bg-surface rounded border p-2 whitespace-pre-wrap">
                                {fb.removalRequestText}
                              </div>
                            </div>
                          )}

                          {fb.vladimirNotes && (
                            <div className="rounded bg-warn-tint p-2 text-warn-strong">
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
        </div>

        {/* MOBILE cards */}
        <div className="md:hidden divide-y divide-rule rounded-md border border-rule overflow-hidden">
          {items.map((fb) => {
            const expanded = expandedId === fb.id;
            return (
              <div key={fb.id}>
                <button
                  onClick={() => setExpandedId(expanded ? null : fb.id)}
                  className={`w-full text-left px-4 py-3 transition-colors hover:bg-surface-tint active:bg-bg-elev ${
                    fb.rating <= 2 && !expanded ? "bg-danger-tint/30" : ""
                  }`}
                >
                  {/* HEAD: rating + status */}
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <StarRating rating={fb.rating} />
                    <Badge
                      className={`${statusColors[fb.status] || ""} text-[10px]`}
                    >
                      {fb.status}
                    </Badge>
                  </div>

                  {/* SUB: order + date */}
                  <div className="text-[11.5px] text-ink-3 mb-1.5">
                    <span className="font-mono">
                      {fb.orderId.length > 19
                        ? fb.orderId.slice(0, 19) + "…"
                        : fb.orderId}
                    </span>
                    <span className="mx-1.5 text-ink-4">·</span>
                    <span className="tabular">{fb.feedbackDate}</span>
                  </div>

                  {/* BODY: comment */}
                  <div className="text-[12px] text-ink-2 line-clamp-3 mb-2">
                    {fb.comments || (
                      <span className="text-ink-4">(no comment)</span>
                    )}
                  </div>

                  {/* FOOTER: removable + chevron */}
                  <div className="flex items-center justify-between gap-2 text-[10.5px] text-ink-3">
                    {fb.removable === true ? (
                      <Badge className="bg-green-soft2 text-green-ink text-[9px]">
                        Removable
                      </Badge>
                    ) : fb.removable === false ? (
                      <Badge className="bg-bg-elev text-ink-3 text-[9px]">
                        Not removable
                      </Badge>
                    ) : (
                      <span className="text-ink-4">Pending analysis</span>
                    )}
                    {expanded ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </div>
                </button>

                {expanded && (
                  <div className="bg-surface-tint px-4 pb-3 pt-1 space-y-2 text-[11.5px]">
                    <div>
                      <div className="text-ink-3 font-medium">Full comment</div>
                      <div className="mt-1 bg-surface rounded border border-rule p-2 text-ink-2">
                        {fb.comments || "No comment"}
                      </div>
                    </div>
                    {fb.aiReasoning && (
                      <div className="rounded bg-green-soft p-2 text-green-deep">
                        <strong>AI:</strong> {fb.aiReasoning}
                        {fb.removalCategory && (
                          <span className="ml-2">
                            Category: <strong>{fb.removalCategory}</strong>
                          </span>
                        )}
                      </div>
                    )}
                    {fb.removalRequestText && (
                      <div>
                        <div className="text-ink-3 font-medium">
                          Removal request
                        </div>
                        <div className="mt-1 bg-surface rounded border border-rule p-2 whitespace-pre-wrap text-ink-2">
                          {fb.removalRequestText}
                        </div>
                      </div>
                    )}
                    {fb.vladimirNotes && (
                      <div className="rounded bg-warn-tint p-2 text-warn-strong">
                        <strong>Notes:</strong> {fb.vladimirNotes}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
