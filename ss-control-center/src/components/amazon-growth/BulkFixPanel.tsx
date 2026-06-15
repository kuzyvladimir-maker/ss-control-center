"use client";

/**
 * Amazon Growth — Bulk fix (Walmart-style "filter → pool → Fix all").
 *
 * Filter the catalog with toggles + sliders → see the matching pool → pick which
 * safe fixes to run → one button enqueues the whole pool and a worker drains it,
 * applying the fixes via the Listings API. Progress + recent results below.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Square, RefreshCw, Wand2 } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard } from "@/components/kit";
import { cn } from "@/lib/utils";

interface Stats {
  requested: number;
  running: number;
  done: number;
  skipped: number;
  errored: number;
  changesTotal: number;
}
interface RecentRow {
  sku: string;
  itemName: string | null;
  status: string;
  changesApplied: number;
  result: string | null;
}

function Slider({ label, value, onChange, suffix }: { label: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3">{label}</span>
        <span className="text-[12px] font-semibold tabular text-ink">{value}{suffix}</span>
      </div>
      <input type="range" min={0} max={100} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-[var(--green)]" />
    </div>
  );
}

export function BulkFixPanel({ storeIndex }: { storeIndex: number }) {
  const [f, setF] = useState({ suppressed: false, hasErrors: true, notBuyable: false, oppMin: 0, healthMax: 100, q: "" });
  const [scope, setScope] = useState({ dedupe: true, brandVoice: true, suppression: true });
  const [match, setMatch] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [busy, setBusy] = useState<null | "enqueue" | "draining">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const autoRef = useRef(false);

  const qs = useCallback(() => {
    const p = new URLSearchParams({ storeIndex: String(storeIndex) });
    if (f.suppressed) p.set("suppressed", "1");
    if (f.hasErrors) p.set("hasErrors", "1");
    if (f.notBuyable) p.set("notBuyable", "1");
    if (f.oppMin > 0) p.set("oppMin", String(f.oppMin));
    if (f.healthMax < 100) p.set("healthMax", String(f.healthMax));
    if (f.q.trim()) p.set("q", f.q.trim());
    return p.toString();
  }, [f, storeIndex]);

  const poll = useCallback(async () => {
    const res = await fetch(`/api/amazon/growth/bulk-fix?${qs()}`);
    if (res.ok) {
      const j = await res.json();
      setMatch(j.match);
      setStats(j.stats);
      setRecent(j.recent ?? []);
      return j.stats as Stats;
    }
    return null;
  }, [qs]);

  // Debounced live match count as filters change.
  useEffect(() => {
    const t = setTimeout(poll, 300);
    return () => clearTimeout(t);
  }, [poll]);

  async function fixAll() {
    if (!scope.dedupe && !scope.brandVoice && !scope.suppression) {
      setMsg("Select at least one fix.");
      return;
    }
    setBusy("enqueue");
    setMsg(null);
    try {
      const res = await fetch("/api/amazon/growth/bulk-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeIndex, filter: f, scope }),
      });
      const j = await res.json();
      if (!j.ok) {
        setMsg(`Error: ${j.error}`);
        setBusy(null);
        return;
      }
      setMsg(`Queued ${j.queued} listings. Worker running…`);
      autoRef.current = true;
      await drainLoop();
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
      setBusy(null);
    }
  }

  // Process the queue batch-by-batch until empty or stopped.
  async function drainLoop() {
    setBusy("draining");
    try {
      for (let i = 0; i < 200 && autoRef.current; i++) {
        const res = await fetch("/api/amazon/growth/bulk-fix/drain", { method: "POST" });
        const j = await res.json();
        const s = await poll();
        if (!j.ok) {
          setMsg(`Worker error: ${j.error}`);
          break;
        }
        if (!s || s.requested + s.running === 0) break;
      }
    } finally {
      autoRef.current = false;
      setBusy(null);
    }
  }

  function stop() {
    autoRef.current = false;
  }

  const active = (stats?.requested ?? 0) + (stats?.running ?? 0);
  const finished = (stats?.done ?? 0) + (stats?.skipped ?? 0) + (stats?.errored ?? 0);
  const total = active + finished;
  const pct = total ? Math.round((finished / total) * 100) : 0;

  return (
    <Panel>
      <PanelHeader
        title="Bulk fix — filter → pool → fix all"
        right={<Btn size="sm" icon={<RefreshCw size={13} />} onClick={poll}>Refresh</Btn>}
      />
      <div className="grid gap-0 md:grid-cols-[300px_1fr]">
        {/* Filters */}
        <div className="space-y-3 border-rule p-4 md:border-r">
          <input
            value={f.q}
            onChange={(e) => setF({ ...f, q: e.target.value })}
            placeholder="Search product / SKU / ASIN…"
            className="h-7 w-full rounded-md border border-rule bg-surface px-2 text-[12px] text-ink placeholder:text-ink-4 focus:border-green-mid focus:outline-none"
          />
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.suppressed} onChange={(e) => setF({ ...f, suppressed: e.target.checked })} /> Suppressed only</label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.hasErrors} onChange={(e) => setF({ ...f, hasErrors: e.target.checked })} /> Has errors</label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.notBuyable} onChange={(e) => setF({ ...f, notBuyable: e.target.checked })} /> Not buyable</label>
          <Slider label="Opportunity — at least" value={f.oppMin} onChange={(v) => setF({ ...f, oppMin: v })} />
          <Slider label="Health — at most" value={f.healthMax} onChange={(v) => setF({ ...f, healthMax: v })} />

          <div className="border-t border-rule pt-3 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">Fixes to apply</div>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={scope.dedupe} onChange={(e) => setScope({ ...scope, dedupe: e.target.checked })} /> Dedupe duplicate attributes</label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={scope.brandVoice} onChange={(e) => setScope({ ...scope, brandVoice: e.target.checked })} /> Brand-voice scrub (title)</label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={scope.suppression} onChange={(e) => setScope({ ...scope, suppression: e.target.checked })} /> Suppression attrs (unit_count / weight)</label>
          <div className="rounded-lg bg-bg-elev px-3 py-2 text-[11px] text-ink-3">Only safe, derivable fixes are written; anything not confidently derivable is skipped with a reason. Price, UPC, brand &amp; product type are never changed.</div>
        </div>

        {/* Pool + run + progress */}
        <div className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-baseline gap-3">
              <span className="text-[26px] font-semibold tabular text-ink">{match == null ? "…" : match.toLocaleString()}</span>
              <span className="text-[12px] text-ink-3">listings match this filter</span>
            </div>
            <div className="flex items-center gap-2">
              {busy === "draining" ? (
                <Btn variant="outline" icon={<Square size={13} />} onClick={stop}>Stop</Btn>
              ) : null}
              <Btn variant="primary" icon={<Wand2 size={13} />} loading={busy != null} disabled={!match} onClick={fixAll}>
                Fix all {match ? match.toLocaleString() : ""} matching
              </Btn>
            </div>
          </div>
          {msg && <div className="mb-3 rounded-lg border border-rule bg-green-soft px-3 py-2 text-[12px] text-green-ink">{msg}</div>}

          {/* Progress */}
          {stats && total > 0 && (
            <div className="mb-3 rounded-lg border border-rule bg-bg-elev/40 p-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="font-mono uppercase tracking-[0.08em] text-ink-3">
                  Worker progress {active > 0 && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-ink align-middle" />}
                </span>
                <span className="text-ink-2">{finished} / {total} · {pct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-rule/40">
                <div className="h-full rounded-full bg-green-ink transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
                <span>Queued: <b className="text-ink-2">{stats.requested}</b></span>
                <span>Fixed: <b className="text-green-ink">{stats.done}</b></span>
                <span>Skipped: <b className="text-ink-2">{stats.skipped}</b></span>
                {stats.errored > 0 && <span>Errors: <b className="text-red-ink">{stats.errored}</b></span>}
                <span>Changes written: <b className="text-green-ink">{stats.changesTotal}</b></span>
              </div>
            </div>
          )}

          {/* KPI summary */}
          {stats && (
            <div className="mb-3 grid grid-cols-3 gap-3">
              <KpiCard label="Listings fixed" value={stats.done} />
              <KpiCard label="Changes written" value={stats.changesTotal} icon={<Play size={14} />} />
              <KpiCard label="Skipped" value={stats.skipped} iconVariant="warn" />
            </div>
          )}

          {/* Recent results */}
          {recent.length > 0 && (
            <div className="max-h-[260px] overflow-auto rounded-lg border border-rule">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-rule text-left text-[10px] font-mono uppercase tracking-wider text-ink-3">
                    <th className="px-2 py-1.5">Product</th>
                    <th className="px-2 py-1.5">Status</th>
                    <th className="px-2 py-1.5">What was done</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r, i) => (
                    <tr key={r.sku + i} className="border-b border-rule/50">
                      <td className="max-w-[240px] px-2 py-1.5"><span className="block truncate text-ink">{r.itemName ?? r.sku}</span></td>
                      <td className="px-2 py-1.5">
                        <span className={cn("text-[11px]", r.status === "DONE" ? "text-green-ink" : r.status === "ERROR" ? "text-danger" : "text-ink-3")}>
                          {r.status === "DONE" ? `fixed (${r.changesApplied})` : r.status.toLowerCase()}
                        </span>
                      </td>
                      <td className="max-w-[420px] px-2 py-1.5 text-[11px] text-ink-3"><span className="block truncate" title={r.result ?? ""}>{r.result}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
