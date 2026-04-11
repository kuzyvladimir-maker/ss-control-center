"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import FeedbackDetail from "./FeedbackDetail";

interface Feedback {
  id: string;
  rating: number;
  comments: string | null;
  feedbackDate: string;
  store: string | null;
  amazonOrderId: string | null;
  removable: boolean | null;
  removalCategory: string | null;
  suggestedAction: string | null;
  status: string;
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

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={12}
          className={
            s <= rating ? "fill-amber-400 text-amber-400" : "text-slate-200"
          }
        />
      ))}
    </span>
  );
}

export default function FeedbackTab() {
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchFeedbacks = async () => {
    try {
      const res = await fetch("/api/customer-hub/feedback?limit=50");
      const data = await res.json();
      setFeedbacks(data.feedbacks || []);
      setTotal(data.total || 0);
    } catch {
      setFeedbacks([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeedbacks();
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/customer-hub/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
      });
      const data = await res.json();
      setSyncMessage(data.message || `Synced ${data.synced || 0}`);
      await fetchFeedbacks();
    } catch {
      setSyncMessage("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  // Merge the updated feedback from the detail panel back into the list so
  // badges/status refresh without a full refetch.
  const handleDetailChange = (fb: Feedback) => {
    setFeedbacks((prev) =>
      prev.map((f) =>
        f.id === fb.id
          ? {
              ...f,
              rating: fb.rating,
              comments: fb.comments,
              feedbackDate: fb.feedbackDate,
              store: fb.store,
              amazonOrderId: fb.amazonOrderId,
              removable: fb.removable,
              removalCategory: fb.removalCategory,
              suggestedAction: fb.suggestedAction,
              status: fb.status,
            }
          : f
      )
    );
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-slate-400 mr-2" />
          <span className="text-sm text-slate-500">Loading feedback…</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100">
            <span className="text-xs text-slate-500">
              {total} feedback{total !== 1 ? "s" : ""}
            </span>
            <div className="flex items-center gap-2">
              {syncMessage && (
                <span className="text-[10px] text-slate-400">
                  {syncMessage}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={syncing}
                className="text-xs"
              >
                {syncing ? (
                  <Loader2 size={12} className="animate-spin mr-1" />
                ) : (
                  <RefreshCw size={12} className="mr-1" />
                )}
                Sync Feedback
              </Button>
            </div>
          </div>

          {feedbacks.length === 0 ? (
            <div className="py-12 text-center">
              <Star size={32} className="mx-auto text-slate-300 mb-3" />
              <p className="text-sm font-medium text-slate-600">
                No feedback yet
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Seller feedback will appear here once synced from SP-API
                Reports.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rating</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Comment</TableHead>
                  <TableHead>Removable?</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {feedbacks.map((fb) => (
                  <TableRow
                    key={fb.id}
                    className={`cursor-pointer hover:bg-slate-50 ${
                      selectedId === fb.id ? "bg-blue-50" : ""
                    } ${fb.rating <= 2 ? "bg-red-50/30" : ""}`}
                    onClick={() =>
                      setSelectedId(selectedId === fb.id ? null : fb.id)
                    }
                  >
                    <TableCell>
                      <Stars rating={fb.rating} />
                    </TableCell>
                    <TableCell className="text-xs">
                      {fb.store || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {fb.feedbackDate}
                    </TableCell>
                    <TableCell className="text-xs max-w-[300px] truncate">
                      {fb.comments || (
                        <span className="text-slate-300">(no comment)</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {fb.removable === true ? (
                        <Badge className="bg-green-100 text-green-700">
                          Yes
                        </Badge>
                      ) : fb.removable === false ? (
                        <Badge className="bg-slate-100 text-slate-500">
                          No
                        </Badge>
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[fb.status] || ""}>
                        {fb.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selectedId && (
        <div className="mt-4">
          <FeedbackDetail
            key={selectedId}
            feedbackId={selectedId}
            onClose={() => setSelectedId(null)}
            onChange={handleDetailChange}
          />
        </div>
      )}
    </>
  );
}
