"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Star, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  NEW: "bg-bg-elev text-ink-2",
  ANALYZED: "bg-green-soft2 text-green-deep",
  REMOVAL_SUBMITTED: "bg-warn-tint text-warn-strong",
  REMOVED: "bg-green-soft2 text-green-ink",
  DENIED: "bg-danger-tint text-danger",
  CONTACT_SENT: "bg-purple-100 text-purple-700",
  CLOSED: "bg-bg-elev text-ink-3",
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
  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const handleAddFeedback = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAddSaving(true);
    setAddError(null);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/customer-hub/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          data: {
            orderId: fd.get("orderId") || null,
            store:
              ["", "Salutem Solutions", "Vladimir Personal", "AMZ Commerce", "Sirius International", "Retailer Distributor"][
                parseInt(fd.get("storeIndex") as string) || 1
              ] || "Store",
            rating: parseInt(fd.get("rating") as string) || 3,
            comments: fd.get("comments") || "",
            feedbackDate: fd.get("feedbackDate") || new Date().toISOString().split("T")[0],
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAddOpen(false);
      fetchFeedbacks();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed");
    } finally {
      setAddSaving(false);
    }
  };

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
          <Loader2 size={20} className="animate-spin text-ink-3 mr-2" />
          <span className="text-sm text-ink-3">Loading feedback…</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100">
            <span className="text-xs text-ink-3">
              {total} feedback{total !== 1 ? "s" : ""}
            </span>
            <div className="flex items-center gap-2">
              {syncMessage && (
                <span className="text-[10px] text-ink-3">
                  {syncMessage}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setAddOpen(true); setAddError(null); }}
                className="text-xs"
              >
                <Plus size={12} className="mr-1" /> Add Feedback
              </Button>
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

            {/* Add Feedback modal */}
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Add Feedback</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleAddFeedback} className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-ink-3">Order ID (optional)</label>
                    <Input name="orderId" placeholder="123-1234567-1234567" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-medium text-ink-3">Store</label>
                      <select name="storeIndex" className="w-full rounded border px-3 py-2 text-sm">
                        <option value="1">Salutem Solutions</option>
                        <option value="2">Vladimir Personal</option>
                        <option value="3">AMZ Commerce</option>
                        <option value="4">Sirius International</option>
                        <option value="5">Retailer Distributor</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-ink-3">Rating *</label>
                      <select name="rating" className="w-full rounded border px-3 py-2 text-sm" required>
                        <option value="1">1 star</option>
                        <option value="2">2 stars</option>
                        <option value="3">3 stars</option>
                        <option value="4">4 stars</option>
                        <option value="5">5 stars</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-ink-3">Feedback Date</label>
                    <Input name="feedbackDate" type="date" defaultValue={new Date().toISOString().split("T")[0]} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-ink-3">Comment *</label>
                    <Textarea name="comments" rows={3} required placeholder="Customer's feedback text" />
                  </div>
                  {addError && <p className="text-xs text-danger">{addError}</p>}
                  <div className="flex justify-end gap-2 pt-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
                    <Button type="submit" size="sm" disabled={addSaving}>
                      {addSaving ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
                      Create
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {feedbacks.length === 0 ? (
            <div className="py-12 text-center">
              <Star size={32} className="mx-auto text-ink-4 mb-3" />
              <p className="text-sm font-medium text-ink-2">
                No feedback yet
              </p>
              <p className="text-xs text-ink-3 mt-1">
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
                    className={`cursor-pointer hover:bg-surface-tint ${
                      selectedId === fb.id ? "bg-green-soft" : ""
                    } ${fb.rating <= 2 ? "bg-danger-tint/30" : ""}`}
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
                    <TableCell className="text-xs text-ink-3">
                      {fb.feedbackDate}
                    </TableCell>
                    <TableCell className="text-xs max-w-[300px] truncate">
                      {fb.comments || (
                        <span className="text-ink-4">(no comment)</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {fb.removable === true ? (
                        <Badge className="bg-green-soft2 text-green-ink">
                          Yes
                        </Badge>
                      ) : fb.removable === false ? (
                        <Badge className="bg-bg-elev text-ink-3">
                          No
                        </Badge>
                      ) : (
                        <span className="text-ink-4 text-xs">—</span>
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
