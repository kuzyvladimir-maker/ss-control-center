"use client";

import { useState, useEffect } from "react";
import {
  Loader2,
  X,
  ClipboardCopy,
  Pencil,
  RefreshCw,
  Package,
  User,
  Store,
  Check,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import ResponseDeadline from "./ResponseDeadline";

const riskColors: Record<string, string> = {
  LOW: "bg-green-100 text-green-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
  CRITICAL: "bg-red-600 text-white",
};

const actionColors: Record<string, string> = {
  replacement: "bg-blue-100 text-blue-700",
  refund: "bg-orange-100 text-orange-700",
  full_refund: "bg-orange-100 text-orange-700",
  partial_refund: "bg-amber-100 text-amber-700",
  clarify: "bg-slate-100 text-slate-700",
  reassure: "bg-green-100 text-green-700",
  investigate: "bg-amber-100 text-amber-700",
  redirect_amazon: "bg-blue-100 text-blue-700",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

const trackingStatusColors: Record<string, string> = {
  delivered: "bg-green-100 text-green-700",
  in_transit: "bg-blue-100 text-blue-700",
  exception: "bg-red-100 text-red-700",
};

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  // Accept both ISO datestrings and YYYY-MM-DD shortcuts
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return s;
  }
}

function ShippingTrackingSection({ message: m }: { message: Msg }) {
  const hasAnyTracking =
    m.carrier || m.trackingNumber || m.shipDate || m.trackingStatus;

  if (!hasAnyTracking) {
    return (
      <div>
        <p className="text-[10px] font-semibold text-slate-400 uppercase mb-2">
          Shipping &amp; Tracking
        </p>
        <Badge className="bg-amber-100 text-amber-700 text-xs">
          No tracking data found
        </Badge>
      </div>
    );
  }

  const transitClass =
    m.daysInTransit != null && m.daysInTransit > 3
      ? "text-red-600 font-medium"
      : "text-slate-700";
  const lateClass =
    m.daysLate && m.daysLate > 0
      ? "text-red-600 font-medium"
      : "text-slate-700";

  return (
    <div>
      <p className="text-[10px] font-semibold text-slate-400 uppercase mb-2">
        Shipping &amp; Tracking
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className="text-slate-500">Carrier:</span>{" "}
          <span className="font-medium">{m.carrier || "—"}</span>
        </div>
        <div>
          <span className="text-slate-500">Service:</span>{" "}
          {m.service || "—"}
        </div>
        <div className="col-span-2">
          <span className="text-slate-500">Tracking #:</span>{" "}
          {m.trackingNumber ? (
            <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">
              {m.trackingNumber}
            </code>
          ) : (
            "—"
          )}
        </div>
        <div>
          <span className="text-slate-500">Status:</span>{" "}
          {m.trackingStatus ? (
            <Badge
              className={
                trackingStatusColors[m.trackingStatus] ||
                "bg-slate-100 text-slate-600"
              }
            >
              {m.trackingStatus.replace(/_/g, " ")}
            </Badge>
          ) : (
            "—"
          )}
        </div>
        <div>
          <span className="text-slate-500">Shipped:</span>{" "}
          {fmtDate(m.shipDate)}
        </div>
        <div>
          <span className="text-slate-500">Delivered:</span>{" "}
          {fmtDate(m.actualDelivery)}
        </div>
        <div>
          <span className="text-slate-500">Deliver By (EDD):</span>{" "}
          {fmtDate(m.promisedEdd)}
        </div>
        <div>
          <span className="text-slate-500">Transit Time:</span>{" "}
          <span className={transitClass}>
            {m.daysInTransit != null ? `${m.daysInTransit} days` : "—"}
          </span>
        </div>
        <div>
          <span className="text-slate-500">Days Late:</span>{" "}
          <span className={lateClass}>
            {m.daysLate != null ? m.daysLate : "—"}
          </span>
        </div>
      </div>

      {/* Badge row */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {m.boughtThroughVeeqo && (
          <Badge className="bg-blue-100 text-blue-700 text-[10px]">
            Buy Shipping (Veeqo)
          </Badge>
        )}
        {m.claimsProtected && (
          <Badge className="bg-green-100 text-green-700 text-[10px]">
            Claims Protected
          </Badge>
        )}
        {m.shippedOnTime === true && (
          <Badge className="bg-green-100 text-green-700 text-[10px]">
            Shipped On Time
          </Badge>
        )}
        {m.shippedOnTime === false && (
          <Badge className="bg-red-100 text-red-700 text-[10px]">
            Late Shipment
          </Badge>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Guardrail UI components — parse message.factCheckJson + policy heuristics
// and surface warnings, confidence, and policy guidance inline.
// ---------------------------------------------------------------------------

interface FactCheckShape {
  passed: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  mismatches: Array<{
    field: string;
    inResponse: string;
    actual: string;
    severity: "error" | "warning";
  }>;
}

function parseFactCheck(json: string | null | undefined): FactCheckShape | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") return parsed as FactCheckShape;
    return null;
  } catch {
    return null;
  }
}

function ConfidenceIndicator({
  factCheckJson,
}: {
  factCheckJson: string | null | undefined;
}) {
  const fc = parseFactCheck(factCheckJson);
  if (!fc) {
    return (
      <span className="text-[10px] text-slate-400">Not checked</span>
    );
  }
  const config = {
    HIGH: {
      color: "text-green-700 bg-green-50 border border-green-200",
      icon: "✅",
      label: "High confidence — facts verified",
    },
    MEDIUM: {
      color: "text-yellow-700 bg-yellow-50 border border-yellow-200",
      icon: "🟡",
      label: "Medium — review recommended",
    },
    LOW: {
      color: "text-red-700 bg-red-50 border border-red-200",
      icon: "🔴",
      label: "Low — manual review required",
    },
  } as const;
  const c = config[fc.confidence] || config.MEDIUM;
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded ${c.color}`}>
      {c.icon} {c.label}
    </span>
  );
}

function ResponseWarnings({
  message,
  onFix,
  fixing,
}: {
  message: Msg;
  onFix?: () => void;
  fixing?: boolean;
}) {
  const warnings: Array<{
    type: "error" | "warning" | "info";
    text: string;
  }> = [];
  const response: string = message.suggestedResponse || "";
  const lower = response.toLowerCase();
  const fc = parseFactCheck(message.factCheckJson);

  // Fact check mismatches
  if (fc && !fc.passed) {
    for (const m of fc.mismatches) {
      warnings.push({
        type: m.severity === "error" ? "error" : "warning",
        text: `Fact mismatch: Response says "${m.inResponse}" but actual data shows "${m.actual}"`,
      });
    }
  }

  // Policy-based warnings derived from the saved message state
  if (
    lower.includes("cancel") &&
    message.trackingStatus &&
    message.trackingStatus !== "pending"
  ) {
    warnings.push({
      type: "error",
      text: `Order already shipped (${message.trackingStatus}). Do not suggest cancellation.`,
    });
  }
  if (lower.includes("refund") && message.whoShouldPay === "amazon") {
    warnings.push({
      type: "info",
      text: "This case should be covered by Amazon, not seller refund. Consider redirecting to A-to-Z.",
    });
  }
  if (
    message.foodSafetyRisk &&
    /safe|fresh|good condition/.test(lower)
  ) {
    warnings.push({
      type: "error",
      text: "Do not guarantee food safety after spoilage complaint.",
    });
  }

  if (warnings.length === 0) return null;

  const palette = {
    error: "bg-red-50 text-red-800 border-red-200",
    warning: "bg-yellow-50 text-yellow-800 border-yellow-200",
    info: "bg-blue-50 text-blue-800 border-blue-200",
  } as const;

  const hasErrors = warnings.some((w) => w.type === "error");

  return (
    <div className="space-y-2 mb-2">
      {warnings.map((w, i) => (
        <div
          key={i}
          className={`text-xs px-3 py-2 rounded-md border flex items-start gap-2 ${palette[w.type]}`}
        >
          <span className="shrink-0">
            {w.type === "error" ? "⚠️" : w.type === "warning" ? "🟡" : "ℹ️"}
          </span>
          <span className="flex-1">{w.text}</span>
        </div>
      ))}
      {hasErrors && onFix && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={onFix}
            disabled={fixing}
            className="text-xs border-red-300 text-red-700 hover:bg-red-50"
          >
            {fixing ? (
              <Loader2 size={12} className="animate-spin mr-1" />
            ) : null}
            Fix to policy-compliant
          </Button>
        </div>
      )}
    </div>
  );
}

function PolicyGuidance({ message }: { message: Msg }) {
  const rules: string[] = [];

  if (message.shippingMismatch) {
    rules.push(
      `⚠️ SHIPPING MISMATCH: Customer paid for "${message.requestedShippingService || "expedited"}" but shipped via "${message.actualShippingService || "standard"}"`
    );
    rules.push('Do NOT admit mismatch directly — say "fastest available option"');
    rules.push("Do NOT suggest cancellation — order already shipped");
    rules.push("Suggest: wait for delivery → return through Amazon if needed");
    rules.push("Who pays: SELLER (our responsibility)");
  }

  if (message.trackingStatus === "in_transit") {
    rules.push("Order is in transit — do NOT suggest cancellation");
  }
  if (message.trackingStatus === "delivered") {
    rules.push("Order delivered — suggest return process if needed");
  }

  if (message.productType === "Frozen") {
    rules.push("Frozen product — do NOT ask for return (food safety)");
  }

  if (message.boughtThroughVeeqo && message.daysLate && message.daysLate > 0) {
    rules.push(
      "Buy Shipping used + late delivery → Amazon should pay (Support case)"
    );
    rules.push("Do NOT use SAFE-T for carrier delay");
  }

  if (message.whoShouldPay === "amazon") {
    rules.push("Redirect to Amazon CS or A-to-Z for resolution");
    rules.push("Do NOT offer seller refund");
  }

  if (
    typeof message.customerMessage === "string" &&
    message.customerMessage.toLowerCase().includes("cancel") &&
    message.trackingStatus === "in_transit"
  ) {
    rules.push(
      "Customer wants to cancel but order shipped — explain and redirect to Amazon CS"
    );
  }

  if (rules.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <h4 className="text-[10px] font-semibold text-amber-700 uppercase mb-1">
        Policy Guidance
      </h4>
      <ul className="text-xs text-amber-900 space-y-1">
        {rules.map((r, i) => (
          <li key={i}>• {r}</li>
        ))}
      </ul>
    </div>
  );
}

interface MessageDetailProps {
  messageId: string;
  onClose: () => void;
}

export default function MessageDetail({
  messageId,
  onClose,
}: MessageDetailProps) {
  const [message, setMessage] = useState<Msg | null>(null);
  const [history, setHistory] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentFlash, setSentFlash] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [rewriteMenuOpen, setRewriteMenuOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [kbDialogOpen, setKbDialogOpen] = useState(false);
  const [kbReasoning, setKbReasoning] = useState("");
  const [kbOutcome, setKbOutcome] = useState<
    "positive" | "negative" | "neutral"
  >("positive");
  const [kbTags, setKbTags] = useState("");
  const [kbSaving, setKbSaving] = useState(false);
  const [kbSavedFlash, setKbSavedFlash] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);

  const fetchDetail = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/customer-hub/messages/${messageId}`);
      const data = await res.json();
      setMessage(data.message);
      setHistory(data.history || []);
      setEditText(
        data.message?.editedResponse ||
          data.message?.suggestedResponse ||
          ""
      );
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      await fetch(`/api/customer-hub/messages/${messageId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze" }),
      });
      await fetchDetail();
    } catch {
      /* ignore */
    } finally {
      setAnalyzing(false);
    }
  };

  const handleCopy = () => {
    const text = editMode
      ? editText
      : message?.editedResponse || message?.suggestedResponse || "";
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveEdit = async () => {
    await fetch(`/api/customer-hub/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editedResponse: editText }),
    });
    setEditMode(false);
    await fetchDetail();
  };

  const handleStatusChange = async (newStatus: "RESOLVED" | "NEW") => {
    setStatusUpdating(true);
    setStatusError(null);
    try {
      const body: Record<string, unknown> = { status: newStatus };
      // Clear resolution when reopening
      if (newStatus === "NEW") body.resolution = null;
      const res = await fetch(`/api/customer-hub/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await fetchDetail();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setStatusUpdating(false);
    }
  };

  const handleSaveToKB = async () => {
    if (!message) return;
    if (!kbReasoning.trim()) {
      setKbError("Reasoning is required — explain why this response was correct");
      return;
    }
    setKbSaving(true);
    setKbError(null);
    try {
      const correctResponse =
        message.editedResponse ||
        message.suggestedResponse ||
        "";
      const scenario =
        (message.problemTypeName || message.problemType || "Customer case") +
        (message.trackingStatus ? ` — ${message.trackingStatus}` : "") +
        (message.shippingMismatch ? " — shipping mismatch" : "");
      const res = await fetch("/api/customer-hub/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problemType: message.problemType || "T18",
          scenario,
          customerSaid: (message.customerMessage || "").substring(0, 500),
          trackingStatus: message.trackingStatus,
          shippingMismatch: !!message.shippingMismatch,
          productType: message.productType,
          correctAction: message.action || "investigate",
          correctResponse,
          reasoning: kbReasoning,
          whoShouldPay: message.whoShouldPay,
          outcome: kbOutcome,
          tags: kbTags.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setKbSavedFlash(true);
      setTimeout(() => {
        setKbSavedFlash(false);
        setKbDialogOpen(false);
        setKbReasoning("");
        setKbTags("");
      }, 1500);
    } catch (err) {
      setKbError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setKbSaving(false);
    }
  };

  const handleFix = async () => {
    setFixing(true);
    try {
      const res = await fetch(`/api/customer-hub/messages/${messageId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fix" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await fetchDetail();
    } catch (err) {
      setSendError(
        err instanceof Error ? err.message : "Fix failed"
      );
    } finally {
      setFixing(false);
    }
  };

  const handleRewrite = async (style: string) => {
    setRewriting(style);
    setRewriteMenuOpen(false);
    try {
      const res = await fetch(`/api/customer-hub/messages/${messageId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rewrite", style }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await fetchDetail();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Rewrite failed");
    } finally {
      setRewriting(null);
    }
  };

  const handleMarkRespondedInSC = async () => {
    if (!message) return;
    const ok = window.confirm(
      "Mark as responded via Amazon Seller Central?\n\nThis will move the message to Sent. Use only if you already sent the reply directly from Seller Central."
    );
    if (!ok) return;

    setStatusUpdating(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/customer-hub/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "SENT",
          responseSentVia: "SELLER_CENTRAL",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setSentFlash(true);
      setTimeout(() => setSentFlash(false), 3000);
      await fetchDetail();
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : "Failed to mark responded"
      );
    } finally {
      setStatusUpdating(false);
    }
  };

  const handleSend = async () => {
    if (!message) return;
    const text = message.editedResponse || message.suggestedResponse || "";
    if (!text) {
      setSendError("No response text to send");
      return;
    }
    const ok = window.confirm(
      `Send this response to ${message.customerName || "the customer"} via SP-API Messaging?\n\nThis cannot be undone.`
    );
    if (!ok) return;

    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(
        `/api/customer-hub/messages/${messageId}/send`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSentFlash(true);
      setTimeout(() => setSentFlash(false), 3000);
      await fetchDetail();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-slate-400 mr-2" />
          <span className="text-sm text-slate-500">Loading...</span>
        </CardContent>
      </Card>
    );
  }

  if (!message) return null;
  const m = message;
  const responseText =
    m.editedResponse || m.suggestedResponse || "";

  return (
    <Card className="border-2 border-blue-200">
      <CardContent className="py-4 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Store size={12} /> {m.storeName}
              {m.amazonOrderId && (
                <>
                  <span className="text-slate-300">|</span>
                  <Package size={12} /> {m.amazonOrderId}
                </>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <User size={12} className="text-slate-400" />
              <span className="font-medium">{m.customerName || "Customer"}</span>
              {m.product && (
                <>
                  <span className="text-slate-300">|</span>
                  <span className="text-slate-500">{m.product}</span>
                </>
              )}
              {m.productType && (
                <Badge variant="outline" className="text-[9px]">
                  {m.productType}
                </Badge>
              )}
            </div>
            {m.problemType === "T20" && (
              <div className="flex items-center gap-2 text-xs">
                <Badge className="bg-red-600 text-white text-[9px]">
                  Repeat complaint
                </Badge>
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="p-1">
            <X size={16} />
          </Button>
        </div>

        {/* Status row — deadline + resolve / reopen controls */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {m.status !== "SENT" && m.status !== "RESOLVED" ? (
            <>
              <ResponseDeadline
                createdAt={m.receivedAt || m.createdAt}
                status={m.status}
              />
              <span className="text-slate-400">
                · Amazon requires response within 24 hours
              </span>
              <div className="ml-auto">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleStatusChange("RESOLVED")}
                  disabled={statusUpdating}
                  className="text-xs"
                >
                  {statusUpdating ? (
                    <Loader2 size={12} className="animate-spin mr-1" />
                  ) : (
                    <Check size={12} className="mr-1" />
                  )}
                  Mark as Resolved
                </Button>
              </div>
            </>
          ) : (
            <>
              <Badge className="bg-green-100 text-green-700">
                {m.status === "SENT" ? "Sent" : "Resolved"}
              </Badge>
              {m.resolution === "auto_resolved_gmail_thread" && (
                <span className="text-[10px] text-slate-500">
                  · auto-resolved (Gmail thread has a reply)
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setKbDialogOpen(true)}
                  className="text-xs"
                >
                  📚 Save to KB
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleStatusChange("NEW")}
                  disabled={statusUpdating}
                  className="text-xs"
                >
                  {statusUpdating ? (
                    <Loader2 size={12} className="animate-spin mr-1" />
                  ) : (
                    <RefreshCw size={12} className="mr-1" />
                  )}
                  Reopen
                </Button>
              </div>
            </>
          )}
        </div>
        {statusError && (
          <p className="text-xs text-red-600">{statusError}</p>
        )}

        <Separator />

        {/* Shipping & Tracking */}
        <ShippingTrackingSection message={m} />

        {/* Policy Guidance — warnings based on tracking/product/carrier */}
        <PolicyGuidance message={m} />

        <Separator />

        {/* Customer message */}
        <div>
          <p className="text-[10px] font-semibold text-slate-400 uppercase mb-1">
            Customer Message
          </p>
          <div className="rounded bg-slate-50 p-3 text-sm text-slate-700 whitespace-pre-wrap">
            {m.customerMessage || "No message text"}
          </div>
        </div>

        {/* Analysis */}
        {m.status === "NEW" && !analyzing && (
          <Button onClick={handleAnalyze} className="bg-blue-600 hover:bg-blue-700 w-full">
            Analyze with AI
          </Button>
        )}

        {analyzing && (
          <div className="flex items-center justify-center py-4">
            <Loader2 size={16} className="animate-spin text-blue-500 mr-2" />
            <span className="text-xs text-slate-500">Analyzing with Claude...</span>
          </div>
        )}

        {m.problemType && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold text-slate-400 uppercase">
                AI Analysis
              </p>
              <ConfidenceIndicator factCheckJson={m.factCheckJson} />
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-slate-500">Type:</span>{" "}
                <span className="font-mono">{m.problemType}</span>{" "}
                <span className="text-slate-500">{m.problemTypeName}</span>
              </div>
              <div>
                <span className="text-slate-500">Risk:</span>{" "}
                <Badge className={riskColors[m.riskLevel] || ""}>
                  {m.riskLevel}
                </Badge>
              </div>
              <div>
                <span className="text-slate-500">Action:</span>{" "}
                <Badge className={actionColors[m.action] || "bg-slate-100 text-slate-600"}>
                  {m.action}
                </Badge>
              </div>
              <div>
                <span className="text-slate-500">Who pays:</span>{" "}
                <span className="font-medium">{m.whoShouldPay}</span>
              </div>
              {m.internalAction && m.internalAction !== "none" && (
                <div className="col-span-2">
                  <span className="text-slate-500">Internal:</span>{" "}
                  <span className="text-amber-600">{m.internalAction}</span>
                </div>
              )}
              {m.foodSafetyRisk && (
                <div className="col-span-2 text-red-600 font-medium">
                  Food safety risk detected
                </div>
              )}
            </div>
          </div>
        )}

        {/* Auto-fix banner — shows when validator rewrote the response */}
        {responseText &&
          typeof m.reasoning === "string" &&
          m.reasoning.includes("[AUTO-FIXED:") && (
            <div className="text-xs px-3 py-2 rounded-md border border-green-200 bg-green-50 text-green-800 flex items-start gap-2 mb-2">
              <span className="shrink-0">🔧</span>
              <span>
                Response was automatically corrected for policy compliance.
              </span>
            </div>
          )}

        {/* Guardrail warnings: fact-check mismatches + policy red flags */}
        {responseText && (
          <ResponseWarnings
            message={m}
            onFix={handleFix}
            fixing={fixing}
          />
        )}

        {/* Suggested response */}
        {responseText && (
          <div>
            <p className="text-[10px] font-semibold text-slate-400 uppercase mb-1">
              Suggested Response
            </p>
            {editMode ? (
              <div className="space-y-2">
                <Textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={8}
                  className="text-sm"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveEdit}>
                    <Check size={12} className="mr-1" /> Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditMode(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded bg-slate-50 p-3 text-sm text-slate-700 whitespace-pre-wrap">
                {m.editedResponse || m.suggestedResponse}
              </div>
            )}

            <div className="flex items-center gap-2 mt-2">
              <Button variant="outline" size="sm" onClick={handleCopy}>
                <ClipboardCopy size={12} className="mr-1" />
                {copied ? "Copied!" : "Copy"}
              </Button>
              {!editMode && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditMode(true)}
                >
                  <Pencil size={12} className="mr-1" /> Edit
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleAnalyze}
                disabled={analyzing}
              >
                {analyzing ? (
                  <Loader2 size={12} className="animate-spin mr-1" />
                ) : (
                  <RefreshCw size={12} className="mr-1" />
                )}
                Re-analyze
              </Button>
              <div className="relative">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRewriteMenuOpen((o) => !o)}
                  disabled={rewriting !== null}
                >
                  {rewriting !== null ? (
                    <Loader2 size={12} className="animate-spin mr-1" />
                  ) : null}
                  Rewrite ▾
                </Button>
                {rewriteMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-10 w-52 rounded-md border border-slate-200 bg-white shadow-lg text-xs">
                    {[
                      { id: "polite", label: "More polite" },
                      { id: "amazon_safe", label: "Amazon-safe" },
                      { id: "shorter", label: "Shorter" },
                      { id: "no_refund", label: "No refund language" },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => handleRewrite(opt.id)}
                        className="block w-full text-left px-3 py-2 hover:bg-slate-50 first:rounded-t-md last:rounded-b-md"
                      >
                        {opt.label}
                        {rewriting === opt.id && " …"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {m.status !== "SENT" && m.status !== "RESOLVED" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleMarkRespondedInSC}
                  disabled={statusUpdating}
                  className="ml-auto"
                  title="Use this if you already replied to the customer directly in Amazon Seller Central"
                >
                  {statusUpdating ? (
                    <Loader2 size={12} className="animate-spin mr-1" />
                  ) : (
                    <Check size={12} className="mr-1" />
                  )}
                  Responded in Seller Central
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleSend}
                disabled={sending || m.status === "SENT" || m.status === "RESOLVED"}
                className={`${m.status !== "SENT" && m.status !== "RESOLVED" ? "" : "ml-auto"} bg-blue-600 hover:bg-blue-700`}
              >
                {sending ? (
                  <Loader2 size={12} className="animate-spin mr-1" />
                ) : null}
                {m.status === "SENT" || m.status === "RESOLVED"
                  ? "Already sent"
                  : "Send via SP-API"}
              </Button>
            </div>
            {sendError && (
              <p className="text-xs text-red-600 mt-2">{sendError}</p>
            )}
            {sentFlash && (
              <p className="text-xs text-green-600 mt-2">
                ✓ Sent via SP-API Messaging
              </p>
            )}
          </div>
        )}

        {/* Conversation history */}
        {history.length > 0 && (
          <div>
            <Separator />
            <p className="text-[10px] font-semibold text-slate-400 uppercase mt-3 mb-2">
              Conversation History ({history.length + 1} messages)
            </p>
            <div className="space-y-1.5">
              {history.map((h) => (
                <div
                  key={h.id}
                  className={`rounded px-2.5 py-1.5 text-xs ${
                    h.direction === "incoming"
                      ? "bg-slate-50 text-slate-700"
                      : "bg-blue-50 text-blue-700"
                  }`}
                >
                  <span className="text-[10px] text-slate-400">
                    [{new Date(h.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}]{" "}
                    {h.direction === "incoming" ? "CUSTOMER" : "OUR REPLY"}:
                  </span>{" "}
                  {(h.customerMessage || h.suggestedResponse || "").substring(0, 150)}
                  {(h.customerMessage || "").length > 150 ? "..." : ""}
                </div>
              ))}
              <div className="rounded px-2.5 py-1.5 text-xs bg-yellow-50 text-yellow-700 border border-yellow-200">
                <span className="text-[10px] text-yellow-500">
                  [Current] CUSTOMER:
                </span>{" "}
                {(m.customerMessage || "").substring(0, 150)}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
