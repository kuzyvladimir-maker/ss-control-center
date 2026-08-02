"use client";

/**
 * Per-row Walmart state and publish action on the Drafts list.
 *
 * Owner ask 2026-08-02: a publish button with visible progress, without
 * opening each draft. The confirmation still happens here — publishing writes
 * to the marketplace and there is no undo, so the row asks once before it
 * posts, exactly like the draft page does.
 */

import { useState } from "react";
import Link from "next/link";
import { Btn } from "@/components/kit";
import { Loader2, ExternalLink } from "lucide-react";

export interface DraftWalmartSkuState {
  sku: string;
  validation_status: string;
  lifecycle_status: string;
  listing_status: string;
  live_url: string | null;
  price_cents: number;
}

type Phase = "idle" | "confirming" | "publishing" | "done" | "error";

export function DraftWalmartPublishCell({
  draftId,
  state,
}: {
  draftId: string;
  state: DraftWalmartSkuState | null;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  if (!state) {
    return <span className="text-[11.5px] text-ink-3">no Walmart SKU yet</span>;
  }

  if (state.live_url) {
    return (
      <Link
        href={state.live_url}
        target="_blank"
        className="inline-flex items-center gap-1 text-[11.5px] text-green-ink hover:underline"
      >
        live <ExternalLink size={11} strokeWidth={2} />
      </Link>
    );
  }

  if (phase === "done") {
    return (
      <span className="text-[11.5px] text-green">
        {message ?? "submitted to Walmart"}
      </span>
    );
  }

  const ready = state.validation_status === "PASSED";

  async function publish() {
    setPhase("publishing");
    setMessage(null);
    try {
      const res = await fetch(
        `/api/bundle-factory/drafts/${draftId}/publish?dryRun=false`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approvalConfirmed: true,
            channels: ["WALMART"],
            actor: "drafts-list",
          }),
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        results?: Array<{ error?: string | null; submission_id?: string | null }>;
      };
      if (!res.ok || data.ok === false) {
        const first = data.results?.find((row) => row.error);
        throw new Error(first?.error ?? data.error ?? "Publish failed");
      }
      const submission = data.results?.find((row) => row.submission_id);
      setMessage(
        submission?.submission_id
          ? `feed ${String(submission.submission_id).slice(0, 12)}…`
          : "submitted to Walmart",
      );
      setPhase("done");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Publish failed");
      setPhase("error");
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <span
        className={`text-[11.5px] ${ready ? "text-green" : "text-ink-3"}`}
      >
        {ready ? "validated" : state.validation_status.toLowerCase()}
      </span>
      {ready && phase === "idle" && (
        <Btn variant="outline" size="sm" onClick={() => setPhase("confirming")}>
          Publish
        </Btn>
      )}
      {phase === "confirming" && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-3">
            Publish {state.sku} at ${(state.price_cents / 100).toFixed(2)}?
          </span>
          <Btn variant="primary" size="sm" onClick={() => void publish()}>
            Yes, publish
          </Btn>
          <Btn variant="ghost" size="sm" onClick={() => setPhase("idle")}>
            Cancel
          </Btn>
        </div>
      )}
      {phase === "publishing" && (
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2">
          <Loader2 size={12} strokeWidth={2} className="animate-spin" />
          publishing…
        </span>
      )}
      {phase === "error" && (
        <div className="flex items-start gap-2">
          <span className="max-w-[320px] text-[11px] text-danger">{message}</span>
          <Btn variant="ghost" size="sm" onClick={() => setPhase("idle")}>
            Retry
          </Btn>
        </div>
      )}
    </div>
  );
}
