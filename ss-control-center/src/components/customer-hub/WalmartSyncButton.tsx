"use client";

/**
 * One-click Walmart sync — pulls orders + returns from the Marketplace API
 * and creates BuyerMessage records for anything actionable. Result is shown
 * inline so the operator gets immediate feedback (no router refresh needed).
 */

import { useState } from "react";
import { Loader2, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type SyncOutcome =
  | { kind: "idle" }
  | { kind: "ok"; ordersSynced: number; returnsSynced: number; messagesCreated: number }
  | { kind: "partial"; message: string }
  | { kind: "error"; message: string };

interface SyncResponse {
  ok?: boolean;
  synced?: number;
  messagesCreated?: number;
  errorCount?: number;
  errors?: string[];
  error?: string;
}

export default function WalmartSyncButton() {
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome>({ kind: "idle" });

  async function runSync() {
    setRunning(true);
    setOutcome({ kind: "idle" });

    try {
      const [ordersRes, returnsRes] = await Promise.all([
        fetch("/api/customer-hub/walmart/orders/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ daysBack: 30 }),
        }),
        fetch("/api/customer-hub/walmart/returns/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ daysBack: 30 }),
        }),
      ]);

      const orders: SyncResponse = await ordersRes.json().catch(() => ({}));
      const returns: SyncResponse = await returnsRes.json().catch(() => ({}));

      if (!ordersRes.ok && !returnsRes.ok) {
        setOutcome({
          kind: "error",
          message: orders.error || returns.error || "Sync failed",
        });
      } else if (!ordersRes.ok || !returnsRes.ok) {
        setOutcome({
          kind: "partial",
          message: `Partial: ${orders.error || returns.error || "see logs"}`,
        });
      } else {
        setOutcome({
          kind: "ok",
          ordersSynced: orders.synced ?? 0,
          returnsSynced: returns.synced ?? 0,
          messagesCreated:
            (orders.messagesCreated ?? 0) + (returns.messagesCreated ?? 0),
        });
      }
    } catch (err) {
      setOutcome({
        kind: "error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={runSync}
        disabled={running}
        title="Pull Walmart orders + returns from Marketplace API"
      >
        {running ? (
          <Loader2 size={14} className="mr-1 animate-spin" />
        ) : (
          <RefreshCw size={14} className="mr-1" />
        )}
        Sync Walmart
      </Button>

      {outcome.kind === "ok" && (
        <span className="inline-flex items-center gap-1 text-xs text-green-700">
          <CheckCircle2 size={14} />
          {outcome.ordersSynced} orders, {outcome.returnsSynced} returns
          {outcome.messagesCreated > 0 && (
            <> · {outcome.messagesCreated} new message{outcome.messagesCreated === 1 ? "" : "s"}</>
          )}
        </span>
      )}

      {(outcome.kind === "error" || outcome.kind === "partial") && (
        <span
          className="inline-flex max-w-[260px] items-center gap-1 truncate text-xs text-red-700"
          title={outcome.message}
        >
          <AlertCircle size={14} />
          {outcome.message}
        </span>
      )}
    </div>
  );
}
