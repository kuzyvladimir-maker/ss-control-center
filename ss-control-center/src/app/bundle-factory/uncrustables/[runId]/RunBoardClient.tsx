/**
 * Uncrustables Studio — run board client.
 *
 * Tick-driven rendering: while any candidate sits in PLANNED / RENDER_QUEUED /
 * RENDERING, the board POSTs /tick (one render per request, up to ~5 min) and
 * refetches the board every ~5s. Candidate cards show state, the 2048px R2
 * thumb, attempts and errors, with rerender + review actions.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface RecipeComp {
  flavor: string;
  qty: number;
  box_size: number;
  box_count: number;
  donor_title: string | null;
}

interface BoardCandidate {
  id: string;
  slug: string;
  state: string;
  title: string;
  recipe: { comps: RecipeComp[]; total: number; band: string; cooler: string } | null;
  price_cents: number;
  pack_count: number;
  render_attempts: number;
  main_image_url: string | null;
  pixel_width: number | null;
  pixel_height: number | null;
  reviewed_by: string | null;
  reject_reason: string | null;
  last_error: string | null;
}

interface BoardData {
  run: { id: string; name: string };
  candidates: BoardCandidate[];
  pending_count: number;
}

const ACTIVE_STATES = ["PLANNED", "RENDER_QUEUED", "RENDERING"];
const QUEUEABLE_STATES = ["PLANNED", "RENDER_QUEUED"];
const RERENDERABLE_STATES = ["RENDERED", "REJECTED", "FAILED"];

const STATE_STYLES: Record<string, string> = {
  PLANNED: "border-rule bg-bg-elev text-ink-2",
  RENDER_QUEUED: "border-amber-300 bg-amber-50 text-amber-800",
  RENDERING: "border-sky-300 bg-sky-50 text-sky-800",
  RENDERED: "border-green-soft2 bg-green-soft text-green-ink",
  REJECTED: "border-red-200 bg-red-50 text-red-700",
  APPROVED: "border-green-soft2 bg-green-soft text-green-ink",
  STAGED: "border-green-soft2 bg-green-soft text-green-ink",
  VALIDATED: "border-green-soft2 bg-green-soft text-green-ink",
  PROOFED: "border-green-soft2 bg-green-soft text-green-ink",
  SUBMITTED: "border-sky-300 bg-sky-50 text-sky-800",
  LIVE: "border-green-soft2 bg-green-soft text-green-ink",
  FAILED: "border-red-200 bg-red-50 text-red-700",
};

function StateChip({ state }: { state: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${STATE_STYLES[state] ?? "border-rule bg-bg-elev text-ink-2"}`}
    >
      {state.replace(/_/g, " ")}
    </span>
  );
}

export function RunBoardClient({ runId }: { runId: string }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastTickNote, setLastTickNote] = useState<string | null>(null);
  const tickBusy = useRef(false);
  const alive = useRef(true);

  const fetchBoard = useCallback(async () => {
    try {
      const response = await fetch(`/api/bundle-factory/uncrustables/runs/${runId}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: BoardData = await response.json();
      if (alive.current) {
        setBoard(data);
        setLoadError(null);
      }
      return data;
    } catch (error) {
      if (alive.current) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
      return null;
    }
  }, [runId]);

  const tick = useCallback(async () => {
    if (tickBusy.current) return;
    tickBusy.current = true;
    try {
      const response = await fetch(
        `/api/bundle-factory/uncrustables/runs/${runId}/tick`,
        { method: "POST" },
      );
      const data = await response.json();
      if (alive.current && data?.claimed) {
        setLastTickNote(
          data.state === "RENDERED"
            ? `Rendered ${data.slug} (attempt ${data.render_attempts})`
            : `${data.slug}: ${data.state} (attempt ${data.render_attempts})${data.error ? ` — ${String(data.error).slice(0, 160)}` : ""}`,
        );
      }
    } catch {
      // Transient tick failures are fine — the next poll retries.
    } finally {
      tickBusy.current = false;
      if (alive.current) void fetchBoard();
    }
  }, [runId, fetchBoard]);

  useEffect(() => {
    alive.current = true;
    void fetchBoard();
    const interval = setInterval(() => {
      void fetchBoard();
    }, 5000);
    return () => {
      alive.current = false;
      clearInterval(interval);
    };
  }, [fetchBoard]);

  // Drive a tick whenever candidates are queued and no tick is in flight.
  useEffect(() => {
    if (!board) return;
    const hasQueued = board.candidates.some((c) => QUEUEABLE_STATES.includes(c.state));
    if (hasQueued && !tickBusy.current) void tick();
  }, [board, tick]);

  async function rerender(candidateId: string) {
    try {
      await fetch(
        `/api/bundle-factory/uncrustables/candidates/${candidateId}/rerender`,
        { method: "POST" },
      );
    } finally {
      void fetchBoard();
    }
  }

  if (loadError && !board) {
    return <p className="text-[12.5px] text-red-600">Failed to load board: {loadError}</p>;
  }
  if (!board) {
    return <p className="text-[12.5px] text-ink-3">Loading board...</p>;
  }

  const active = board.candidates.filter((c) => ACTIVE_STATES.includes(c.state)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-3">
        <span className="font-mono tabular-nums">
          {board.candidates.length} candidates · {active} in the render pipeline
        </span>
        {active > 0 && (
          <span className="inline-flex items-center gap-1.5 text-sky-700">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
            rendering runs one candidate per tick
          </span>
        )}
        {lastTickNote && <span className="truncate">{lastTickNote}</span>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {board.candidates.map((c) => (
          <div key={c.id} className="flex flex-col rounded-[14px] border border-rule bg-surface">
            <div className="flex items-center justify-between gap-2 px-4 pt-3">
              <span className="truncate font-mono text-[12.5px] font-medium text-ink">
                {c.slug}
              </span>
              <StateChip state={c.state} />
            </div>
            <div className="px-4 pt-2">
              {c.main_image_url ? (
                <Link href={`/bundle-factory/uncrustables/${runId}/review/${c.id}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.main_image_url}
                    alt={`MAIN candidate ${c.slug}`}
                    className="aspect-square w-full rounded-md border border-rule object-contain"
                  />
                </Link>
              ) : (
                <div className="flex aspect-square w-full items-center justify-center rounded-md border border-dashed border-rule bg-bg-elev text-[11.5px] text-ink-4">
                  {ACTIVE_STATES.includes(c.state) ? "Waiting for render" : "No image"}
                </div>
              )}
            </div>
            <div className="space-y-1 px-4 py-3 text-[11.5px] text-ink-3">
              <div className="font-mono tabular-nums">
                {c.pack_count}ct · band {c.recipe?.band ?? "?"} · $
                {(c.price_cents / 100).toFixed(2)} · attempts {c.render_attempts}
                {c.pixel_width ? ` · ${c.pixel_width}x${c.pixel_height}` : ""}
              </div>
              {c.recipe && (
                <div className="truncate">
                  {c.recipe.comps
                    .map((comp) => `${comp.box_count} × ${comp.box_size}ct`)
                    .join(" + ")}
                </div>
              )}
              {c.reviewed_by && <div>Approved by {c.reviewed_by}</div>}
              {c.reject_reason && (
                <div className="text-red-700">Reject: {c.reject_reason}</div>
              )}
              {c.last_error && (
                <div className="break-words text-red-700">
                  {c.last_error.slice(0, 200)}
                </div>
              )}
            </div>
            <div className="mt-auto flex items-center gap-2 border-t border-rule px-4 py-2.5">
              {c.state === "RENDERED" && (
                <Link
                  href={`/bundle-factory/uncrustables/${runId}/review/${c.id}`}
                  className="inline-flex h-7 items-center rounded-md border border-green-soft2 bg-green-soft px-3 text-[11.5px] font-medium text-green-ink transition-colors hover:bg-green-soft2"
                >
                  Review
                </Link>
              )}
              {RERENDERABLE_STATES.includes(c.state) && (
                <button
                  type="button"
                  onClick={() => void rerender(c.id)}
                  className="inline-flex h-7 items-center rounded-md border border-rule bg-surface px-3 text-[11.5px] text-ink-2 transition-colors hover:bg-bg-elev"
                >
                  Rerender
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
