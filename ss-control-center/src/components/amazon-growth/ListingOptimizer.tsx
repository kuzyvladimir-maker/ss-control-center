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
import { RefreshCw, Eye, Check, Lock, ArrowUpRight, ArrowDownRight, ListChecks } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard } from "@/components/kit";
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
interface Summary {
  applied: number;
  measured: number;
  pendingMeasure: number;
  avgHealthDelta: number | null;
}
interface HistoryRow {
  sku: string;
  itemName: string | null;
  runAt: string;
  fixKinds: string[];
  changeCount: number;
  measured: boolean;
  beforeHealth: number | null;
  afterHealth: number | null;
  healthDelta: number | null;
  beforeErrors: number | null;
  afterErrors: number | null;
}
interface HeatItem {
  code: string;
  message: string;
  count: number;
}

const PAGE_SIZE = 60;

export function ListingOptimizer({ storeIndex }: { storeIndex: number }) {
  const [items, setItems] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [heatmap, setHeatmap] = useState<HeatItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "dry" | "apply">(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        storeIndex: String(storeIndex),
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/amazon/growth/optimizer?${params}`);
      if (res.ok) {
        const j = await res.json();
        setItems(j.worklist.items);
        setTotal(j.worklist.total);
        setSummary(j.summary ?? null);
        setHistory(j.history ?? []);
        setHeatmap(j.issueHeatmap ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [storeIndex, q, offset]);
  useEffect(() => {
    load();
    setSelected(new Set());
    setPlans(null);
  }, [load]);
  // Reset to first page when the store or search changes.
  useEffect(() => {
    setOffset(0);
  }, [storeIndex, q]);

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
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-3">
            <Lock size={11} /> Price, UPC, brand &amp; product type are never changed
          </span>
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

        {/* Pagination */}
        <div className="flex items-center justify-between gap-2 border-t border-rule px-3 py-2 text-[11px] text-ink-3">
          <span>
            {total ? `${offset + 1}–${Math.min(offset + items.length, total)} of ${total.toLocaleString()}` : "0 of 0"}
          </span>
          <div className="flex items-center gap-2">
            <Btn size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Prev</Btn>
            <Btn size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Btn>
          </div>
        </div>
      </Panel>

      {/* ── Impact (before / after) — closes the Grow loop ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Listings improved" value={summary ? summary.applied : "—"} icon={<ListChecks size={15} />} />
        <KpiCard
          label="Avg health lift"
          value={summary?.avgHealthDelta != null ? `${summary.avgHealthDelta > 0 ? "+" : ""}${summary.avgHealthDelta}` : "—"}
          icon={<ArrowUpRight size={15} />}
          iconVariant={summary?.avgHealthDelta != null && summary.avgHealthDelta > 0 ? "default" : "warn"}
        />
        <KpiCard label="Measured" value={summary ? summary.measured : "—"} />
        <KpiCard label="Awaiting measurement" value={summary ? summary.pendingMeasure : "—"} iconVariant="warn" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Impact history */}
        <Panel>
          <PanelHeader title="Impact — before / after" count={history.length} />
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-rule text-left text-[10.5px] font-mono uppercase tracking-wider text-ink-3">
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-2 py-2 font-medium">Fixed</th>
                  <th className="px-2 py-2 font-medium">Health</th>
                  <th className="px-2 py-2 text-right font-medium">Errors</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-ink-3">No fixes applied yet — run one above.</td>
                  </tr>
                ) : (
                  history.map((h, i) => (
                    <tr key={h.sku + i} className="border-b border-rule/60 hover:bg-bg-elev/40">
                      <td className="max-w-[260px] px-3 py-2">
                        <span className="block truncate text-ink">{h.itemName ?? h.sku}</span>
                        <span className="block text-[10px] text-ink-4">
                          {h.sku} · {new Date(h.runAt).toLocaleDateString()}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-[11px] text-ink-2">{h.fixKinds.join(", ") || "—"}</td>
                      <td className="px-2 py-2">
                        {!h.measured ? (
                          <span className="text-[11px] text-ink-3">{h.beforeHealth?.toFixed(0) ?? "—"} · pending</span>
                        ) : (
                          <Delta before={h.beforeHealth} after={h.afterHealth} d={h.healthDelta} />
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular text-ink-3">
                        {h.measured && h.afterErrors != null ? `${h.beforeErrors ?? "—"}→${h.afterErrors}` : (h.beforeErrors ?? "—")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Most-common-issues heatmap */}
        <Panel>
          <PanelHeader title="Most common errors" />
          <div className="space-y-1.5 p-3">
            {heatmap.length === 0 ? (
              <div className="text-[12px] text-ink-3">No errors found.</div>
            ) : (
              heatmap.map((g) => {
                const max = heatmap[0].count || 1;
                return (
                  <div key={g.code + g.message}>
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="truncate text-ink-2" title={g.message}>
                        {g.code && <span className="font-mono text-ink-3">{g.code} </span>}
                        {g.message}
                      </span>
                      <span className="tabular text-ink-3">{g.count}</span>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-bg-elev">
                      <div className="h-full rounded-full" style={{ width: `${(g.count / max) * 100}%`, background: "var(--warn)" }} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Delta({ before, after, d }: { before: number | null; after: number | null; d: number | null }) {
  const up = (d ?? 0) > 0;
  const down = (d ?? 0) < 0;
  const color = up ? "var(--green-ink)" : down ? "var(--danger)" : "var(--ink-3)";
  return (
    <span className="tabular text-[11.5px]">
      {before?.toFixed(0) ?? "—"} → <span style={{ color, fontWeight: 600 }}>{after?.toFixed(0) ?? "—"}</span>
      {d != null && d !== 0 && (
        <span className="ml-1 inline-flex items-center text-[10px]" style={{ color }}>
          {up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
          {Math.abs(d).toFixed(1)}
        </span>
      )}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded bg-green-soft px-1.5 py-0.5 text-[10px] font-medium text-green-ink">
      {children}
    </span>
  );
}
