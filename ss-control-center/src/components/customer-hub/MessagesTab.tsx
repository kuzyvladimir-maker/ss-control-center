"use client";

import { useState, useEffect } from "react";
import { Loader2, RefreshCw, Mail } from "lucide-react";
import MessageDetail from "./MessageDetail";
import ResponseDeadline from "./ResponseDeadline";
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

const statusDot: Record<string, string> = {
  NEW: "bg-danger-tint0",
  ANALYZED: "bg-yellow-500",
  SENT: "bg-green-soft0",
  RESPONDED: "bg-green-soft0",
};

const riskColors: Record<string, string> = {
  LOW: "bg-green-soft2 text-green-ink",
  MEDIUM: "bg-warn-tint text-warn-strong",
  HIGH: "bg-danger-tint text-danger",
  CRITICAL: "bg-red-600 text-white",
};

const actionColors: Record<string, string> = {
  REPLACEMENT: "bg-green-soft2 text-green-deep",
  REFUND: "bg-orange-100 text-orange-700",
  A2Z_GUARANTEE: "bg-green-soft2 text-green-deep",
  CLARIFY: "bg-bg-elev text-ink",
  REASSURE: "bg-green-soft2 text-green-ink",
  INVESTIGATE: "bg-warn-tint text-warn-strong",
  PHOTO_REQUEST: "bg-bg-elev text-ink-2",
  ESCALATE: "bg-danger-tint text-danger",
  INFO: "bg-bg-elev text-ink-2",
};

interface Message {
  id: string;
  createdAt: string;
  receivedAt: string | null;
  status: string;
  storeName: string;
  customerName: string | null;
  amazonOrderId: string | null;
  product: string | null;
  category: string | null;
  categoryName: string | null;
  priority: string | null;
  riskLevel: string | null;
  action: string | null;
  problemType: string | null;
  customerMessage: string | null;
  direction: string;
}

type StatusFilter = "active" | "sent" | "resolved" | "all";

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "active", label: "Active" },
  { key: "sent", label: "Sent" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];

export default function MessagesTab() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");

  const fetchMessages = async (status: StatusFilter) => {
    try {
      const res = await fetch(
        `/api/customer-hub/messages?limit=50&status=${status}`
      );
      const data = await res.json();
      setMessages(data.messages || []);
      setTotal(data.total || 0);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMessages(statusFilter);
  }, [statusFilter]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/customer-hub/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
      });
      const result = await res.json();
      const parts: string[] = [];
      parts.push(`Synced ${result.synced ?? 0} new`);
      if (typeof result.confirmations === "number" && result.confirmations > 0) {
        parts.push(`${result.confirmations} auto-resolved`);
      }
      setSyncResult(
        result.errors?.length ? result.errors[0] : parts.join(" · ")
      );
      await fetchMessages(statusFilter);
    } catch {
      setSyncResult("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-ink-3 mr-2" />
          <span className="text-sm text-ink-3">Loading messages...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
    <Card>
      <CardContent className="p-0">
        {/* Filter tabs + sync bar */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-slate-100">
          <div className="flex items-center gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatusFilter(f.key)}
                className={`px-2 py-1 rounded text-xs transition-colors ${
                  statusFilter === f.key
                    ? "bg-green-soft2 text-green-deep font-medium"
                    : "text-ink-3 hover:bg-bg-elev"
                }`}
              >
                {f.label}
                {statusFilter === f.key && total > 0 && (
                  <span className="ml-1 text-[10px] opacity-70">({total})</span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            {syncResult && (
              <span
                className="text-[10px] text-ink-3 max-w-[300px] truncate"
                title={syncResult}
              >
                {syncResult}
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
              Sync Gmail
            </Button>
          </div>
        </div>

        {messages.length === 0 ? (
          <div className="py-12 text-center">
            <Mail size={32} className="mx-auto text-ink-4 mb-3" />
            <p className="text-sm font-medium text-ink-2">
              No messages yet
            </p>
            <p className="text-xs text-ink-3 mt-1">
              Click &ldquo;Sync Gmail&rdquo; to fetch buyer messages from Amazon
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10"></TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Store</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Respond By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.map((m) => (
                <TableRow
                  key={m.id}
                  className={`cursor-pointer hover:bg-surface-tint ${selectedId === m.id ? "bg-green-soft" : ""}`}
                  onClick={() => setSelectedId(selectedId === m.id ? null : m.id)}
                >
                  <TableCell className="px-4">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${statusDot[m.status] || "bg-slate-300"}`}
                      title={m.status}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-ink-3">
                    {new Date(m.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </TableCell>
                  <TableCell className="text-xs">{m.storeName}</TableCell>
                  <TableCell className="text-xs font-medium">
                    <span className="inline-flex items-center gap-1">
                      {m.customerName || "Customer"}
                      {m.problemType === "T20" && (
                        <Badge className="bg-red-600 text-white text-[9px] px-1 py-0">
                          Repeat
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-ink-3">
                    {m.amazonOrderId
                      ? m.amazonOrderId.substring(0, 15) + "..."
                      : "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {m.category && (
                      <>
                        <span className="font-mono text-ink-3">
                          {m.category}
                        </span>{" "}
                        <span className="text-ink-3">
                          {m.categoryName || ""}
                        </span>
                      </>
                    )}
                    {!m.category && (
                      <span className="text-ink-4">Not analyzed</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {m.riskLevel ? (
                      <Badge
                        className={riskColors[m.riskLevel] || ""}
                      >
                        {m.riskLevel}
                      </Badge>
                    ) : (
                      <span className="text-ink-4 text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {m.action ? (
                      <Badge
                        className={actionColors[m.action] || "bg-bg-elev text-ink-2"}
                      >
                        {m.action}
                      </Badge>
                    ) : (
                      <span className="text-ink-4 text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <ResponseDeadline
                      createdAt={m.receivedAt || m.createdAt}
                      status={m.status}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>

    {/* Detail panel */}
    {selectedId && (
      <div className="mt-4">
        <MessageDetail
          messageId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      </div>
    )}
    </>
  );
}
