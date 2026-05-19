"use client";

/**
 * Client island for the brief detail page. Owns:
 *   - The "Run Research" button (POST /research/run)
 *   - Polling while research is IN_PROGRESS
 *   - Inline edit + delete on individual ResearchPool rows
 *   - "Approve research → Variation matrix" button at RESEARCHED status
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Btn } from "@/components/kit";

interface PoolRow {
  id: string;
  product_name: string;
  brand: string;
  pack_sizes: string | null;
  flavors: string | null;
  weight_oz: number | null;
  allergens: string | null;
  storage_temp: string | null;
  avg_price_cents: number | null;
  freshness_score: number | null;
  source_url: string | null;
  reference_image_urls: string;
}

interface Props {
  briefId: string;
  initialStatus: string;
  initialPoolSize: number;
  initialPool: PoolRow[];
  latestStageError: string | null;
  researchInProgress: boolean;
}

function safeParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function BriefDetailClient(props: Props) {
  const router = useRouter();
  const [status, setStatus] = useState(props.initialStatus);
  const [pool, setPool] = useState<PoolRow[]>(props.initialPool);
  const [running, setRunning] = useState(props.researchInProgress);
  const [error, setError] = useState<string | null>(props.latestStageError);
  const [busy, setBusy] = useState(false);

  // Poll the brief endpoint every 3s while research is in progress so the
  // UI flips to RESEARCHED automatically without manual refresh.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const r = await fetch(`/api/bundle-factory/briefs/${props.briefId}`);
        if (!r.ok) return;
        const data = (await r.json()) as {
          brief: { status: string };
          research_pool: PoolRow[];
          stages: Array<{ stage: string; status: string; error: string | null }>;
        };
        if (cancelled) return;
        const stillRunning = data.stages.some(
          (s) => s.stage === "RESEARCH" && s.status === "IN_PROGRESS",
        );
        const failed = data.stages.find(
          (s) => s.stage === "RESEARCH" && s.status === "FAILED",
        );
        setStatus(data.brief.status);
        setPool(data.research_pool);
        setRunning(stillRunning);
        if (failed?.error) setError(failed.error);
        if (!stillRunning) {
          // Refresh server-rendered stage progress + header.
          router.refresh();
        }
      } catch {
        /* ignore — keep polling */
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [running, props.briefId, router]);

  async function runResearch() {
    setBusy(true);
    setError(null);
    setRunning(true);
    try {
      const r = await fetch("/api/bundle-factory/research/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle_draft_id: props.briefId }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

      // Immediately reflect new state without waiting for the next poll.
      const brief = await fetch(
        `/api/bundle-factory/briefs/${props.briefId}`,
      ).then((res) => res.json());
      setStatus(brief.brief.status);
      setPool(brief.research_pool);
      setRunning(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    } finally {
      setBusy(false);
    }
  }

  async function removeRow(id: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/bundle-factory/research/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPool((p) => p.filter((row) => row.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function approveResearch() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/briefs/${props.briefId}/approve-research`,
        { method: "POST" },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setStatus("VARIATION_SELECTED");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const showRunButton = status === "DRAFT" && !running;
  const showSpinner = running;
  const showPool = pool.length > 0;
  const canApprove = status === "RESEARCHED" && pool.length >= 5;
  const approveDisabled = status === "RESEARCHED" && pool.length < 5;

  return (
    <div className="space-y-4">
      <section className="rounded-[14px] border border-rule bg-surface p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-ink">
            Research pool ({pool.length})
          </h2>
          <div className="flex items-center gap-2">
            {showRunButton && (
              <Btn variant="primary" onClick={runResearch} loading={busy}>
                Run Research →
              </Btn>
            )}
            {status === "RESEARCHED" && (
              <>
                <Btn variant="ghost" onClick={runResearch} loading={busy}>
                  Re-run research
                </Btn>
                <Btn
                  variant="primary"
                  onClick={approveResearch}
                  disabled={!canApprove || busy}
                  loading={busy}
                >
                  Continue to Variation Matrix →
                </Btn>
              </>
            )}
            {status === "VARIATION_SELECTED" && (
              <span className="text-[12px] text-ink-3">
                Research approved — Phase 2.2 (Variation Matrix) lands next.
              </span>
            )}
          </div>
        </div>

        {approveDisabled && (
          <p className="mt-3 text-[12px] text-warn">
            Pool too small ({pool.length}/5). Re-run research or curate to reach
            5+ items before continuing.
          </p>
        )}

        {showSpinner && (
          <div className="mt-4 flex items-center gap-3 rounded-md border border-warn-strong/30 bg-warn-tint/40 px-3 py-2 text-[12.5px] text-warn-strong">
            <Spinner />
            Researching… Perplexity typically returns in ~30 seconds; image
            mirroring adds a few more.
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-danger/30 bg-danger-tint/40 p-3 text-[12.5px] text-danger">
            <div className="font-medium">Research failed</div>
            <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
              {error}
            </div>
            <div className="mt-2">
              <Btn variant="ghost" onClick={runResearch}>
                Retry
              </Btn>
            </div>
          </div>
        )}

        {!showRunButton && !showSpinner && !showPool && !error && (
          <p className="mt-3 text-[12.5px] text-ink-3">
            No research items in the pool yet.
          </p>
        )}

        {showPool && (
          <div className="mt-4 overflow-x-auto rounded-md border border-rule">
            <table className="min-w-full text-[12px] text-ink">
              <thead className="bg-surface-tint text-[10.5px] uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">Pack / Flavors</th>
                  <th className="px-3 py-2 text-left">Storage</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-left">Freshness</th>
                  <th className="px-3 py-2 text-left">Allergens</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {pool.map((row) => (
                  <PoolRowDisplay
                    key={row.id}
                    row={row}
                    onDelete={() => removeRow(row.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PoolRowDisplay({
  row,
  onDelete,
}: {
  row: PoolRow;
  onDelete: () => void;
}) {
  const packs = safeParse<string[]>(row.pack_sizes) ?? [];
  const flavors = safeParse<string[]>(row.flavors) ?? [];
  const allergens = safeParse<string[]>(row.allergens) ?? [];
  const images = safeParse<string[]>(row.reference_image_urls) ?? [];

  const freshnessBar = useMemo(() => {
    const v = Math.max(0, Math.min(100, row.freshness_score ?? 0));
    return v;
  }, [row.freshness_score]);

  return (
    <tr className="align-top hover:bg-bg-elev/40">
      <td className="px-3 py-2">
        <div className="flex items-start gap-2">
          {images[0] && (
            <img
              src={images[0]}
              alt=""
              className="h-10 w-10 shrink-0 rounded border border-rule object-cover"
              onError={(e) =>
                ((e.target as HTMLImageElement).style.display = "none")
              }
            />
          )}
          <div>
            <div className="font-medium text-ink">{row.product_name}</div>
            <div className="mt-0.5 text-[11px] text-ink-3">{row.brand}</div>
            {row.source_url && (
              <a
                href={row.source_url}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 inline-block text-[11px] text-green-ink hover:underline"
              >
                source ↗
              </a>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-ink-2">
        {packs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {packs.map((p) => (
              <span
                key={p}
                className="inline-flex items-center rounded bg-bg-elev px-1.5 py-0.5 text-[10.5px] text-ink-2"
              >
                {p}
              </span>
            ))}
          </div>
        )}
        {flavors.length > 0 && (
          <div className="mt-1 text-[11px] text-ink-3">
            {flavors.join(", ")}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-ink-2">{row.storage_temp ?? "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums text-ink-2">
        {row.avg_price_cents != null
          ? `$${(row.avg_price_cents / 100).toFixed(2)}`
          : "—"}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-elev">
            <div
              className="h-full rounded-full bg-green"
              style={{ width: `${freshnessBar}%` }}
            />
          </div>
          <span className="text-[11px] tabular-nums text-ink-3">
            {row.freshness_score ?? "—"}
          </span>
        </div>
      </td>
      <td className="px-3 py-2 text-[11px] text-ink-3">
        {allergens.length === 0 ? "—" : allergens.join(", ")}
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          onClick={onDelete}
          className="text-[11px] text-danger hover:underline"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      className="animate-spin"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
