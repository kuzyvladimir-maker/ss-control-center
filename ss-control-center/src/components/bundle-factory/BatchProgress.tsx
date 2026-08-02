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
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  RotateCcw,
} from "lucide-react";

interface Progress {
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  phase: string;
  step: string;
  total: number;
  done: number;
  failed: number;
  done_flag: boolean;
}

export function BatchProgress({
  batchId,
  reviewHref = "/bundle-factory/drafts",
  /** Walmart studio builds can re-queue their failed listings in place. */
  canRetryFailed = false,
}: {
  batchId: string;
  reviewHref?: string;
  canRetryFailed?: boolean;
}) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
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

  /**
   * Put the failed listings of this build back in the queue.
   *
   * The engine spends three attempts per listing on its own; after that the
   * item is FAILED and only a database edit could revive it. This is the same
   * reset, as a button. It touches nothing outside this build and cannot reach
   * a marketplace.
   */
  async function retryFailed() {
    setRetrying(true);
    setRetryNote(null);
    try {
      const res = await fetch(
        `/api/bundle-factory/walmart/builds/${batchId}/retry`,
        { method: "POST" },
      );
      const data = (await res.json()) as {
        error?: string;
        requeued?: number;
        note?: string;
      };
      if (!res.ok) throw new Error(data?.error ?? "Could not re-queue");
      setRetryNote(
        data.requeued
          ? `${data.requeued} listing(s) re-queued — building again…`
          : data.note ?? "Nothing to re-queue.",
      );
      if (data.requeued) {
        // Restart the tick loop the effect owns; it exits on done_flag.
        setError(null);
        startedRef.current = false;
        setProgress(null);
        void (async () => {
          while (true) {
            const tick = await fetch(
              `/api/bundle-factory/studio/${batchId}/tick`,
              { method: "POST" },
            );
            const next = (await tick.json()) as Progress;
            if (!tick.ok) {
              setError(
                (next as unknown as { error?: string })?.error ?? "Tick failed",
              );
              return;
            }
            setProgress(next);
            if (next.done_flag) return;
            await new Promise((r) => setTimeout(r, 500));
          }
        })();
      }
    } catch (e) {
      setRetryNote(e instanceof Error ? e.message : "Could not re-queue");
    } finally {
      setRetrying(false);
    }
  }

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
          <Link href={reviewHref}>
            <Btn variant="primary" size="md">
              Review {done} listings
              <ArrowRight size={16} strokeWidth={2} />
            </Btn>
          </Link>
          <span className="text-[12px] text-ink-3">Approve each before anything publishes.</span>
        </div>
      )}

      {(isFailed || (progress?.failed ?? 0) > 0) && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-rule pt-3 text-[12px] text-ink-3">
          {canRetryFailed && (progress?.failed ?? 0) > 0 ? (
            <>
              <Btn
                variant="outline"
                size="sm"
                onClick={() => void retryFailed()}
                disabled={retrying}
              >
                <RotateCcw size={14} strokeWidth={2} />
                {retrying ? "Re-queueing…" : `Retry ${progress?.failed} failed`}
              </Btn>
              <span>Each retried listing gets a fresh three-attempt budget.</span>
            </>
          ) : (
            <span>Fix the issue above, then start a new build.</span>
          )}
          {retryNote && <span className="text-ink-2">{retryNote}</span>}
        </div>
      )}
    </div>
  );
}
