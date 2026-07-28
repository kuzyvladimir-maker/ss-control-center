"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  X,
  AlertTriangle,
  ClipboardCopy,
  ShieldCheck,
  ShieldX,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DefenseStrategyBadge from "@/components/claims/DefenseStrategyBadge";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Claim = any;

// Status colors removed — statusLabel() in AtozTab handles display

interface AtozDetailProps {
  claimId: string;
  onClose: () => void;
}

// Compute days until deadline from a YYYY-MM-DD string.
// Returns null if the string is missing or unparseable.
function daysUntil(deadline: string | null): number | null {
  if (!deadline) return null;
  const [y, m, d] = deadline.split("-").map((v) => parseInt(v, 10));
  if (!y || !m || !d) return null;
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

export default function AtozDetail({ claimId, onClose }: AtozDetailProps) {
  const [claim, setClaim] = useState<Claim | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);

  const fetchClaim = () => {
    setLoading(true);
    fetch(`/api/customer-hub/atoz/${claimId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const c = data.claim || data;
        setClaim(c);
        setNotesDraft(c.vladimirNotes || "");
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchClaim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimId]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      await fetch(`/api/customer-hub/atoz/${claimId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze" }),
      });
      fetchClaim();
    } catch {
      /* ignore */
    } finally {
      setAnalyzing(false);
    }
  };

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const handlePatch = async (data: Record<string, unknown>) => {
    await fetch(`/api/customer-hub/atoz/${claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    fetchClaim();
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    await handlePatch({ vladimirNotes: notesDraft });
    setSavingNotes(false);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 size={18} className="animate-spin text-ink-3 mr-2" />
          <span className="text-sm text-ink-3">Loading claim…</span>
        </CardContent>
      </Card>
    );
  }

  if (error || !claim) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <span className="text-sm text-danger">
            {error || "Claim not found"}
          </span>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X size={16} />
          </Button>
        </CardContent>
      </Card>
    );
  }

  const c = claim;
  const days = daysUntil(c.deadline);
  const isChargeback = c.claimType === "CHARGEBACK";
  const deadlineLabel = isChargeback ? "Reply-By" : "Deadline";
  const response = c.editedResponse || c.generatedResponse;
  const isLoss = c.amazonDecision === "AGAINST_US";
  const isWon =
    c.amazonDecision === "AMAZON_FUNDED" ||
    c.amazonDecision === "IN_OUR_FAVOR";
  const canAppeal = isLoss && !c.appealSubmitted;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Badge variant="outline">
            {isChargeback ? "Chargeback" : "A-to-Z"}
          </Badge>
          <span className="font-mono text-xs text-ink-2">
            {c.amazonOrderId}
          </span>
          {days !== null && days <= 3 && (
            <Badge className="bg-danger text-green-cream gap-1">
              <AlertTriangle size={10} />
              {days}d left
            </Badge>
          )}
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X size={16} />
        </Button>
      </CardHeader>

      <CardContent className="space-y-4 text-xs">
        {/* Decision banner */}
        {isWon && (
          <div className="rounded-md border border-green-soft2 bg-green-soft p-3 flex items-center gap-2">
            <ShieldCheck size={18} className="text-green shrink-0" />
            <div>
              <div className="font-semibold text-green-800">
                {c.amazonDecision === "AMAZON_FUNDED"
                  ? "Amazon funded this claim"
                  : "Decided in our favor"}
              </div>
              {c.amountSaved != null && c.amountSaved > 0 && (
                <div className="text-green-ink">
                  Saved: <strong>${c.amountSaved.toFixed(2)}</strong>
                </div>
              )}
            </div>
          </div>
        )}

        {isLoss && (
          <div className="rounded-md border border-danger bg-danger-tint p-3 flex items-start gap-2">
            <ShieldX size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold text-danger">
                Decided against us — we lost this claim
              </div>
              {c.amountCharged != null && c.amountCharged > 0 && (
                <div className="text-danger">
                  Charged: <strong>${c.amountCharged.toFixed(2)}</strong>
                </div>
              )}
              {canAppeal && (
                <div className="mt-2 text-danger text-[11px]">
                  You can appeal this decision in Amazon Seller Central.
                  Generate an appeal text below and submit it through the
                  Resolution Center.
                </div>
              )}
              {c.appealSubmitted && (
                <div className="mt-1 text-purple">
                  Appeal submitted. Waiting for Amazon review.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Order context */}
        {(c.customerName || c.product || c.orderDate) && (
          <div className="rounded bg-surface-tint p-3 space-y-1">
            <p className="text-[10px] font-semibold text-ink-3 uppercase">
              Order Details
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
              {c.customerName && (
                <div>
                  <span className="text-ink-3">Customer:</span>{" "}
                  <span className="font-medium">{c.customerName}</span>
                </div>
              )}
              {c.product && (
                <div className="col-span-2">
                  <span className="text-ink-3">Product:</span>{" "}
                  {c.product}
                </div>
              )}
              {c.orderDate && (
                <div>
                  <span className="text-ink-3">Order date:</span>{" "}
                  {c.orderDate}
                </div>
              )}
              {c.orderTotal != null && (
                <div>
                  <span className="text-ink-3">Order total:</span>{" "}
                  ${c.orderTotal.toFixed(2)}
                </div>
              )}
              {c.storeName && (
                <div>
                  <span className="text-ink-3">Store:</span>{" "}
                  {c.storeName}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Claim text (buyer's complaint) */}
        {c.claimText && (
          <div>
            <p className="text-[10px] font-semibold text-ink-3 uppercase mb-1">
              Buyer Claim Text
            </p>
            <div className="rounded bg-warn-tint border border-warn/20 p-3 text-warn-strong whitespace-pre-wrap">
              {c.claimText}
            </div>
          </div>
        )}

        {/* Shipping & Evidence */}
        <div>
          <p className="text-[10px] font-semibold text-ink-3 uppercase mb-1">
            Shipping Evidence
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
            <div>
              <span className="text-ink-3">Claim amount:</span>{" "}
              <span
                className={`font-medium ${
                  isLoss
                    ? "text-danger"
                    : isWon
                      ? "text-green"
                      : "text-ink"
                }`}
              >
                {c.amount != null ? `$${c.amount.toFixed(2)}` : "—"}
              </span>
            </div>
            <div>
              <span className="text-ink-3">Reason:</span>{" "}
              {c.claimReason || "—"}
            </div>
            <div>
              <span className="text-ink-3">{deadlineLabel}:</span>{" "}
              {c.deadline || "—"}
              {days !== null && (
                <span
                  className={`ml-1 ${
                    days <= 1
                      ? "text-danger font-bold"
                      : days <= 3
                        ? "text-danger"
                        : "text-ink-3"
                  }`}
                >
                  ({days}d)
                </span>
              )}
            </div>
            <div>
              <span className="text-ink-3">Carrier:</span>{" "}
              {c.carrier || "—"}
            </div>
            <div>
              <span className="text-ink-3">Tracking:</span>{" "}
              {c.trackingNumber ? (
                <code className="bg-bg-elev px-1 rounded">
                  {c.trackingNumber}
                </code>
              ) : (
                "—"
              )}
            </div>
            <div>
              <span className="text-ink-3">Ship date:</span>{" "}
              {c.shipDate || "—"}
            </div>
            <div>
              <span className="text-ink-3">First scan:</span>{" "}
              {c.firstScanDate || "—"}
            </div>
            <div>
              <span className="text-ink-3">Delivered:</span>{" "}
              {c.deliveredDate || "—"}
            </div>
            <div>
              <span className="text-ink-3">Shipped on time:</span>{" "}
              {c.shippedOnTime == null
                ? "—"
                : c.shippedOnTime
                  ? "Yes ✓"
                  : "No ✗"}
            </div>
            <div>
              <span className="text-ink-3">Claims Protected:</span>{" "}
              {c.claimsProtectedBadge ? (
                <span className="text-green font-medium">Yes ✓</span>
              ) : (
                "—"
              )}
            </div>
          </div>
        </div>

        {/* Strategy */}
        {c.strategyType && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-ink-3">Defense strategy:</span>
            <DefenseStrategyBadge
              strategyType={c.strategyType}
              confidence={c.strategyConfidence}
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={handleAnalyze}
            disabled={analyzing}
          >
            {analyzing ? (
              <Loader2 size={12} className="animate-spin mr-1" />
            ) : (
              <RefreshCw size={12} className="mr-1" />
            )}
            {response ? "Re-generate Response" : "Generate Response"}
          </Button>

          {canAppeal && (
            <Button
              size="sm"
              className="bg-purple hover:bg-purple"
              onClick={handleAnalyze}
              disabled={analyzing}
            >
              {analyzing ? (
                <Loader2 size={12} className="animate-spin mr-1" />
              ) : null}
              Generate Appeal
            </Button>
          )}

          {!isLoss && !isWon && c.status !== "SUBMITTED" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => handlePatch({ status: "SUBMITTED" })}
            >
              Mark as Submitted
            </Button>
          )}
        </div>

        {/* Generated response */}
        {response && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-ink-3 font-medium">
                Amazon Response (for case portal):
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleCopy(response, "amazon")}
              >
                <ClipboardCopy size={12} className="mr-1" />
                {copied === "amazon" ? "Copied!" : "Copy"}
              </Button>
            </div>
            <div className="whitespace-pre-wrap rounded border border-rule bg-white p-3">
              {response}
            </div>
          </div>
        )}

        {/* Appeal text (if loss + generated) */}
        {c.appealText && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-purple font-medium">Appeal Text:</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleCopy(c.appealText, "appeal")}
              >
                <ClipboardCopy size={12} className="mr-1" />
                {copied === "appeal" ? "Copied!" : "Copy Appeal"}
              </Button>
            </div>
            <div className="whitespace-pre-wrap rounded border border-purple bg-purple-tint p-3">
              {c.appealText}
            </div>
            {!c.appealSubmitted && (
              <Button
                size="sm"
                className="mt-2 bg-purple hover:bg-purple"
                onClick={() =>
                  handlePatch({
                    appealSubmitted: true,
                    status: "APPEALED",
                  })
                }
              >
                Mark Appeal as Submitted
              </Button>
            )}
          </div>
        )}

        {/* Notes */}
        <div>
          <p className="text-ink-3 font-medium mb-1">Notes:</p>
          <Textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={handleSaveNotes}
            rows={2}
            placeholder="Internal notes..."
            className="text-xs"
          />
          {savingNotes && (
            <span className="text-[10px] text-ink-3">Saving...</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
