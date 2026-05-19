"use client";

/**
 * Variation Matrix client island for the brief detail page.
 *
 * Renders when status=VARIATION_SELECTED. Owns:
 *   - "Generate variants" button (POST /briefs/[id]/generate-variations)
 *   - Variants table with Select action (POST /briefs/[id]/select-variation)
 *   - "Continue to content generation →" button → /bundle-factory/drafts/[id]
 *
 * The matrix is loaded on mount via /api/bundle-factory/drafts/[id].
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Btn } from "@/components/kit";

interface VariantComponent {
  research_pool_id: string;
  product_name: string;
  brand: string;
  qty: number;
  unit_price_cents: number;
}

interface Variant {
  idx: number;
  name: string;
  composition: VariantComponent[];
  cost_cents: number;
  suggested_price_cents: number;
  margin_cents: number;
  margin_pct: number;
  feasibility_score: number;
  notes: string;
}

interface VariationMatrix {
  id: string;
  bundle_draft_id: string;
  variants_json: string;
  selected_variant_idx: number | null;
  generated_at: string;
  selected_at: string | null;
}

interface Props {
  briefId: string;
}

export function VariationMatrixSection({ briefId }: Props) {
  const router = useRouter();
  const [matrix, setMatrix] = useState<VariationMatrix | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/bundle-factory/drafts/${briefId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as {
          draft: { variation_matrix: VariationMatrix | null };
        };
        if (cancelled) return;
        if (data.draft.variation_matrix) {
          setMatrix(data.draft.variation_matrix);
          setVariants(parseVariants(data.draft.variation_matrix.variants_json));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [briefId]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/briefs/${briefId}/generate-variations`,
        { method: "POST" },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const fresh = await fetch(`/api/bundle-factory/drafts/${briefId}`);
      const draftData = await fresh.json();
      setMatrix(draftData.draft.variation_matrix);
      setVariants(
        parseVariants(draftData.draft.variation_matrix?.variants_json ?? "[]"),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function selectVariant(idx: number) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/briefs/${briefId}/select-variation`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ variant_idx: idx }),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setMatrix((m) =>
        m ? { ...m, selected_variant_idx: idx, selected_at: data.selected_at } : m,
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-[14px] border border-rule bg-surface p-6 text-center text-[12.5px] text-ink-3">
        Loading variation matrix…
      </div>
    );
  }

  const selectedIdx = matrix?.selected_variant_idx ?? null;
  const hasMatrix = matrix && variants.length > 0;

  return (
    <section className="rounded-[14px] border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink">
          Variation Matrix{hasMatrix ? ` (${variants.length} variants)` : ""}
        </h2>
        <div className="flex items-center gap-2">
          {!hasMatrix && (
            <Btn variant="primary" onClick={generate} loading={busy}>
              Generate variants
            </Btn>
          )}
          {hasMatrix && (
            <Btn variant="ghost" onClick={generate} loading={busy}>
              Re-generate
            </Btn>
          )}
          {hasMatrix && selectedIdx !== null && (
            <Link
              href={`/bundle-factory/drafts/${briefId}`}
              className="inline-flex h-7 select-none items-center justify-center rounded-md border border-green bg-green px-2.5 text-[12px] font-medium text-cream hover:bg-green-deep"
            >
              Continue to content generation →
            </Link>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-danger/30 bg-danger-tint/40 p-3 text-[12.5px] text-danger">
          {error}
        </div>
      )}

      {!hasMatrix && !error && (
        <p className="mt-3 text-[12.5px] text-ink-3">
          No variants generated yet. Generation is deterministic and free —
          it builds 1–10 composition variants from the curated pool, with
          cost / margin / feasibility per variant.
        </p>
      )}

      {hasMatrix && (
        <div className="mt-4 overflow-x-auto rounded-md border border-rule">
          <table className="min-w-full text-[12px] text-ink">
            <thead className="bg-surface-tint text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left">Variant</th>
                <th className="px-3 py-2 text-left">Composition</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-right">Margin</th>
                <th className="px-3 py-2 text-left">Feasibility</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {variants.map((v) => {
                const isSelected = selectedIdx === v.idx;
                return (
                  <tr
                    key={v.idx}
                    className={`align-top hover:bg-bg-elev/40 ${isSelected ? "bg-green-soft/30" : ""}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{v.name}</div>
                      <div className="mt-0.5 text-[10.5px] text-ink-3">
                        {v.notes}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      <ul className="space-y-0.5">
                        {v.composition.map((c, i) => (
                          <li key={i} className="text-[11px]">
                            {c.qty}× {c.product_name}{" "}
                            <span className="text-ink-3">— {c.brand}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-2">
                      ${(v.cost_cents / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      ${(v.suggested_price_cents / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className="text-ink-2">
                        ${(v.margin_cents / 100).toFixed(2)}
                      </span>
                      <div className="text-[10.5px] text-ink-3">
                        {(v.margin_pct * 100).toFixed(0)}%
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-elev">
                          <div
                            className="h-full rounded-full bg-green"
                            style={{
                              width: `${Math.min(100, Math.max(0, v.feasibility_score))}%`,
                            }}
                          />
                        </div>
                        <span className="text-[11px] tabular-nums text-ink-3">
                          {v.feasibility_score}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isSelected ? (
                        <span className="inline-flex items-center rounded-md bg-green-soft px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-green-ink">
                          Selected
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => selectVariant(v.idx)}
                          className="text-[11px] text-green-ink hover:underline disabled:opacity-50"
                        >
                          Select
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function parseVariants(json: string): Variant[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Variant[]) : [];
  } catch {
    return [];
  }
}
