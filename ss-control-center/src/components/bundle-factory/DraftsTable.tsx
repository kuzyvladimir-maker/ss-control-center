"use client";

/**
 * Drafts list with per-row and batch publishing.
 *
 * Owner requirement 2026-08-03: publish either one listing from its row, or
 * tick a batch and publish all of them with one press. Opening each listing
 * does not scale past a day's work.
 *
 * Batch publishing walks the selection one listing at a time. That is
 * deliberate, not laziness: each listing is its own claim and its own feed
 * POST, so a failure stops at that listing instead of poisoning a shared
 * request, and the row shows exactly where the batch is.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Btn } from "@/components/kit";
import { Loader2, ExternalLink, CheckCircle2 } from "lucide-react";
import { describeBundleFactoryFailure } from "@/lib/bundle-factory/api-error-text";
import { PublishBatchBar } from "@/components/bundle-factory/PublishBatchBar";
import { isPublishableListingStatus } from "@/lib/bundle-factory/publishable-listing-status";

export interface DraftRow {
  id: string;
  draft_name: string;
  brand: string;
  status: string;
  composition_type: string;
  draft_cost_cents: number | null;
  draft_suggested_price_cents: number | null;
  updated_at: string;
  walmart: {
    id: string;
    sku: string;
    validation_status: string;
    listing_status: string;
    live_url: string | null;
    price_cents: number;
    /** True when this listing's own product ID was quarantined by a collision. */
    upc_quarantined: boolean;
    /** Pool numbers this listing has already burned on the same rejection. */
    burned_upcs: number;
  } | null;
}

type RowState =
  | { phase: "idle" }
  | { phase: "publishing" }
  | { phase: "rotating" }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string };

/**
 * A listing whose product ID is dead and can still be given a new one.
 *
 * One replacement is a repair. A listing that already burned more than one
 * number is not failing because of the number, so the button goes away rather
 * than feeding the pool into a hole (2026-08-05: the same SKU collided twice
 * with two different fresh numbers).
 */
function needsUpcRotation(row: DraftRow): boolean {
  return row.walmart != null
    && row.walmart.upc_quarantined
    && row.walmart.live_url == null
    && row.walmart.burned_upcs <= 1;
}

/** A listing that can still be sent: validated, and not already out. */
function isPublishable(row: DraftRow): boolean {
  return row.walmart != null
    && row.walmart.validation_status === "PASSED"
    && row.walmart.live_url == null
    // A quarantined product ID guarantees the same rejection again; the row
    // offers "Replace product ID" instead of a Publish that cannot work.
    && !row.walmart.upc_quarantined
    && isPublishableListingStatus(row.walmart.listing_status);
}

