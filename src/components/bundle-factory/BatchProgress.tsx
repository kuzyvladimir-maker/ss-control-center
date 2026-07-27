"use client";

/**
 * Live batch progress — drives the prompt-driven generator and shows it.
 *
 * On mount it auto-runs: POST .../tick, render the returned progress, and
 * keep ticking until done. Shows a progress bar (done / total), the step
 * happening right now, and a failed count. No button — "it just goes".
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Btn } from "@/components/kit";
import { Loader2, CheckCircle2, AlertTriangle, ArrowRight } from "lucide-react";

interface Progress {
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  phase: string;
  step: string;
  total: number;
  done: number;
  failed: number;
  done_flag: boolean;
}

export function BatchProgress({ batchId }: { batchId: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    async function loop() {
      while (!cancelled) {
        let p: Progress;
        try {
          const res = await fetch(`/api/bundle-factory/studio/${batchId}/tick`, { method: "POST" });
          p = (await res.json()) as Progress;
          if (!res.ok) throw new Error((p as unknown as { error?: string })?.error ?? "Tick failed");
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : "Generation stalled");
          return;
        }
        if (cancelled) return;
        setProgress(p);
        if (p.done_flag) return;
        // brief pause between units so the bar reads smoothly
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    void loop();
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const isDone = progress?.status === "COMPLETED";
  const isFailed = progress?.status === "FAILED" || !!error;

  return (
    <div className="rounded-[14px] border border-rule bg-surface p-5">
      {/* Header line — what's happening right now */}
      <div className="flex items-center gap-2.5">
        {isFailed ? (
          <AlertTriangle size={18} strokeWidth={1.9} className="shrink-0 text-warn-strong" />
        ) : isDone ? (
          <CheckCircle2 size={18} strokeWidth={1.9} className="shrink-0 text-green" />
        ) : (
          <Loader2 size={18} strokeWidth={2} className="shrink-0 animate-spin text-green" />
        )}
        <span className="text-[13.5px] font-medium text-ink">
          {error
            ? error
            : progress?.step ?? "Starting…"}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between text-[12px] text-ink-3">
          <span>
            <span className="font-mono text-[15px] font-semibold tabular-nums text-ink">{done}</span>
            <span className="text-ink-3"> / {total} listings</span>
          </span>
          <span className="font-mono tabular-nums">{pct}%</span>
        </div>
        <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-bg-elev">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${isFailed ? "bg-warn" : "bg-green"}`}
            style={{ width: `${isFailed ? 100 : pct}%` }}
          />
        </div>
        <div className="mt-2 flex items-center gap-4 text-[11.5px] text-ink-3">
          <span>{Math.max(0, total - done)} remaining</span>
          {progress && progress.failed > 0 && (
            <span className="text-warn-strong">{progress.failed} failed</span>
          )}
        </div>
      </div>

      {/* When done — go review the listings */}
      {isDone && (
        <div className="mt-5 flex items-center gap-3 border-t border-rule pt-4">
          <Link href="/bundle-factory/drafts">
            <Btn variant="primary" size="md">
              Review {done} listings
              <ArrowRight size={16} strokeWidth={2} />
            </Btn>
          </Link>
          <span className="text-[12px] text-ink-3">Approve each before anything publishes.</span>
        </div>
      )}

      {isFailed && !error && (
        <div className="mt-4 border-t border-rule pt-3 text-[12px] text-ink-3">
          Fix the issue above, then start a new build.
        </div>
      )}
    </div>
  );
}
