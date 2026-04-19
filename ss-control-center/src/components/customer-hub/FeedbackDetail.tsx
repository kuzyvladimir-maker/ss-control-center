"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  X,
  Copy,
  Check,
  RefreshCw,
  Send,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Feedback {
  id: string;
  amazonFeedbackId: string;
  orderId: string;
  amazonOrderId: string | null;
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
  publicResponse: string | null;
  status: string;
  removalSubmittedAt: string | null;
  vladimirNotes: string | null;
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

const actionColors: Record<string, string> = {
  REQUEST_REMOVAL: "bg-green-soft2 text-green-ink",
  CONTACT_BUYER: "bg-green-soft2 text-green-deep",
  RESPOND_PUBLICLY: "bg-purple-100 text-purple-700",
  MONITOR: "bg-bg-elev text-ink-2",
};

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={14}
          className={
            s <= rating ? "fill-amber-400 text-amber-400" : "text-slate-200"
          }
        />
      ))}
    </span>
  );
}

interface FeedbackDetailProps {
  feedbackId: string;
  onClose: () => void;
  onChange?: (fb: Feedback) => void;
}

export default function FeedbackDetail({
  feedbackId,
  onClose,
  onChange,
}: FeedbackDetailProps) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/customer-hub/feedback/${feedbackId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: Feedback) => {
        if (cancelled) return;
        setFeedback(data);
        setNotesDraft(data.vladimirNotes || "");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [feedbackId]);

  const applyUpdate = (fb: Feedback) => {
    setFeedback(fb);
    onChange?.(fb);
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/customer-hub/feedback/${feedbackId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      applyUpdate(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleMarkSubmitted = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/customer-hub/feedback/${feedbackId}/remove`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.feedback) applyUpdate(data.feedback);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark submitted");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyRemoval = async () => {
    if (!feedback?.removalRequestText) return;
    try {
      await navigator.clipboard.writeText(feedback.removalRequestText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — silently ignore */
    }
  };

  const handleSaveNotes = async () => {
    if (!feedback) return;
    if (notesDraft === (feedback.vladimirNotes || "")) return;
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/customer-hub/feedback/${feedbackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vladimirNotes: notesDraft }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyUpdate(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save notes");
    } finally {
      setSavingNotes(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 size={18} className="animate-spin text-ink-3 mr-2" />
          <span className="text-sm text-ink-3">Loading feedback…</span>
        </CardContent>
      </Card>
    );
  }

  if (!feedback) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <span className="text-sm text-danger">
            {error || "Feedback not found"}
          </span>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X size={16} />
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isAnalyzed = feedback.status !== "NEW";
  const canCopyRemoval = !!feedback.removalRequestText;
  const canMarkSubmitted =
    feedback.removable === true && feedback.status !== "REMOVAL_SUBMITTED";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
          <Stars rating={feedback.rating} />
          <Badge className={statusColors[feedback.status] || ""}>
            {feedback.status}
          </Badge>
          {feedback.store && (
            <span className="text-xs text-ink-3">{feedback.store}</span>
          )}
          {feedback.amazonOrderId && (
            <span className="font-mono text-[10px] text-ink-3">
              {feedback.amazonOrderId}
            </span>
          )}
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X size={16} />
        </Button>
      </CardHeader>

      <CardContent className="space-y-4 text-xs">
        {error && (
          <div className="rounded border border-danger/20 bg-danger-tint p-2 text-danger">
            {error}
          </div>
        )}

        {/* Customer comment */}
        <div>
          <p className="text-ink-3 font-medium mb-1">Customer comment:</p>
          <div className="whitespace-pre-wrap rounded border border-rule bg-surface-tint p-3">
            {feedback.comments || (
              <span className="text-ink-3 italic">(no comment)</span>
            )}
          </div>
          <p className="text-[10px] text-ink-3 mt-1">
            Feedback date: {feedback.feedbackDate}
          </p>
        </div>

        {/* AI verdict */}
        {isAnalyzed && (
          <div className="rounded border border-rule p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-ink-3 font-medium">AI analysis</span>
              <div className="flex items-center gap-2">
                {feedback.removable != null && (
                  <Badge
                    className={
                      feedback.removable
                        ? "bg-green-soft2 text-green-ink"
                        : "bg-bg-elev text-ink-2"
                    }
                  >
                    {feedback.removable ? "Removable" : "Not removable"}
                  </Badge>
                )}
                {feedback.removalCategory && (
                  <Badge variant="outline">
                    {feedback.removalCategory.replace(/_/g, " ")}
                  </Badge>
                )}
                {feedback.removalConfidence && (
                  <span
                    className={`text-[10px] font-semibold ${
                      feedback.removalConfidence === "HIGH"
                        ? "text-green"
                        : feedback.removalConfidence === "MEDIUM"
                          ? "text-warn"
                          : "text-danger"
                    }`}
                  >
                    {feedback.removalConfidence}
                  </span>
                )}
                {feedback.suggestedAction && (
                  <Badge
                    className={actionColors[feedback.suggestedAction] || ""}
                  >
                    {feedback.suggestedAction.replace(/_/g, " ")}
                  </Badge>
                )}
              </div>
            </div>
            {feedback.aiReasoning && (
              <p className="text-ink-2">{feedback.aiReasoning}</p>
            )}
          </div>
        )}

        {/* Removal request text */}
        {feedback.removalRequestText && (
          <div>
            <p className="text-ink-3 font-medium mb-1">
              Removal request text:
            </p>
            <div className="whitespace-pre-wrap rounded border border-rule bg-white p-3">
              {feedback.removalRequestText}
            </div>
          </div>
        )}

        {/* Public response */}
        {feedback.publicResponse && (
          <div>
            <p className="text-ink-3 font-medium mb-1">
              Suggested public response:
            </p>
            <div className="whitespace-pre-wrap rounded border border-rule bg-white p-3">
              {feedback.publicResponse}
            </div>
          </div>
        )}

        {/* Submission timestamp */}
        {feedback.removalSubmittedAt && (
          <div className="rounded bg-warn-tint p-2 text-warn-strong">
            Removal submitted at{" "}
            {new Date(feedback.removalSubmittedAt).toLocaleString()}
          </div>
        )}

        {/* Notes */}
        <div>
          <label
            htmlFor={`notes-${feedbackId}`}
            className="text-ink-3 font-medium mb-1 block"
          >
            Notes
          </label>
          <textarea
            id={`notes-${feedbackId}`}
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={handleSaveNotes}
            placeholder="Add internal notes…"
            className="w-full min-h-[60px] rounded border border-rule bg-white p-2 text-xs focus:border-blue-400 focus:outline-none"
          />
          {savingNotes && (
            <p className="text-[10px] text-ink-3 mt-1">Saving…</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={handleAnalyze}
            disabled={analyzing}
            className="text-xs"
          >
            {analyzing ? (
              <Loader2 size={12} className="animate-spin mr-1" />
            ) : (
              <RefreshCw size={12} className="mr-1" />
            )}
            {isAnalyzed ? "Re-analyze" : "Analyze with Claude"}
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={handleCopyRemoval}
            disabled={!canCopyRemoval}
            className="text-xs"
          >
            {copied ? (
              <Check size={12} className="mr-1 text-green" />
            ) : (
              <Copy size={12} className="mr-1" />
            )}
            Copy Removal Text
          </Button>

          <Button
            size="sm"
            onClick={handleMarkSubmitted}
            disabled={!canMarkSubmitted || submitting}
            className="text-xs bg-amber-600 hover:bg-amber-700"
          >
            {submitting ? (
              <Loader2 size={12} className="animate-spin mr-1" />
            ) : (
              <Send size={12} className="mr-1" />
            )}
            Mark as Submitted
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
