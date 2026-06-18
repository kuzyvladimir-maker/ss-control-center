"use client";

/**
 * Amazon Growth — Change Log (audit trail).
 *
 * Every write we made to a listing: what, when, source, before→after values +
 * metrics, and the measured outcome (useful / neutral / harmful). Filter by
 * outcome/source/SKU; roll back attribute changes one click.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Undo2 } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard } from "@/components/kit";
import { cn } from "@/lib/utils";

interface ChangeRow {
  id: string;
  sku: string;
  asin: string | null;
  itemName: string | null;
  source: string;
  changeType: string;
  field: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  amazonStatus: string | null;
  beforeHealthScore: number | null;
  afterHealthScore: number | null;
  beforeConversion: number | null;
  afterConversion: number | null;
  beforeErrorCount: number | null;
  afterErrorCount: number | null;
  outcome: string | null;
  didConfidence: string | null;
  didLiftConvPp: number | null;
  didLiftRevPerDay: number | null;
  didControlN: number | null;
  rolledBack: boolean;
  createdAt: string;
  afterMeasuredAt: string | null;
  canRollback: boolean;
}
interface LogResponse {
  summary: { total: number; useful: number; neutral: number; harmful: number; pending: number };
  changes: ChangeRow[];
  worklist: { total: number };
}

function compact(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  } catch {
    return String(v);
  }
}
function delta(before: number | null, after: number | null): { txt: string; cls: string } {
  if (after == null || before == null) return { txt: "pending", cls: "text-ink-4" };
  const d = after - before;
  const cls = d > 0.5 ? "text-green-ink" : d < -0.5 ? "text-danger" : "text-ink-3";
  return { txt: `${before.toFixed(0)}→${after.toFixed(0)}${d !== 0 ? ` (${d > 0 ? "+" : ""}${d.toFixed(0)})` : ""}`, cls };
}
const OUTCOME_CLS: Record<string, string> = {
  useful: "text-green-ink",
  neutral: "text-ink-3",
  harmful: "text-danger",
};

// Word-level diff for title scrubs (removal-only): words present in `before`
// but gone from `after` are highlighted red-strike so a one-word change pops.
function WordDiff({ before, after }: { before: string; after: string }) {
  const kept = new Set(after.split(/\s+/).map((w) => w.trim()).filter(Boolean));
  const toks = before.split(/(\s+)/);
  return (
    <span>
      {toks.map((tok, i) => {
        const w = tok.trim();
        if (!w) return <span key={i}>{tok}</span>;
        return kept.has(w) ? (
          <span key={i} className="text-ink-3">{tok}</span>
        ) : (
          <span key={i} className="rounded px-0.5 line-through" style={{ background: "var(--danger-tint)", color: "var(--danger)" }}>{tok}</span>
        );
      })}
    </span>
  );
}

type OutcomeFilter = "all" | "useful" | "neutral" | "harmful" | "pending";

export function ChangeLogPanel({ storeIndex }: { storeIndex: number }) {
  const [data, setData] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [source, setSource] = useState("all");
  const [q, setQ] = useState("");
  const [rolling, setRolling] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ storeIndex: String(storeIndex), limit: "100" });
      if (outcome !== "all") p.set("outcome", outcome);
      if (source !== "all") p.set("source", source);
      if (q.trim()) p.set("sku", q.trim());
      const res = await fetch(`/api/amazon/growth/changelog?${p}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [storeIndex, outcome, source, q]);
  useEffect(() => {
    load();
  }, [load]);

  async function rollback(id: string) {
    if (!confirm("Roll this change back on Amazon?")) return;
    setRolling(id);
    setMsg(null);
    try {
      const res = await fetch("/api/amazon/growth/changelog/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = await res.json();
      setMsg(j.ok ? "Rolled back ✓" : `Rollback failed: ${j.error}`);
      if (j.ok) await load();
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setRolling(null);
    }
  }

  const s = data?.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-ink-3">Every listing change we made — for rollback and before/after analytics</div>
        <Btn icon={<RefreshCw size={13} />} onClick={load} loading={loading}>Refresh</Btn>
      </div>

      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <KpiCard label="Total changes" value={s.total} active={outcome === "all"} onClick={() => setOutcome("all")} />
          <KpiCard label="Useful" value={s.useful} active={outcome === "useful"} onClick={() => setOutcome("useful")} />
          <KpiCard label="Neutral" value={s.neutral} active={outcome === "neutral"} onClick={() => setOutcome("neutral")} />
          <KpiCard label="Harmful" value={s.harmful} iconVariant="danger" active={outcome === "harmful"} onClick={() => setOutcome("harmful")} />
          <KpiCard label="Awaiting measure" value={s.pending} iconVariant="warn" active={outcome === "pending"} onClick={() => setOutcome("pending")} />
        </div>
      )}

      <Panel>
        <PanelHeader
          title="Change log"
          count={data?.worklist.total}
          right={
            <div className="flex items-center gap-2">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU…" className="h-7 w-32 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink placeholder:text-ink-4 focus:outline-none" />
              <select value={source} onChange={(e) => setSource(e.target.value)} className="h-7 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink-2">
                <option value="all">All sources</option>
                <option value="bulk">Bulk</option>
                <option value="advisor">Advisor</option>
                <option value="optimizer">Optimizer</option>
                <option value="manual">Manual / rollback</option>
              </select>
              {msg && <span className="text-[11px] text-ink-3">{msg}</span>}
            </div>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left text-[10px] font-mono uppercase tracking-wider text-ink-3">
                <th className="px-3 py-2">When</th>
                <th className="px-2 py-2">Product</th>
                <th className="px-2 py-2">Change</th>
                <th className="px-2 py-2">Before → after</th>
                <th className="px-2 py-2">Health</th>
                <th className="px-2 py-2">Lift (DiD)</th>
                <th className="px-2 py-2">Outcome</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-3">Loading…</td></tr>
              ) : data && data.changes.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-3">No changes logged yet.</td></tr>
              ) : (
                data?.changes.map((c) => {
                  const h = delta(c.beforeHealthScore, c.afterHealthScore);
                  return (
                    <tr key={c.id} className={cn("border-b border-rule/60 hover:bg-bg-elev/40", c.rolledBack && "opacity-50")}>
                      <td className="whitespace-nowrap px-3 py-2 text-[11px] text-ink-3">{new Date(c.createdAt).toLocaleString()}</td>
                      <td className="max-w-[220px] px-2 py-2">
                        <span className="block truncate text-ink">{c.itemName ?? c.sku}</span>
                        <span className="block text-[10px] text-ink-4">{c.sku} · {c.source}</span>
                      </td>
                      <td className="px-2 py-2 text-ink-2">
                        <span className="font-mono text-[11px]">{c.changeType}</span>
                        {c.field && <span className="block text-[10px] text-ink-4">{c.field}</span>}
                      </td>
                      <td className="max-w-[280px] px-2 py-2 text-[11px]">
                        {c.changeType === "title-scrub" && typeof c.beforeValue === "string" && typeof c.afterValue === "string" ? (
                          <WordDiff before={c.beforeValue} after={c.afterValue} />
                        ) : (
                          <>
                            <span className="text-ink-4 line-through">{compact(c.beforeValue)}</span>
                            <span className="text-green-ink"> → {compact(c.afterValue)}</span>
                          </>
                        )}
                      </td>
                      <td className={cn("whitespace-nowrap px-2 py-2 tabular text-[11px]", h.cls)}>{h.txt}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-[11px]">
                        {c.didConfidence == null ? (
                          <span className="text-ink-4">—</span>
                        ) : c.didConfidence === "insufficient" ? (
                          <span className="text-ink-4" title="not enough traffic/coverage to measure">n/a</span>
                        ) : (
                          <span
                            className={cn("tabular", (c.didLiftConvPp ?? 0) > 0 ? "text-green-ink" : (c.didLiftConvPp ?? 0) < 0 ? "text-danger" : "text-ink-3")}
                            title={`conversion ${(c.didLiftConvPp ?? 0) > 0 ? "+" : ""}${c.didLiftConvPp}pp · revenue ${(c.didLiftRevPerDay ?? 0) > 0 ? "+" : ""}$${c.didLiftRevPerDay}/day · ${c.didControlN} controls · ${c.didConfidence} confidence`}
                          >
                            {(c.didLiftConvPp ?? 0) > 0 ? "+" : ""}{c.didLiftConvPp}pp
                            <span className="ml-1 text-[9px] text-ink-4">{c.didConfidence}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {c.rolledBack ? (
                          <span className="text-[11px] text-ink-4">rolled back</span>
                        ) : c.outcome ? (
                          <span className={cn("text-[11px] font-medium", OUTCOME_CLS[c.outcome])}>{c.outcome}</span>
                        ) : (
                          <span className="text-[11px] text-ink-4">pending</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {c.canRollback && (
                          <Btn size="sm" variant="outline" icon={<Undo2 size={12} />} onClick={() => rollback(c.id)} loading={rolling === c.id}>
                            Roll back
                          </Btn>
                        )}
                      </td>
                    </tr>
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
