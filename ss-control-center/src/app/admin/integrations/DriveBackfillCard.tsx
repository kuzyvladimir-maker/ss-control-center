"use client";

// Manual trigger for the Drive back-fill safety net. Same scan as the
// 15-minute n8n cron, but operator-driven from /admin/integrations.
// Useful for catching old purchases that pre-date the OAuth fix.

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CloudUpload, RefreshCw, AlertTriangle, Trash2 } from "lucide-react";

interface BackfillResult {
  found: number;
  lookbackDays: number;
  uploaded: { orderNumber: string; labelPath: string }[];
  errors: { orderNumber: string; reason: string }[];
  skipped: { orderNumber: string; reason: string }[];
}

export default function DriveBackfillCard() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookback, setLookback] = useState(30);
  const [deletingOrder, setDeletingOrder] = useState<string | null>(null);
  const [deletedNote, setDeletedNote] = useState<string | null>(null);

  // Group repeating errors by orderNumber so the operator sees one entry
  // per stuck order with the count instead of N near-identical rows.
  const errorsByOrder = useMemo(() => {
    if (!result) return [] as Array<{ orderNumber: string; count: number; reason: string }>;
    const m = new Map<string, { count: number; reason: string }>();
    for (const e of result.errors) {
      const prev = m.get(e.orderNumber);
      if (prev) prev.count++;
      else m.set(e.orderNumber, { count: 1, reason: e.reason });
    }
    return Array.from(m.entries()).map(([orderNumber, v]) => ({
      orderNumber,
      ...v,
    }));
  }, [result]);

  async function deleteOrphans(orderNumber: string) {
    if (
      !confirm(
        `Permanently remove the orphan ShippingPlanItem rows for ${orderNumber}?\n\nOnly rows whose PDFs aren't on Drive will be deleted. Drive-backed rows stay.`,
      )
    )
      return;
    setDeletingOrder(orderNumber);
    setDeletedNote(null);
    try {
      const res = await fetch(
        "/api/integrations/drive-backfill/delete-orphans",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderNumber }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setDeletedNote(`Error: ${data.error || `HTTP ${res.status}`}`);
        return;
      }
      setDeletedNote(`Removed ${data.deleted} row(s) for ${orderNumber}.`);
      // Strip these errors from the visible result so the operator sees
      // only what's left to fix.
      if (result) {
        setResult({
          ...result,
          errors: result.errors.filter((e) => e.orderNumber !== orderNumber),
        });
      }
    } catch (e) {
      setDeletedNote(
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setDeletingOrder(null);
    }
  }

  async function runBackfill() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/integrations/drive-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookbackDays: lookback }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded border border-rule bg-surface p-3 space-y-3">
      <div className="flex items-center gap-2">
        <CloudUpload size={16} className="text-info" />
        <div className="font-medium text-ink">Google Drive — back-fill</div>
      </div>
      <div className="text-[12.5px] text-ink-2">
        Find purchased labels whose PDFs aren&apos;t on Drive yet and upload
        them. n8n runs the same scan every 15 minutes; this button is for
        catching old purchases or after fixing the OAuth config.
      </div>
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="text-ink-2">Look back:</span>
        <select
          value={lookback}
          onChange={(e) => setLookback(Number(e.target.value))}
          disabled={running}
          className="rounded border border-rule bg-surface px-2 py-1"
        >
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
        </select>
        <Button onClick={runBackfill} disabled={running} size="sm">
          {running ? (
            <>
              <RefreshCw size={13} className="mr-1 animate-spin" /> Running…
            </>
          ) : (
            "Run now"
          )}
        </Button>
      </div>

      {error && (
        <div className="rounded border border-danger/30 bg-danger-tint p-2 text-[11.5px] text-danger flex items-start gap-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {result && (
        <div className="rounded border border-rule bg-surface-tint p-2 text-[11.5px] space-y-1">
          <div>
            Found <span className="font-mono">{result.found}</span> candidates
            in last {result.lookbackDays} days.
          </div>
          {result.uploaded.length > 0 && (
            <div className="text-green-ink">
              ✓ Uploaded {result.uploaded.length}:{" "}
              {result.uploaded
                .slice(0, 5)
                .map((u) => u.orderNumber)
                .join(", ")}
              {result.uploaded.length > 5 &&
                ` and ${result.uploaded.length - 5} more`}
            </div>
          )}
          {errorsByOrder.length > 0 && (
            <div className="space-y-1">
              <div className="text-danger">
                ✗ Errors on {errorsByOrder.length} order
                {errorsByOrder.length === 1 ? "" : "s"} ({result.errors.length}
                {" "}row{result.errors.length === 1 ? "" : "s"} total):
              </div>
              <ul className="space-y-1">
                {errorsByOrder.map((e) => (
                  <li
                    key={e.orderNumber}
                    className="flex items-start justify-between gap-2 rounded border border-danger/20 bg-danger-tint/30 px-2 py-1"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[11.5px] font-medium text-danger">
                        {e.orderNumber}
                        {e.count > 1 && (
                          <span className="ml-1 font-normal text-ink-3">
                            × {e.count}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-ink-3 break-words">
                        {e.reason.slice(0, 120)}
                        {e.reason.length > 120 && "…"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteOrphans(e.orderNumber)}
                      disabled={deletingOrder === e.orderNumber}
                      className="shrink-0 inline-flex items-center gap-1 rounded border border-rule bg-surface px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-bg-elev hover:text-danger disabled:opacity-50"
                      title="Delete orphan rows for this order (only those not on Drive)"
                    >
                      {deletingOrder === e.orderNumber ? (
                        <RefreshCw size={11} className="animate-spin" />
                      ) : (
                        <Trash2 size={11} />
                      )}
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.skipped.length > 0 && (
            <div className="text-ink-3">
              ↷ Skipped {result.skipped.length}
            </div>
          )}
        </div>
      )}

      {deletedNote && (
        <div className="rounded border border-rule bg-surface-tint p-2 text-[11.5px] text-ink-2">
          {deletedNote}
        </div>
      )}
    </div>
  );
}
