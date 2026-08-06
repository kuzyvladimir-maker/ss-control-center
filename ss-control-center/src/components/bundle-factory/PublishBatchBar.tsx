"use client";

/**
 * The factory switch and the live state of a server-side publish batch.
 *
 * Two things the operator needs above the drafts table:
 *
 *   · the AUTO / SEMI-AUTO switch, because whether the schedule publishes on
 *     its own is an operating decision he and his staff make, not a constant;
 *   · what the batch is doing right now, including when it is simply waiting
 *     for tomorrow's ceiling rather than stuck.
 *
 * The batch runs on the server. This panel ticks it to make it go faster while
 * someone is watching, and the cron finishes it when nobody is.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Btn } from "@/components/kit";
import { Loader2, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { describeBundleFactoryFailure } from "@/lib/bundle-factory/api-error-text";

export interface PublishCap {
  cap: number;
  usedLast24h: number;
  remaining: number;
}

export interface BatchProgress {
  id: string;
  status: string;
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  done: boolean;
  cap: PublishCap;
  waitingForCap: boolean;
}

export type FactoryMode = "SEMI_AUTO" | "AUTO";

const MODE_LABEL: Record<FactoryMode, string> = {
  SEMI_AUTO: "Semi-automatic",
  AUTO: "Automatic",
};

const MODE_HELP: Record<FactoryMode, string> = {
  SEMI_AUTO:
    "The schedule builds listings and stops. Publishing waits for someone to select a batch and press.",
  AUTO:
    "The schedule also publishes, inside the daily ceiling. No press needed.",
};

interface FactoryRails {
  allowed: boolean;
  paused: boolean;
  blocks: string[];
  reasons: string[];
}

export function PublishBatchBar({
  batchId,
  onBatchFinished,
}: {
  batchId: string | null;
  onBatchFinished?: () => void;
}) {
  const [mode, setMode] = useState<FactoryMode | null>(null);
  const [cap, setCap] = useState<PublishCap | null>(null);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [rails, setRails] = useState<FactoryRails | null>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/bundle-factory/publish-batches");
        const data = await res.json();
        if (!res.ok) throw new Error(describeBundleFactoryFailure(data));
        setMode(data.mode as FactoryMode);
        setCap(data.cap as PublishCap);
        setRails(data.rails as FactoryRails);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read the factory mode");
      }
    })();
  }, []);

  /** Tick the batch, then report where it is. */
  const advance = useCallback(async (id: string) => {
    const res = await fetch(`/api/bundle-factory/publish-batches/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tick" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(describeBundleFactoryFailure(data));
    return data.progress as BatchProgress;
  }, []);

  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    finishedRef.current = false;

    void (async () => {
      while (!cancelled) {
        try {
          const next = await advance(batchId);
          if (cancelled) return;
          setProgress(next);
          setCap(next.cap);
          if (next.done) {
            if (!finishedRef.current) {
              finishedRef.current = true;
              onBatchFinished?.();
            }
            return;
          }
          // Nothing left that this ceiling allows: the cron will pick the batch
          // up when the rolling window opens. Watching is pointless until then.
          if (next.waitingForCap) return;
        } catch (e) {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : "Batch stalled");
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    })();

    return () => { cancelled = true; };
  }, [batchId, advance, onBatchFinished]);

  async function setPaused(next: boolean) {
    setSwitching(true);
    setError(null);
    try {
      const res = await fetch("/api/bundle-factory/publish-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(describeBundleFactoryFailure(data));
      setRails(data.rails as FactoryRails);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the pause");
    } finally {
      setSwitching(false);
    }
  }

  async function switchMode(next: FactoryMode) {
    setSwitching(true);
    setError(null);
    try {
      const res = await fetch("/api/bundle-factory/publish-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(describeBundleFactoryFailure(data));
      setMode(data.mode as FactoryMode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the mode");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="mb-3 rounded-[12px] border border-rule bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[12.5px] font-semibold text-ink">Factory</span>

        <div className="flex items-center gap-1.5">
          {(["SEMI_AUTO", "AUTO"] as FactoryMode[]).map((option) => (
            <Btn
              key={option}
              variant={mode === option ? "primary" : "outline"}
              size="sm"
              disabled={switching || mode === null}
              onClick={() => void switchMode(option)}
            >
              {MODE_LABEL[option]}
            </Btn>
          ))}
        </div>

        {cap && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
            <Clock size={12} strokeWidth={2} />
            {cap.remaining} of {cap.cap} left in the last 24 h
          </span>
        )}

        {rails && (
          <Btn
            variant={rails.paused ? "primary" : "outline"}
            size="sm"
            disabled={switching}
            onClick={() => void setPaused(!rails.paused)}
            className="ml-auto"
          >
            {rails.paused ? "Resume" : "Pause everything"}
          </Btn>
        )}
      </div>

      {rails && rails.reasons.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-[10px] border border-warn-strong/40 bg-warn-tint px-2.5 py-2">
          {rails.reasons.map((reason) => (
            <li key={reason} className="text-[11.5px] leading-snug text-warn-strong">
              {reason}
            </li>
          ))}
        </ul>
      )}

      {mode && (
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">
          {MODE_HELP[mode]}
        </p>
      )}

      {progress && (
        <div className="mt-2.5 flex flex-wrap items-center gap-3 border-t border-rule pt-2.5 text-[12px]">
          {progress.done ? (
            <span className="inline-flex items-center gap-1.5 text-green-ink">
              <CheckCircle2 size={13} strokeWidth={2} />
              Batch finished — {progress.succeeded} submitted
              {progress.failed > 0 ? `, ${progress.failed} failed` : ""}
            </span>
          ) : progress.waitingForCap ? (
            <span className="inline-flex items-center gap-1.5 text-warn-strong">
              <Clock size={13} strokeWidth={2} />
              {progress.pending} listing(s) waiting for the ceiling to open —
              the schedule will continue on its own
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-ink-2">
              <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              {progress.succeeded + progress.failed} of {progress.total}
              {progress.failed > 0 ? ` · ${progress.failed} failed` : ""}
            </span>
          )}
          <span className="font-mono text-[11px] text-ink-3">{progress.id}</span>
        </div>
      )}

      {error && (
        <div className="mt-2 inline-flex items-start gap-1.5 text-[11.5px] text-danger">
          <AlertTriangle size={13} strokeWidth={2} className="mt-px shrink-0" />
          <span className="whitespace-pre-line">{error}</span>
        </div>
      )}
    </div>
  );
}