export function DraftsTable({ rows }: { rows: DraftRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<Record<string, RowState>>({});
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const publishable = useMemo(() => rows.filter(isPublishable), [rows]);
  const selectedPublishable = useMemo(
    () => publishable.filter((row) => selected.has(row.id)),
    [publishable, selected],
  );

  function toggle(id: string) {
    setSelected((prior) => {
      const next = new Set(prior);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prior) =>
      prior.size === publishable.length
        ? new Set()
        : new Set(publishable.map((row) => row.id)),
    );
  }

  async function publishOne(row: DraftRow): Promise<boolean> {
    setState((prior) => ({ ...prior, [row.id]: { phase: "publishing" } }));
    try {
      const res = await fetch(
        `/api/bundle-factory/drafts/${row.id}/publish?dryRun=false`,
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
        per_sku?: Array<{ error?: string | null; submission_id?: string | null }>;
      };
      if (!res.ok || data.ok === false) {
        const first = data.per_sku?.find((entry) => entry.error);
        throw new Error(
          first?.error ?? describeBundleFactoryFailure(data, "Publish failed"),
        );
      }
      const submission = data.per_sku?.find((entry) => entry.submission_id);
      setState((prior) => ({
        ...prior,
        [row.id]: {
          phase: "done",
          message: submission?.submission_id
            ? `feed ${String(submission.submission_id).slice(0, 12)}…`
            : "submitted",
        },
      }));
      return true;
    } catch (error) {
      setState((prior) => ({
        ...prior,
        [row.id]: {
          phase: "error",
          message: error instanceof Error ? error.message : "Publish failed",
        },
      }));
      return false;
    }
  }

  /** Swap a dead product ID for a fresh one, then let the operator publish. */
  async function rotateUpc(row: DraftRow) {
    if (!row.walmart) return;
    setState((prior) => ({ ...prior, [row.id]: { phase: "rotating" } }));
    try {
      const res = await fetch(
        `/api/bundle-factory/skus/${row.walmart.id}/rotate-upc`,
        { method: "POST" },
      );
      const data = (await res.json()) as {
        ok?: boolean; new_upc?: string; error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(describeBundleFactoryFailure(data, "Could not replace the product ID"));
      }
      setState((prior) => ({
        ...prior,
        [row.id]: {
          phase: "done",
          message: `new product ID ${data.new_upc} — reload, then publish`,
        },
      }));
    } catch (error) {
      setState((prior) => ({
        ...prior,
        [row.id]: {
          phase: "error",
          message: error instanceof Error ? error.message : "Could not replace the product ID",
        },
      }));
    }
  }

  /**
   * Hand the selection to the server queue.
   *
   * The batch used to run as a loop in this component, which meant closing the
   * tab abandoned it half-sent. Now the queue owns it: this only states the
   * decision once, and the cron finishes the work whether or not anyone is
   * watching.
   */
  async function publishSelected() {
    setConfirming(false);
    setBatchRunning(true);
    setBatchNote(null);
    try {
      const res = await fetch("/api/bundle-factory/publish-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftIds: selectedPublishable.map((row) => row.id),
          approvalConfirmed: true,
          note: `Queued ${selectedPublishable.length} listing(s) from the drafts list`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(describeBundleFactoryFailure(data, "Could not queue the batch"));
      setBatchId(data.batchId as string | null);
      const deferred = Number(data.deferredToday ?? 0);
      const rejected = Array.isArray(data.rejected) ? data.rejected.length : 0;
      setBatchNote(
        `${data.queued} listing(s) queued`
        + (deferred > 0 ? ` · ${deferred} wait for the daily ceiling` : "")
        + (rejected > 0 ? ` · ${rejected} could not be queued` : ""),
      );
      setSelected(new Set());
    } catch (error) {
      setBatchNote(error instanceof Error ? error.message : "Could not queue the batch");
    } finally {
      setBatchRunning(false);
    }
  }

  return (
    <>
      <PublishBatchBar batchId={batchId} />
      {publishable.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[12px] border border-rule bg-surface px-3.5 py-2.5">
          <label className="flex items-center gap-2 text-[12.5px] text-ink">
            <input
              type="checkbox"
              checked={
                selected.size > 0 && selected.size === publishable.length
              }
              onChange={toggleAll}
              disabled={batchRunning}
            />
            Select all {publishable.length} ready to publish
          </label>
          {selectedPublishable.length > 0 && !confirming && !batchRunning && (
            <Btn variant="primary" size="sm" onClick={() => setConfirming(true)}>
              Publish selected ({selectedPublishable.length})
            </Btn>
          )}
          {confirming && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-ink-2">
                Publish {selectedPublishable.length} listing(s) to Walmart? This
                cannot be undone.
              </span>
              <Btn variant="primary" size="sm" onClick={() => void publishSelected()}>
                Yes, publish
              </Btn>
              <Btn variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Btn>
            </div>
          )}
          {batchRunning && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
              <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              queueing…
            </span>
          )}
          {!batchRunning && batchNote && (
            <span className="text-[12px] text-ink-2">{batchNote}</span>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
        <table className="min-w-full text-[12.5px] text-ink">
          <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
            <tr>
              <Th className="w-8"> </Th>
              <Th>Draft</Th>
              <Th>Brand</Th>
              <Th>Status</Th>
              <Th>Walmart</Th>
              <Th className="text-right">Cost (¢)</Th>
              <Th className="text-right">Price (¢)</Th>
              <Th className="text-right">Updated</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rowState = state[row.id] ?? { phase: "idle" as const };
              return (
                <tr
                  key={row.id}
                  className="border-t border-rule align-top transition-colors hover:bg-surface-tint/50"
                >
                  <Td>
                    {isPublishable(row) && (
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                        disabled={batchRunning || rowState.phase === "publishing"}
                      />
                    )}
                  </Td>
                  <Td>
                    <Link href={`/bundle-factory/drafts/${row.id}`} className="group block">
                      <div className="font-medium text-green-ink group-hover:underline">
                        {row.draft_name}
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">
                        {row.walmart?.sku ?? row.id}
                      </div>
                    </Link>
                  </Td>
                  <Td>{row.brand}</Td>
                  <Td>
                    <StatusPill status={row.status} />
                  </Td>
                  <Td>
                    <WalmartCell
                      row={row}
                      rowState={rowState}
                      busy={batchRunning}
                      onPublish={() => void publishOne(row)}
                      onRotateUpc={() => void rotateUpc(row)}
                    />
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-ink-2">
                    {row.draft_cost_cents?.toLocaleString("en-US") ?? "—"}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-ink-2">
                    {row.draft_suggested_price_cents?.toLocaleString("en-US") ?? "—"}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-ink-3">
                    {row.updated_at}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function WalmartCell({
  row,
  rowState,
  busy,
  onPublish,
  onRotateUpc,
}: {
  row: DraftRow;
  rowState: RowState;
  busy: boolean;
  onPublish: () => void;
  onRotateUpc: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!row.walmart) {
    return <span className="text-[11.5px] text-ink-3">no Walmart SKU</span>;
  }
  if (row.walmart.live_url) {
    return (
      <Link
        href={row.walmart.live_url}
        target="_blank"
        className="inline-flex items-center gap-1 text-[11.5px] text-green-ink hover:underline"
      >
        live <ExternalLink size={11} strokeWidth={2} />
      </Link>
    );
  }
  if (rowState.phase === "rotating") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2">
        <Loader2 size={12} strokeWidth={2} className="animate-spin" />
        replacing product ID…
      </span>
    );
  }
  if (rowState.phase === "publishing") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2">
        <Loader2 size={12} strokeWidth={2} className="animate-spin" />
        publishing…
      </span>
    );
  }
  if (rowState.phase === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-green-ink">
        <CheckCircle2 size={12} strokeWidth={2} />
        {rowState.message}
      </span>
    );
  }
  if (rowState.phase === "error") {
    return (
      <span className="block max-w-[340px] text-[11px] text-danger">
        {rowState.message}
      </span>
    );
  }
  if (needsUpcRotation(row)) {
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="text-[11.5px] text-warn-strong">
          product ID rejected by Walmart
        </span>
        <Btn variant="outline" size="sm" onClick={onRotateUpc} disabled={busy}>
          Replace product ID
        </Btn>
      </div>
    );
  }
  if (row.walmart.upc_quarantined) {
    return (
      <span className="block max-w-[320px] text-[11px] text-danger">
        product ID rejected {row.walmart.burned_upcs}× — needs a look at the
        payload, not another number
      </span>
    );
  }
  if (!isPublishable(row)) {
    return (
      <span className="text-[11.5px] text-ink-3">
        {row.walmart.validation_status.toLowerCase()}
      </span>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="text-[11.5px] text-green-ink">validated</span>
      {confirming ? (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-ink-3">
            ${(row.walmart.price_cents / 100).toFixed(2)}?
          </span>
          <Btn variant="primary" size="sm" onClick={onPublish} disabled={busy}>
            Yes
          </Btn>
          <Btn variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            No
          </Btn>
        </div>
      ) : (
        <Btn
          variant="outline"
          size="sm"
          onClick={() => setConfirming(true)}
          disabled={busy}
        >
          Publish
        </Btn>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  // Same palette buckets the page used before this table became interactive.
  let tone = "border-rule bg-bg-elev text-ink-2";
  if (status === "APPROVED" || status === "LIVE" || status === "PUBLISHED") {
    tone = "border-green-soft2 bg-green-soft text-green-ink";
  } else if (status === "ERROR" || status === "SUSPENDED") {
    tone = "border-warn-strong/40 bg-warn-tint text-warn-strong";
  } else if (
    status === "VARIATION_SELECTED" ||
    status === "GENERATED" ||
    status === "VALIDATED" ||
    status === "QUEUED" ||
    status === "SUBMITTED" ||
    status === "PROCESSING"
  ) {
    tone = "border-info/30 bg-info-tint text-info";
  }
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-wider ${tone}`}
    >
      {status}
    </span>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <th className={`px-3 py-2 text-left font-medium ${className}`}>{children}</th>;
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2.5 ${className}`}>{children}</td>;
}
