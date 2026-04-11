"use client";

import { useEffect, useState } from "react";
import { Loader2, X, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DefenseStrategyBadge from "@/components/claims/DefenseStrategyBadge";

interface Claim {
  id: string;
  amazonOrderId: string;
  claimType: string;
  claimReason: string | null;
  amount: number | null;
  deadline: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  shipDate: string | null;
  firstScanDate: string | null;
  deliveredDate: string | null;
  shippedOnTime: boolean | null;
  claimsProtectedBadge: boolean | null;
  strategyType: string | null;
  strategyConfidence: string | null;
  generatedResponse: string | null;
  editedResponse: string | null;
  status: string;
  amazonDecision: string | null;
  vladimirNotes: string | null;
  createdAt: string;
}

const statusColors: Record<string, string> = {
  NEW: "bg-red-100 text-red-700",
  EVIDENCE_GATHERED: "bg-amber-100 text-amber-700",
  RESPONSE_READY: "bg-blue-100 text-blue-700",
  SUBMITTED: "bg-green-100 text-green-700",
  DECIDED: "bg-slate-100 text-slate-700",
  APPEALED: "bg-purple-100 text-purple-700",
  CLOSED: "bg-slate-100 text-slate-500",
};

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

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/claims/atoz/${claimId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setClaim(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [claimId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 size={18} className="animate-spin text-slate-400 mr-2" />
          <span className="text-sm text-slate-500">Loading claim…</span>
        </CardContent>
      </Card>
    );
  }

  if (error || !claim) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <span className="text-sm text-red-600">
            {error || "Claim not found"}
          </span>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X size={16} />
          </Button>
        </CardContent>
      </Card>
    );
  }

  const days = daysUntil(claim.deadline);
  const isChargeback = claim.claimType === "CHARGEBACK";
  const deadlineLabel = isChargeback ? "Reply-By" : "Deadline";
  const response = claim.editedResponse || claim.generatedResponse;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Badge variant="outline">
            {isChargeback ? "Chargeback" : "A-to-Z"}
          </Badge>
          <span className="font-mono text-xs text-slate-600">
            {claim.amazonOrderId}
          </span>
          <Badge className={statusColors[claim.status] || ""}>
            {claim.status}
          </Badge>
          {days !== null && days <= 3 && (
            <Badge className="bg-red-600 text-white gap-1">
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
        {/* Facts grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
          <div>
            <span className="text-slate-500">Reason:</span>{" "}
            {claim.claimReason || "—"}
          </div>
          <div>
            <span className="text-slate-500">Amount:</span>{" "}
            <span className="font-medium text-slate-800">
              {claim.amount != null ? `$${claim.amount.toFixed(2)}` : "—"}
            </span>
          </div>
          <div>
            <span className="text-slate-500">{deadlineLabel}:</span>{" "}
            {claim.deadline || "—"}
            {days !== null && (
              <span
                className={`ml-1 ${
                  days <= 1
                    ? "text-red-600 font-bold"
                    : days <= 3
                      ? "text-red-600"
                      : "text-slate-400"
                }`}
              >
                ({days}d)
              </span>
            )}
          </div>
          <div>
            <span className="text-slate-500">Carrier:</span>{" "}
            {claim.carrier || "—"}
          </div>
          <div>
            <span className="text-slate-500">Tracking:</span>{" "}
            {claim.trackingNumber ? (
              <code className="bg-slate-100 px-1 rounded">
                {claim.trackingNumber}
              </code>
            ) : (
              "—"
            )}
          </div>
          <div>
            <span className="text-slate-500">Ship date:</span>{" "}
            {claim.shipDate || "—"}
          </div>
          <div>
            <span className="text-slate-500">First scan:</span>{" "}
            {claim.firstScanDate || "—"}
          </div>
          <div>
            <span className="text-slate-500">Delivered:</span>{" "}
            {claim.deliveredDate || "—"}
          </div>
          <div>
            <span className="text-slate-500">Shipped on time:</span>{" "}
            {claim.shippedOnTime == null
              ? "—"
              : claim.shippedOnTime
                ? "Yes"
                : "No"}
          </div>
        </div>

        {/* Strategy */}
        {claim.strategyType && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-slate-500">Defense strategy:</span>
            <DefenseStrategyBadge
              strategyType={claim.strategyType}
              confidence={claim.strategyConfidence}
            />
          </div>
        )}

        {/* Generated / edited response */}
        {response && (
          <div>
            <p className="text-slate-500 font-medium mb-1">
              {claim.editedResponse ? "Edited Response" : "Generated Response"}:
            </p>
            <div className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-3">
              {response}
            </div>
          </div>
        )}

        {/* Notes */}
        {claim.vladimirNotes && (
          <div className="rounded bg-amber-50 p-2 text-amber-800">
            <strong>Notes:</strong> {claim.vladimirNotes}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
