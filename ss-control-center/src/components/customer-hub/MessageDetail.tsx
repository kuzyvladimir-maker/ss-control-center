"use client";

import { useState, useEffect } from "react";
import {
  Loader2,
  X,
  ClipboardCopy,
  Pencil,
  RefreshCw,
  Package,
  Truck,
  User,
  Store,
  Check,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";

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
            {m.carrier && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <Truck size={12} />
                {m.carrier} {m.service || ""}
                {m.trackingStatus && (
                  <Badge variant="outline" className="text-[9px]">
                    {m.trackingStatus}
                  </Badge>
                )}
                {m.daysInTransit != null && (
                  <span>
                    {m.daysInTransit}d in transit
                  </span>
                )}
                {m.daysLate && m.daysLate > 0 && (
                  <span className="text-red-500">+{m.daysLate}d late</span>
                )}
                {m.claimsProtected && (
                  <Badge className="bg-green-100 text-green-700 text-[9px]">
                    Claims Protected
                  </Badge>
                )}
                {m.problemType === "T20" && (
                  <Badge className="bg-red-600 text-white text-[9px]">
                    Repeat
                  </Badge>
                )}
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="p-1">
            <X size={16} />
          </Button>
        </div>

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
            <p className="text-[10px] font-semibold text-slate-400 uppercase mb-2">
              AI Analysis
            </p>
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
              <Button
                size="sm"
                onClick={handleSend}
                disabled={sending || m.status === "SENT" || m.status === "RESOLVED"}
                className="ml-auto bg-blue-600 hover:bg-blue-700"
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
