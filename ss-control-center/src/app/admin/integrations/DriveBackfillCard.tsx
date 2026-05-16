"use client";

// Manual trigger for the Drive back-fill safety net. Same scan as the
// 15-minute n8n cron, but operator-driven from /admin/integrations.
// Useful for catching old purchases that pre-date the OAuth fix.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CloudUpload, RefreshCw, AlertTriangle } from "lucide-react";

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
          {result.errors.length > 0 && (
            <div className="text-danger">
              ✗ Errors {result.errors.length}:{" "}
              {result.errors
                .slice(0, 3)
                .map(
                  (e) =>
                    `${e.orderNumber} (${e.reason.slice(0, 40)}${
                      e.reason.length > 40 ? "…" : ""
                    })`,
                )
                .join("; ")}
              {result.errors.length > 3 && `… +${result.errors.length - 3}`}
            </div>
          )}
          {result.skipped.length > 0 && (
            <div className="text-ink-3">
              ↷ Skipped {result.skipped.length}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
