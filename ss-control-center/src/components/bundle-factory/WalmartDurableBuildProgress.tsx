"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { Btn } from "@/components/kit";

interface CollectionState {
  batchId: string;
  status:
    | "QUEUED_NO_SPEND"
    | "RUNNING_NO_SPEND"
    | "AWAITING_OWNER"
    | "RUNNING_ENRICHMENT"
    | "DECLINED"
    | "FAILED"
    | "AMBIGUOUS"
    | "SUCCEEDED";
  jobs: Array<{
    run_id: string;
    title: string;
    phase: string;
    error_code: string | null;
  }>;
  quote: null | {
    quote_sha256: string;
    maximum_provider_units: number;
    actions: Array<{ title: string; maximum_provider_units: number }>;
  };
  progress: null | {
    totalJobs: number;
    currentOrdinal: number | null;
    currentTitle: string | null;
    stage: string;
    completedJobs: number;
    stoppedJobs: number;
    providerCalls: number;
    providerUnits: number;
    messageCode: string;
  };
}

export function WalmartDurableBuildProgress({
  buildId,
  collectionBatchId,
  listingCount,
}: {
  buildId: string;
  collectionBatchId: string;
  listingCount: number;
}) {
  const [collection, setCollection] = useState<CollectionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [ambiguousAttempt, setAmbiguousAttempt] = useState<null | {
    command_id?: string | null;
    error_code?: string | null;
    provider_units_used?: number | null;
  }>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizingRef = useRef(false);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function finalizeBuild(
    options: { ownerAcknowledgedAmbiguousAttempt?: boolean } = {},
  ) {
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    setFinalizing(true);
    try {
      const response = await fetch(
        `/api/bundle-factory/walmart/builds/${encodeURIComponent(buildId)}/finalize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_acknowledged_ambiguous_attempt:
              options.ownerAcknowledgedAmbiguousAttempt === true,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        // An ambiguous paid attempt never restarts by itself. Surface it as
        // an explicit owner decision instead of a dead end.
        if (result?.code === "AMBIGUOUS_ATTEMPT_REQUIRES_OWNER_ACKNOWLEDGEMENT") {
          setAmbiguousAttempt(result.ambiguous_attempt ?? {});
          finalizingRef.current = false;
          setFinalizing(false);
          return;
        }
        throw new Error(result?.error ?? "Walmart build finalization failed");
      }
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Walmart build finalization failed");
      finalizingRef.current = false;
      setFinalizing(false);
    }
  }

  async function poll() {
    try {
      const response = await fetch(
        `/api/bundle-factory/walmart/data-collection?batch_id=${encodeURIComponent(collectionBatchId)}`,
        { cache: "no-store" },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.message ?? result?.code ?? "Product Truth status failed");
      }
      const next = result.collection as CollectionState;
      setCollection(next);
      setError(null);
      if (
        next.status === "SUCCEEDED"
        || next.status === "FAILED"
        // AMBIGUOUS is terminal too: a started paid attempt whose worker died
        // is never auto-retried, so the build must move to finalization (which
        // records the attempt and, if products are still missing, prepares a
        // NEW attempt behind a fresh exact quote).
        || next.status === "AMBIGUOUS"
        || next.status === "DECLINED"
      ) {
        await finalizeBuild();
        return;
      }
      if (
        next.status === "QUEUED_NO_SPEND"
        || next.status === "RUNNING_NO_SPEND"
        || next.status === "RUNNING_ENRICHMENT"
      ) {
        timer.current = setTimeout(() => void poll(), 4_000);
        return;
      }
      // Terminal states keep a slow poll alive. A screen left open through a
      // worker death must repair itself instead of showing "Enriching…"
      // forever, which is exactly how this build looked stuck to its owner.
      timer.current = setTimeout(() => void poll(), 15_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Product Truth status failed");
      timer.current = setTimeout(() => void poll(), 8_000);
    }
  }

  useEffect(() => {
    void poll();
    // The build URL is the durable recovery key; polling never depends on
    // browser-local recovery state or reproducing the prompt bytes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId, collectionBatchId]);

  async function approveExactQuote() {
    if (!collection?.quote) return;
    setApproving(true);
    setError(null);
    try {
      const prepareResponse = await fetch(
        `/api/bundle-factory/walmart/data-collection/${encodeURIComponent(collectionBatchId)}/approval`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "PREPARE_OWNER_AUTHORIZATION",
            quote_sha256: collection.quote.quote_sha256,
          }),
        },
      );
      const prepared = await prepareResponse.json();
      if (!prepareResponse.ok) {
        throw new Error(prepared?.message ?? prepared?.code ?? "Exact quote preparation failed");
      }
      const approval = prepared.approval as {
        command_id: string;
        command_sha256: string;
        quote_sha256: string;
        quote: unknown;
        envelope: unknown;
        owner_agent_url: string;
      };
      const ownerResponse = await fetch(approval.owner_agent_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command_sha256: approval.command_sha256,
          quote_sha256: approval.quote_sha256,
          quote: approval.quote,
          envelope: approval.envelope,
        }),
      });
      const signed = await ownerResponse.json();
      if (!ownerResponse.ok || signed?.ok !== true) {
        throw new Error(signed?.message ?? "Local owner approval failed closed");
      }
      const authorizeResponse = await fetch(
        `/api/bundle-factory/walmart/data-collection/${encodeURIComponent(collectionBatchId)}/approval`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "AUTHORIZE",
            command_id: approval.command_id,
            signature_base64: signed.signature_base64,
          }),
        },
      );
      const authorized = await authorizeResponse.json();
      if (!authorizeResponse.ok) {
        throw new Error(authorized?.message ?? authorized?.code ?? "Exact quote was not admitted");
      }
      await poll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Exact quote approval failed");
    } finally {
      setApproving(false);
    }
  }

  const paidRunning = collection?.status === "RUNNING_ENRICHMENT";
  const failed = collection?.status === "FAILED" || collection?.status === "AMBIGUOUS";
  const preparedCount = collection
    ? listingCount - collection.jobs.filter((job) =>
        !["AWAITING_OWNER", "SUCCEEDED"].includes(job.phase)).length
    : 0;
  const percent = Math.max(0, Math.min(100, Math.round(
    ((collection?.progress?.completedJobs ?? preparedCount) / listingCount) * 100,
  )));

  return (
    <div className="rounded-[14px] border border-rule bg-surface p-5">
      <div className="flex items-center gap-2.5">
        {finalizing ? (
          <Loader2 size={18} className="animate-spin text-green" />
        ) : failed || error ? (
          <AlertTriangle size={18} className="text-warn-strong" />
        ) : collection?.status === "SUCCEEDED" ? (
          <CheckCircle2 size={18} className="text-green" />
        ) : (
          <Loader2 size={18} className="animate-spin text-green" />
        )}
        <div className="text-[13.5px] font-medium text-ink">
          {finalizing
            ? "Advancing this build — sealing drafts or selecting a different exact product…"
            : paidRunning
              ? `Enriching ${collection?.progress?.currentTitle ?? "the exact product"}`
              : collection?.status === "AWAITING_OWNER"
                ? "One exact provider quote is ready for approval"
                : failed
                  ? "The build stopped safely"
                  : "Preparing exact Product Truth plans inside this build…"}
        </div>
      </div>

      <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-bg-elev">
        <div className="h-full rounded-full bg-green transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 text-[11.5px] text-ink-3">
        Durable build {buildId} · refresh-safe · no marketplace publication
      </div>

      {collection && (
        <div className="mt-4 space-y-1.5">
          {collection.jobs.map((job, index) => (
            <div key={job.run_id} className="flex justify-between gap-4 rounded-[8px] bg-bg-elev px-3 py-2 text-[11.5px]">
              <span>{index + 1}. {job.title}</span>
              <span className="shrink-0 text-ink-3">{job.phase.toLowerCase().replaceAll("_", " ")}</span>
            </div>
          ))}
        </div>
      )}

      {collection?.status === "AWAITING_OWNER" && collection.quote && (
        <div className="mt-4 rounded-[10px] border border-rule p-3">
          <div className="text-[12.5px] font-semibold text-ink">Exact enrichment quote</div>
          <p className="mt-1 text-[12px] text-ink-3">
            Maximum {collection.quote.maximum_provider_units} prepaid provider credits for {collection.quote.actions.length} exact products. This does not publish or reserve UPCs.
          </p>
          <Btn className="mt-3" variant="primary" size="md" onClick={approveExactQuote} disabled={approving}>
            {approving ? "Approving…" : "Approve exact quote"}
          </Btn>
        </div>
      )}

      {(ambiguousAttempt || collection?.status === "AMBIGUOUS") && (
        <div className="mt-4 rounded-[10px] border border-warn/30 bg-warn-tint p-3">
          <div className="text-[12.5px] font-semibold text-ink">
            The previous paid attempt ended with an unknown result
          </div>
          <p className="mt-1 text-[12px] text-ink-3">
            The data collector stopped after
            {" "}{ambiguousAttempt?.provider_units_used
              ?? collection?.progress?.providerUnits
              ?? 0} provider credits and
            could not prove what it completed, so it is never retried
            automatically. Starting a new attempt creates a new exact quote that
            you approve separately; already-harvested products are skipped.
          </p>
          <Btn
            className="mt-3"
            variant="primary"
            size="md"
            disabled={finalizing}
            onClick={() => {
              setAmbiguousAttempt(null);
              void finalizeBuild({ ownerAcknowledgedAmbiguousAttempt: true });
            }}
          >
            Start a new attempt
          </Btn>
        </div>
      )}

      {collection?.progress && (
        <div className="mt-3 text-[11.5px] text-ink-3">
          Stage: {collection.progress.stage.toLowerCase().replaceAll("_", " ")} · {collection.progress.providerUnits} provider credits used
        </div>
      )}

      {error && <div className="mt-4 rounded-[10px] bg-red-50 p-3 text-[12px] text-red-700">{error}</div>}
    </div>
  );
}
