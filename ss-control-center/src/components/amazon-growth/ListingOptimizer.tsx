"use client";

/**
 * Amazon Growth — Listing Optimizer.
 *
 * Deterministic, safe auto-fixes for the issue backlog: title brand-voice
 * scrub + duplicate-attribute dedupe. Flow: pick candidates → Preview
 * (before/after, no writes) → Apply (dry-run validation, then real PATCH).
 * Structural data gaps (missing unit_count etc.) are surfaced as "needs data"
 * and routed to the sourcing harvest — never guessed.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { RefreshCw, Eye, Check } from "lucide-react";
import { Btn, Panel, PanelHeader } from "@/components/kit";
import { cn } from "@/lib/utils";

interface Issue {
  code: string;
  message: string;
  severity: string;
  attributeNames: string[];
}
interface Candidate {
  sku: string;
  asin: string | null;
  itemName: string | null;
  productType: string | null;
  healthScore: number | null;
  complianceScore: number | null;
  errorIssueCount: number;
  fixes: { titleScrub: boolean; dedupe: boolean };
  issues: Issue[];
}
interface Change {
  kind: string;
  field: string;
  before: string;
  after: string;
}
interface Plan {
  sku: string;
  productType: string | null;
  changes: Change[];
  unfixable: string[];
  error?: string;
}
interface ApplyResult {
  sku: string;
  applied: boolean;
  dryRun: boolean;
  status?: string;
  changes?: number;
  skipped?: string;
  error?: string;
}

export function ListingOptimizer({ storeIndex }: { storeIndex: number }) {
  const [items, setItems] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "dry" | "apply">(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ storeIndex: String(storeIndex), limit: "80" });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/amazon/growth/optimizer?${params}`);
      if (res.ok) {
        const j = await res.json();
        setItems(j.worklist.items);
        setTotal(j.worklist.total);
      }
    } finally {
      setLoading(false);
    }
  }, [storeIndex, q]);
  useEffect(() => {
    load();
    setSelected(new Set());
    setPlans(null);
  }, [load]);

  function toggle(sku: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(sku)) n.delete(sku);
      else n.add(sku);
      return n;
    });
  }
  function selectAllVisible() {
    setSelected(new Set(items.slice(0, 25).map((i) => i.sku)));
  }

  async function preview() {
    if (selected.size === 0) return;
    setBusy("preview");
    setMsg(null);
    try {
      const res = await fetch("/api/amazon/growth/optimizer/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeIndex, skus: [...selected] }),
      });
      const j = await res.json();
      if (j.ok) {
        setPlans(j.plans);
        const withChanges = j.plans.filter((p: Plan) => p.changes.length > 0).length;
        setMsg(`${withChanges}/${j.plans.length} have safe fixes`);
      } else setMsg(`Preview error: ${j.error}`);
    } finally {
      setBusy(null);
    }
  }

  async function apply(dryRun: boolean) {
    if (selected.size === 0) return;
    setBusy(dryRun ? "dry" : "apply");
    setMsg(null);
    try {
      const res = await fetch("/api/amazon/growth/optimizer/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeIndex, skus: [...selected], dryRun }),
      });
      const j = await res.json();
      if (j.ok) {
        const results: ApplyResult[] = j.results;
        const ok = results.filter((r) => (dryRun ? r.status === "ACCEPTED" || r.status === "VALID" : r.applied)).length;
        const bad = results.filter((r) => r.error || r.status === "INVALID").length;
        setMsg(dryRun ? `Validation: ${ok} would apply, ${bad} flagged` : `Applied ${ok}, ${bad} failed — reloading`);
        if (!dryRun) {
          await load();
          setSelected(new Set());
          setPlans(null);
        }
      } else setMsg(`Apply error: ${j.error}`);
    } finally {
      setBusy(null);
    }
  }

  const planBySku = new Map((plans ?? []).map((p) => [p.sku, p]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-ink-3">
          Deterministic, safe auto-fixes — title brand-voice scrub &amp; duplicate-attribute dedupe.
          Structural gaps route to harvest, never guessed.
        </div>
        <Btn icon={<RefreshCw size={13} />} onClick={load} loading={loading}>
          Refresh
        </Btn>
      </div>

      <Panel>
        <PanelHeader
          title="Candidates"
          count={total}
          right={
            <div className="flex items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                className="h-7 w-40 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink placeholder:text-ink-4 focus:border-green-mid focus:outline-none"
              />
              <button onClick={selectAllVisible} className="text-[11.5px] text-green hover:text-green-deep">
                Select 25
              </button>
            </div>
          }
        />

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
          <span className="text-[12px] text-ink-2">{selected.size} selected</span>
          <Btn size="sm" variant="outline" icon={<Eye size={13} />} onClick={preview} loading={busy === "preview"} disabled={selected.size === 0}>
            Preview fixes
          </Btn>
          <Btn size="sm" variant="outline" onClick={() => apply(true)} loading={busy === "dry"} disabled={selected.size === 0}>
            Validate (dry-run)
          </Btn>
          <Btn size="sm" icon={<Check size={13} />} onClick={() => apply(false)} loading={busy === "apply"} disabled={selected.size === 0}>
            Apply for real
          </Btn>
          {msg && <span className="text-[11.5px] text-ink-3">{msg}</span>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-rule text-left text-[10.5px] font-mono uppercase tracking-wider text-ink-3">
                <th className="w-8 px-3 py-2"></th>
                <th className="px-2 py-2 font-medium">Product</th>
                <th className="px-2 py-2 font-medium">Health</th>
                <th className="px-2 py-2 text-right font-medium">Errors</th>
                <th className="px-2 py-2 font-medium">Fixes</th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-ink-3">Loading…</td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-ink-3">No fixable candidates.</td>
                </tr>
              ) : (
                items.map((it) => {
                  const plan = planBySku.get(it.sku);
                  return (
                    <Fragment key={it.sku}>
                      <tr className="border-b border-rule/60 hover:bg-bg-elev/40">
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={selected.has(it.sku)} onChange={() => toggle(it.sku)} />
                        </td>
                        <td className="max-w-[340px] px-2 py-2">
                          <span className="block truncate text-ink">{it.itemName ?? it.sku}</span>
                          <span className="block text-[11px] text-ink-4">
                            {it.sku}
                            {it.asin ? ` · ${it.asin}` : ""}
                          </span>
                        </td>
                        <td className="px-2 py-2 tabular text-ink-2">{it.healthScore?.toFixed(0) ?? "—"}</td>
                        <td className="px-2 py-2 text-right tabular">
                          <span className={cn(it.errorIssueCount > 0 ? "text-danger" : "text-ink-3")}>{it.errorIssueCount}</span>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1">
                            {it.fixes.titleScrub && <Tag>title</Tag>}
                            {it.fixes.dedupe && <Tag>dedupe</Tag>}
                            {!it.fixes.titleScrub && !it.fixes.dedupe && <span className="text-[11px] text-ink-4">data</span>}
                          </div>
                        </td>
                      </tr>
                      {plan && (
                        <tr className="border-b border-rule/60 bg-bg-elev/30">
                          <td></td>
                          <td colSpan={4} className="px-2 py-2 text-[11.5px]">
                            {plan.error ? (
                              <span className="text-danger">Preview failed: {plan.error}</span>
                            ) : plan.changes.length === 0 ? (
                              <span className="text-ink-4">No deterministic fix.{plan.unfixable.length > 0 ? ` Needs data: ${plan.unfixable[0]}` : ""}</span>
                            ) : (
                              <div className="space-y-1">
                                {plan.changes.map((c, i) => (
                                  <div key={i} className="flex flex-wrap items-baseline gap-1.5">
                                    <span className="font-mono text-[10px] uppercase text-ink-3">{c.kind}</span>
                                    <span className="text-ink-4 line-through">{c.before.slice(0, 90)}</span>
                                    <span className="text-green-ink">→ {c.after.slice(0, 90)}</span>
                                  </div>
                                ))}
                                {plan.unfixable.length > 0 && (
                                  <div className="text-ink-4">+ {plan.unfixable.length} need data (harvest)</div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded bg-green-soft px-1.5 py-0.5 text-[10px] font-medium text-green-ink">
      {children}
    </span>
  );
}
