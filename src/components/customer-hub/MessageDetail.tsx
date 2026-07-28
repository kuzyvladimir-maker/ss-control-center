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
  LOW: "bg-green-soft2 text-green-ink",
  MEDIUM: "bg-warn-tint text-warn-strong",
  HIGH: "bg-danger-tint text-danger",
  CRITICAL: "bg-danger text-green-cream",
};

const actionColors: Record<string, string> = {
  replacement: "bg-green-soft2 text-green-deep",
  refund: "bg-warn-tint text-warn-strong",
  full_refund: "bg-warn-tint text-warn-strong",
  partial_refund: "bg-warn-tint text-warn-strong",
  clarify: "bg-bg-elev text-ink",
  reassure: "bg-green-soft2 text-green-ink",
  investigate: "bg-warn-tint text-warn-strong",
  redirect_amazon: "bg-green-soft2 text-green-deep",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

const trackingStatusColors: Record<string, string> = {
  delivered: "bg-green-soft2 text-green-ink",
  in_transit: "bg-green-soft2 text-green-deep",
  exception: "bg-danger-tint text-danger",
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
        <p className="text-[10px] font-semibold text-ink-3 uppercase mb-2">
          Shipping &amp; Tracking
        </p>
        <Badge className="bg-warn-tint text-warn-strong text-xs">
          No tracking data found
        </Badge>
      </div>
    );
  }

  const transitClass =
    m.daysInTransit != null && m.daysInTransit > 3
      ? "text-danger font-medium"
      : "text-ink";
  const lateClass =
    m.daysLate && m.daysLate > 0
      ? "text-danger font-medium"
      : "text-ink";

  return (
    <div>
      <p className="text-[10px] font-semibold text-ink-3 uppercase mb-2">
        Shipping &amp; Tracking
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className="text-ink-3">Carrier:</span>{" "}
          <span className="font-medium">{m.carrier || "—"}</span>
        </div>
        <div>
          <span className="text-ink-3">Service:</span>{" "}
          {m.service || "—"}
        </div>
        <div className="col-span-2">
          <span className="text-ink-3">Tracking #:</span>{" "}
          {m.trackingNumber ? (
            <code className="rounded bg-bg-elev px-1 font-mono text-[11px]">
              {m.trackingNumber}
            </code>
          ) : (
            "—"
          )}
        </div>
        <div>
          <span className="text-ink-3">Status:</span>{" "}
          {m.trackingStatus ? (
            <Badge
              className={
                trackingStatusColors[m.trackingStatus] ||
                "bg-bg-elev text-ink-2"
              }
            >
              {m.trackingStatus.replace(/_/g, " ")}
            </Badge>
          ) : (
            "—"
          )}
        </div>
        <div>
          <span className="text-ink-3">Shipped:</span>{" "}
          {fmtDate(m.shipDate)}
        </div>
        <div>
          <span className="text-ink-3">Delivered:</span>{" "}
          {fmtDate(m.actualDelivery)}
        </div>
        <div>
          <span className="text-ink-3">Deliver By (EDD):</span>{" "}
          {fmtDate(m.promisedEdd)}
        </div>
        <div>
          <span className="text-ink-3">Transit Time:</span>{" "}
          <span className={transitClass}>
            {m.daysInTransit != null ? `${m.daysInTransit} days` : "—"}
          </span>
        </div>
        <div>
          <span className="text-ink-3">Days Late:</span>{" "}
          <span className={lateClass}>
            {m.daysLate != null ? m.daysLate : "—"}
          </span>
        </div>
      </div>

      {/* Badge row */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {m.boughtThroughVeeqo && (
          <Badge className="bg-green-soft2 text-green-deep text-[10px]">
            Buy Shipping (Veeqo)
          </Badge>
        )}
        {m.claimsProtected && (
          <Badge className="bg-green-soft2 text-green-ink text-[10px]">
            Claims Protected
          </Badge>
        )}
        {m.shippedOnTime === true && (
          <Badge className="bg-green-soft2 text-green-ink text-[10px]">
            Shipped On Time
          </Badge>
        )}
        {m.shippedOnTime === false && (
          <Badge className="bg-danger-tint text-danger text-[10px]">
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
      <span className="text-[10px] text-ink-3">Not checked</span>
    );
  }
  const config = {
    HIGH: {
      color: "text-green-ink bg-green-soft border border-green-soft2",
      icon: "✅",
      label: "High confidence — facts verified",
    },
    MEDIUM: {
      color: "text-warn-strong bg-warn-tint border border-warn-strong",
      icon: "🟡",
      label: "Medium — review recommended",
    },
    LOW: {
      color: "text-danger bg-danger-tint border border-danger/20",
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
    error: "bg-danger-tint text-danger border-danger/20",
    warning: "bg-warn-tint text-warn-strong border-warn-strong",
    info: "bg-green-soft text-green-ink border-green-soft2",
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
            className="text-xs border-danger text-danger hover:bg-danger-tint"
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
    <div className="rounded-lg border border-warn/20 bg-warn-tint p-3">
      <h4 className="text-[10px] font-semibold text-warn-strong uppercase mb-1">
        Policy Guidance
      </h4>
      <ul className="text-xs text-warn-strong space-y-1">
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
  // Russian working copy of the edited response. The English textarea
  // (`editText`) remains the canonical value that gets saved as
  // `editedResponse` and sent to Amazon. The Russian textarea is a working
  // language for Vladimir: typing in either column and blurring triggers
  // a translation of the other column so both stay in sync.
  const [editTextRu, setEditTextRu] = useState("");
  const [translatingEn, setTranslatingEn] = useState(false);
  const [translatingRu, setTranslatingRu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  // Send-error state — can be a red error (auth/role/config) or a
  // yellow "messaging closed" hint (Amazon gating the action per-order).
  // The sender endpoint returns messagingClosed:true when the order is
  // outside Amazon's buyer-seller-messaging window or the specific
  // action is not in the allowed list — that's operational, not a bug.
  const [sendError, setSendError] = useState<{
    message: string;
    messagingClosed?: boolean;
    allowedActions?: string[];
  } | null>(null);
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
      setEditTextRu(
        data.message?.editedResponseRu ||
          data.message?.suggestedResponseRu ||
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
      body: JSON.stringify({
        editedResponse: editText,
        editedResponseRu: editTextRu || null,
      }),
    });
    setEditMode(false);
    await fetchDetail();
  };

  // Translate the English column into Russian and write the result into
  // `editTextRu`. Triggered on blur of the EN textarea when the operator
  // has changed the text. No-op if translator fails.
  const syncRuFromEn = async () => {
    const text = editText.trim();
    if (!text) {
      setEditTextRu("");
      return;
    }
    setTranslatingRu(true);
    try {
      const res = await fetch(
        `/api/customer-hub/messages/${messageId}/translate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, direction: "en-ru" }),
        }
      );
      const data = await res.json();
      if (res.ok && typeof data.translation === "string") {
        setEditTextRu(data.translation);
      }
    } catch (err) {
      console.warn("[MessageDetail] EN→RU translation failed:", err);
    } finally {
      setTranslatingRu(false);
    }
  };

  // Translate the Russian column into English. The EN result becomes the
  // canonical `editText` and will be saved as `editedResponse` on Save.
  const syncEnFromRu = async () => {
    const text = editTextRu.trim();
    if (!text) return;
    setTranslatingEn(true);
    try {
      const res = await fetch(
        `/api/customer-hub/messages/${messageId}/translate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, direction: "ru-en" }),
        }
      );
      const data = await res.json();
      if (res.ok && typeof data.translation === "string") {
        setEditText(data.translation);
      }
    } catch (err) {
      console.warn("[MessageDetail] RU→EN translation failed:", err);
    } finally {
      setTranslatingEn(false);
    }
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
      setSendError({
        message: err instanceof Error ? err.message : "Fix failed",
      });
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
      setSendError({
        message: err instanceof Error ? err.message : "Rewrite failed",
      });
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
      setSendError({ message: "No response text to send" });
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
        setSendError({
          message: data.error || `HTTP ${res.status}`,
          messagingClosed: data.messagingClosed === true,
          allowedActions: Array.isArray(data.allowedActions)
            ? data.allowedActions
            : undefined,
        });
        return;
      }
      setSentFlash(true);
      setTimeout(() => setSentFlash(false), 3000);
      await fetchDetail();
    } catch (err) {
      setSendError({
        message: err instanceof Error ? err.message : "Send failed",
      });
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-ink-3 mr-2" />
          <span className="text-sm text-ink-3">Loading...</span>
        </CardContent>
      </Card>
    );
  }

  if (!message) return null;
  const m = message;
  const responseText =
    m.editedResponse || m.suggestedResponse || "";

  return (
    <Card className="border-2 border-green-soft2">
      <CardContent className="py-4 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-ink-3">
              <Store size={12} /> {m.storeName}
              {m.amazonOrderId && (
                <>
                  <span className="text-ink-4">|</span>
                  <Package size={12} /> {m.amazonOrderId}
                </>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <User size={12} className="text-ink-3" />
              <span className="font-medium">{m.customerName || "Customer"}</span>
              {m.product && (
                <>
                  <span className="text-ink-4">|</span>
                  <span className="text-ink-3">{m.product}</span>
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
                <Badge className="bg-danger text-green-cream text-[9px]">
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
              <span className="text-ink-3">
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
              <Badge className="bg-green-soft2 text-green-ink">
                {m.status === "SENT" ? "Sent" : "Resolved"}
              </Badge>
              {m.resolution === "auto_resolved_gmail_thread" && (
                <span className="text-[10px] text-ink-3">
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
          <p className="text-xs text-danger">{statusError}</p>
        )}

        <Separator />

        {/* Shipping & Tracking */}
        <ShippingTrackingSection message={m} />

        {/* Policy Guidance — warnings based on tracking/product/carrier */}
        <PolicyGuidance message={m} />

        <Separator />

        {/* Customer message — bilingual (EN canonical | RU working copy).
            Both are read-only; the RU column is auto-translated on sync
            and back-filled on re-analyze. */}
        <div>
          <p className="text-[10px] font-semibold text-ink-3 uppercase mb-1">
            Customer Message
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <p className="text-[9px] font-semibold text-ink-3 uppercase mb-1">
                🇬🇧 English
              </p>
              <div className="rounded bg-surface-tint p-3 text-sm text-ink whitespace-pre-wrap min-h-[4rem]">
                {m.customerMessage || "No message text"}
              </div>
            </div>
            <div>
              <p className="text-[9px] font-semibold text-ink-3 uppercase mb-1">
                🇷🇺 Русский
              </p>
              <div className="rounded bg-surface-tint p-3 text-sm text-ink whitespace-pre-wrap min-h-[4rem]">
                {m.customerMessageRu ||
                  (m.customerMessage ? (
                    <span className="text-ink-3 italic">
                      Перевод недоступен (переведётся при следующем Re-analyze)
                    </span>
                  ) : (
                    "Нет текста"
                  ))}
              </div>
            </div>
          </div>
        </div>

        {/* Analysis */}
        {m.status === "NEW" && !analyzing && (
          <Button onClick={handleAnalyze} className="bg-green hover:bg-green-deep w-full">
            Analyze with AI
          </Button>
        )}

        {analyzing && (
          <div className="flex items-center justify-center py-4">
            <Loader2 size={16} className="animate-spin text-green-mid mr-2" />
            <span className="text-xs text-ink-3">Analyzing with Claude...</span>
          </div>
        )}

        {m.problemType && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold text-ink-3 uppercase">
                AI Analysis
              </p>
              <ConfidenceIndicator factCheckJson={m.factCheckJson} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-ink-3">Type:</span>{" "}
                <span className="font-mono">{m.problemType}</span>{" "}
                <span className="text-ink-3">{m.problemTypeName}</span>
              </div>
              <div>
                <span className="text-ink-3">Risk:</span>{" "}
                <Badge className={riskColors[m.riskLevel] || ""}>
                  {m.riskLevel}
                </Badge>
              </div>
              <div>
                <span className="text-ink-3">Action:</span>{" "}
                <Badge className={actionColors[m.action] || "bg-bg-elev text-ink-2"}>
                  {m.action}
                </Badge>
              </div>
              <div>
                <span className="text-ink-3">Who pays:</span>{" "}
                <span className="font-medium">{m.whoShouldPay}</span>
              </div>
              {m.internalAction && m.internalAction !== "none" && (
                <div className="col-span-2">
                  <span className="text-ink-3">Internal:</span>{" "}
                  <span className="text-warn">{m.internalAction}</span>
                </div>
              )}
              {m.foodSafetyRisk && (
                <div className="col-span-2 text-danger font-medium">
                  Food safety risk detected
                </div>
              )}
            </div>
          </div>
        )}

        {/* Auto-fix banner — shows when validator rewrote the response
            via the manual Fix button */}
        {responseText &&
          typeof m.reasoning === "string" &&
          m.reasoning.includes("[AUTO-FIXED:") && (
            <div className="text-xs px-3 py-2 rounded-md border border-green-soft2 bg-green-soft text-green-800 flex items-start gap-2 mb-2">
              <span className="shrink-0">🔧</span>
              <span>
                Response was corrected for policy compliance via Fix button.
              </span>
            </div>
          )}

        {/* Supplier reorder banner — model decided action=replacement and
            wrote a structured supplierReorderNote. Vladimir is a reseller
            with no inventory, so every replacement requires a clone order
            in Veeqo. Phase 2 will auto-create via Veeqo API; for now this
            banner is the explicit handoff to the operator. */}
        {m.supplierReorderNote && (
          <div className="text-xs px-3 py-2 rounded-md border border-info bg-green-soft text-green-deep flex items-start gap-2 mb-2">
            <span className="shrink-0">🛒</span>
            <div className="flex-1">
              <div className="font-semibold mb-0.5">
                Supplier reorder required
              </div>
              <div className="text-green-ink whitespace-pre-wrap font-mono text-[11px]">
                {m.supplierReorderNote}
              </div>
              <div className="text-[10px] text-green-deep mt-1">
                Action needed: clone this order in Veeqo with the note above.
                Phase 2 will automate via Veeqo API.
              </div>
            </div>
          </div>
        )}

        {/* Needs-review banner — violation(s) detected but NOT auto-fixed.
            Operator should review the original model output, edit, or
            trigger the Fix button. */}
        {responseText &&
          typeof m.reasoning === "string" &&
          m.reasoning.includes("[NEEDS REVIEW:") && (
            <div className="text-xs px-3 py-2 rounded-md border border-warn/30 bg-warn-tint text-warn-strong flex items-start gap-2 mb-2">
              <span className="shrink-0">⚠️</span>
              <div>
                <div className="font-semibold mb-0.5">
                  Needs review — policy violation detected
                </div>
                <div className="text-warn-strong">
                  {m.reasoning
                    .match(/\[NEEDS REVIEW:([^\]]+)\]/)?.[1]
                    ?.trim() || "See reasoning for details."}
                </div>
              </div>
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

        {/* Suggested response — bilingual editor. English is canonical
            (what gets sent to the buyer); Russian is a working copy.
            Editing one column and blurring auto-translates the other. */}
        {responseText && (
          <div>
            <p className="text-[10px] font-semibold text-ink-3 uppercase mb-1">
              Suggested Response
            </p>
            {editMode ? (
              <div className="space-y-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[9px] font-semibold text-ink-3 uppercase">
                        🇬🇧 English (canonical)
                      </p>
                      {translatingEn && (
                        <span className="text-[9px] text-ink-3 flex items-center gap-1">
                          <Loader2 size={10} className="animate-spin" />
                          translating…
                        </span>
                      )}
                    </div>
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onBlur={syncRuFromEn}
                      rows={10}
                      className="text-sm"
                      disabled={translatingEn}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[9px] font-semibold text-ink-3 uppercase">
                        🇷🇺 Русский (рабочий)
                      </p>
                      {translatingRu && (
                        <span className="text-[9px] text-ink-3 flex items-center gap-1">
                          <Loader2 size={10} className="animate-spin" />
                          перевод…
                        </span>
                      )}
                    </div>
                    <Textarea
                      value={editTextRu}
                      onChange={(e) => setEditTextRu(e.target.value)}
                      onBlur={syncEnFromRu}
                      rows={10}
                      className="text-sm"
                      disabled={translatingRu}
                    />
                  </div>
                </div>
                <p className="text-[10px] text-ink-3">
                  Правь любую из колонок — при уходе фокуса вторая колонка
                  автоматически переведётся. Отправляется английская версия.
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleSaveEdit}
                    disabled={translatingEn || translatingRu}
                  >
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div>
                  <p className="text-[9px] font-semibold text-ink-3 uppercase mb-1">
                    🇬🇧 English
                  </p>
                  <div className="rounded bg-surface-tint p-3 text-sm text-ink whitespace-pre-wrap min-h-[6rem]">
                    {m.editedResponse || m.suggestedResponse}
                  </div>
                </div>
                <div>
                  <p className="text-[9px] font-semibold text-ink-3 uppercase mb-1">
                    🇷🇺 Русский
                  </p>
                  <div className="rounded bg-surface-tint p-3 text-sm text-ink whitespace-pre-wrap min-h-[6rem]">
                    {m.editedResponseRu ||
                      m.suggestedResponseRu || (
                        <span className="text-ink-3 italic">
                          Перевод недоступен (появится после Re-analyze)
                        </span>
                      )}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mt-2">
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
                  <div className="absolute right-0 top-full mt-1 z-10 w-52 rounded-md border border-rule bg-surface shadow-lg text-xs">
                    {[
                      { id: "polite", label: "More polite" },
                      { id: "amazon_safe", label: "Amazon-safe" },
                      { id: "shorter", label: "Shorter" },
                      { id: "no_refund", label: "No refund language" },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => handleRewrite(opt.id)}
                        className="block w-full text-left px-3 py-2 hover:bg-surface-tint first:rounded-t-md last:rounded-b-md"
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
                className={`${m.status !== "SENT" && m.status !== "RESOLVED" ? "" : "ml-auto"} bg-green hover:bg-green-deep`}
              >
                {sending ? (
                  <Loader2 size={12} className="animate-spin mr-1" />
                ) : null}
                {m.status === "SENT" || m.status === "RESOLVED"
                  ? "Already sent"
                  : "Send via SP-API"}
              </Button>
            </div>
            {sendError && sendError.messagingClosed && (
              <div className="mt-2 rounded-md border border-warn/30 bg-warn-tint text-warn-strong text-xs px-3 py-2 flex items-start gap-2">
                <span className="shrink-0">⚠️</span>
                <div>
                  <div className="font-semibold mb-0.5">
                    Amazon messaging window is closed for this order
                  </div>
                  <div className="text-warn-strong">{sendError.message}</div>
                  <div className="text-[10px] text-warn-strong mt-1">
                    Next step: reply in Amazon Seller Central manually, then
                    click <b>&ldquo;Responded in Seller Central&rdquo;</b>{" "}
                    below to mark this case as sent.
                  </div>
                </div>
              </div>
            )}
            {sendError && !sendError.messagingClosed && (
              <div className="mt-2 rounded-md border border-danger bg-danger-tint text-danger text-xs px-3 py-2 flex items-start gap-2">
                <span className="shrink-0">❌</span>
                <div className="font-mono text-[11px] break-all">
                  {sendError.message}
                </div>
              </div>
            )}
            {sentFlash && (
              <p className="text-xs text-green mt-2">
                ✓ Sent via SP-API Messaging
              </p>
            )}
          </div>
        )}

        {/* Conversation history */}
        {history.length > 0 && (
          <div>
            <Separator />
            <p className="text-[10px] font-semibold text-ink-3 uppercase mt-3 mb-2">
              Conversation History ({history.length + 1} messages)
            </p>
            <div className="space-y-1.5">
              {history.map((h) => (
                <div
                  key={h.id}
                  className={`rounded px-2.5 py-1.5 text-xs ${
                    h.direction === "incoming"
                      ? "bg-surface-tint text-ink"
                      : "bg-green-soft text-green-deep"
                  }`}
                >
                  <span className="text-[10px] text-ink-3">
                    [{new Date(h.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}]{" "}
                    {h.direction === "incoming" ? "CUSTOMER" : "OUR REPLY"}:
                  </span>{" "}
                  {(h.customerMessage || h.suggestedResponse || "").substring(0, 150)}
                  {(h.customerMessage || "").length > 150 ? "..." : ""}
                </div>
              ))}
              <div className="rounded px-2.5 py-1.5 text-xs bg-warn-tint text-warn-strong border border-warn-strong">
                <span className="text-[10px] text-warn-strong">
                  [Current] CUSTOMER:
                </span>{" "}
                {(m.customerMessage || "").substring(0, 150)}
              </div>
            </div>
          </div>
        )}
      </CardContent>

      {/* Save-to-Knowledge-Base dialog */}
      <Dialog open={kbDialogOpen} onOpenChange={setKbDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Save to Knowledge Base</DialogTitle>
            <DialogDescription>
              Capture this resolved case so the Decision Engine can use it
              as guidance for future similar messages.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-xs">
            <div>
              <label className="text-ink-3 font-medium">Scenario</label>
              <p className="text-ink mt-0.5">
                {m.problemTypeName || m.problemType || "Customer case"}
                {m.trackingStatus ? ` — ${m.trackingStatus}` : ""}
                {m.shippingMismatch ? " — shipping mismatch" : ""}
              </p>
            </div>

            <div>
              <label className="text-ink-3 font-medium">
                Correct Action
              </label>
              <p className="text-ink mt-0.5">
                {m.action || "investigate"}
              </p>
            </div>

            <div>
              <label className="text-ink-3 font-medium">
                Correct Response
              </label>
              <div className="mt-1 rounded bg-surface-tint p-2 text-[11px] whitespace-pre-wrap max-h-32 overflow-y-auto">
                {m.editedResponse || m.suggestedResponse || "(no response)"}
              </div>
            </div>

            <div>
              <label
                htmlFor="kb-reasoning"
                className="text-ink-3 font-medium"
              >
                Reasoning <span className="text-danger">*</span>
              </label>
              <textarea
                id="kb-reasoning"
                value={kbReasoning}
                onChange={(e) => setKbReasoning(e.target.value)}
                rows={3}
                placeholder="Why is this the correct response? What pattern should future cases follow?"
                className="w-full mt-1 rounded border border-rule p-2 text-xs focus:border-green-mid focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="kb-outcome"
                className="text-ink-3 font-medium"
              >
                Outcome
              </label>
              <select
                id="kb-outcome"
                value={kbOutcome}
                onChange={(e) =>
                  setKbOutcome(
                    e.target.value as "positive" | "negative" | "neutral"
                  )
                }
                className="w-full mt-1 rounded border border-rule p-2 text-xs focus:border-green-mid focus:outline-none"
              >
                <option value="positive">Positive</option>
                <option value="neutral">Neutral</option>
                <option value="negative">Negative</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="kb-tags"
                className="text-ink-3 font-medium"
              >
                Tags (comma-separated)
              </label>
              <input
                id="kb-tags"
                type="text"
                value={kbTags}
                onChange={(e) => setKbTags(e.target.value)}
                placeholder="shipping_mismatch, next_day, cancel_request"
                className="w-full mt-1 rounded border border-rule p-2 text-xs focus:border-green-mid focus:outline-none"
              />
            </div>

            {kbError && (
              <div className="rounded border border-danger/20 bg-danger-tint p-2 text-danger">
                {kbError}
              </div>
            )}

            {kbSavedFlash && (
              <div className="rounded border border-green-soft2 bg-green-soft p-2 text-green-ink">
                ✓ Saved to Knowledge Base
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setKbDialogOpen(false)}
                disabled={kbSaving}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSaveToKB}
                disabled={kbSaving}
                className="text-xs"
              >
                {kbSaving ? (
                  <Loader2 size={12} className="animate-spin mr-1" />
                ) : null}
                Save to KB
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
