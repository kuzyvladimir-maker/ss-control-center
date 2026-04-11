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
  NEW: "bg-slate-100 text-slate-600",
  ANALYZED: "bg-blue-100 text-blue-700",
  REMOVAL_SUBMITTED: "bg-amber-100 text-amber-700",
  REMOVED: "bg-green-100 text-green-700",
  DENIED: "bg-red-100 text-red-700",
  CONTACT_SENT: "bg-purple-100 text-purple-700",
  CLOSED: "bg-slate-100 text-slate-500",
};

const actionColors: Record<string, string> = {
  REQUEST_REMOVAL: "bg-green-100 text-green-700",
  CONTACT_BUYER: "bg-blue-100 text-blue-700",
  RESPOND_PUBLICLY: "bg-purple-100 text-purple-700",
  MONITOR: "bg-slate-100 text-slate-600",
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
          <Loader2 size={18} className="animate-spin text-slate-400 mr-2" />
          <span className="text-sm text-slate-500">Loading feedback…</span>
        </CardContent>
      </Card>
    );
  }

  if (!feedback) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <span className="text-sm text-red-600">
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
            <span className="text-xs text-slate-500">{feedback.store}</span>
          )}
          {feedback.amazonOrderId && (
            <span className="font-mono text-[10px] text-slate-400">
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
          <div className="rounded border border-red-200 bg-red-50 p-2 text-red-700">
            {error}
          </div>
        )}

        {/* Customer comment */}
        <div>
          <p className="text-slate-500 font-medium mb-1">Customer comment:</p>
          <div className="whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-3">
            {feedback.comments || (
              <span className="text-slate-400 italic">(no comment)</span>
            )}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">
            Feedback date: {feedback.feedbackDate}
          </p>
        </div>

        {/* AI verdict */}
        {isAnalyzed && (
          <div className="rounded border border-slate-200 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-500 font-medium">AI analysis</span>
              <div className="flex items-center gap-2">
                {feedback.removable != null && (
                  <Badge
                    className={
                      feedback.removable
                        ? "bg-green-100 text-green-700"
                        : "bg-slate-100 text-slate-600"
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
                        ? "text-green-600"
                        : feedback.removalConfidence === "MEDIUM"
                          ? "text-amber-600"
                          : "text-red-600"
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
              <p className="text-slate-600">{feedback.aiReasoning}</p>
            )}
          </div>
        )}

        {/* Removal request text */}
        {feedback.removalRequestText && (
          <div>
            <p className="text-slate-500 font-medium mb-1">
              Removal request text:
            </p>
            <div className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-3">
              {feedback.removalRequestText}
            </div>
          </div>
        )}

        {/* Public response */}
        {feedback.publicResponse && (
          <div>
            <p className="text-slate-500 font-medium mb-1">
              Suggested public response:
            </p>
            <div className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-3">
              {feedback.publicResponse}
            </div>
          </div>
        )}

        {/* Submission timestamp */}
        {feedback.removalSubmittedAt && (
          <div className="rounded bg-amber-50 p-2 text-amber-800">
            Removal submitted at{" "}
            {new Date(feedback.removalSubmittedAt).toLocaleString()}
          </div>
        )}

        {/* Notes */}
        <div>
          <label
            htmlFor={`notes-${feedbackId}`}
            className="text-slate-500 font-medium mb-1 block"
          >
            Notes
          </label>
          <textarea
            id={`notes-${feedbackId}`}
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={handleSaveNotes}
            placeholder="Add internal notes…"
            className="w-full min-h-[60px] rounded border border-slate-200 bg-white p-2 text-xs focus:border-blue-400 focus:outline-none"
          />
          {savingNotes && (
            <p className="text-[10px] text-slate-400 mt-1">Saving…</p>
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
              <Check size={12} className="mr-1 text-green-600" />
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
