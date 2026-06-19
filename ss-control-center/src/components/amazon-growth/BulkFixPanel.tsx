"use client";

/**
 * Amazon Growth — Bulk fix builder (Walmart-style "filter → pool → fix all").
 *
 * Filter the catalog with presets + sliders + range sliders + health/status
 * chips → see the matching pool in a sortable, paginated table → check the
 * rows you want (or "apply to all N matching") → pick which safe fixes to run →
 * one button enqueues them and a worker drains the queue via the Listings API.
 * Live progress + recent results below.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Square, RefreshCw, Wand2, Lock, ExternalLink } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard } from "@/components/kit";
import { cn } from "@/lib/utils";

interface Candidate {
  sku: string;
  asin: string | null;
  itemName: string | null;
  productType: string | null;
  healthScore: number | null;
  opportunityScore: number | null;
  isBuyable: boolean;
  isSuppressed: boolean;
  errorIssueCount: number;
  sessions30d: number | null;
  unitsOrdered30d: number | null;
  unitSessionPct: number | null;
  buyBoxPercentage: number | null;
  revenue30d: number | null;
  returnRate: number | null;
  health: string;
}
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
interface ApiResp {
  match: number;
  counts: { match: number; suppressed: number; hasErrors: number };
  candidates: Candidate[];
  page: { limit: number; offset: number; total: number };
  stats: Stats;
  recent: RecentRow[];
}

const DEFAULT_FILTER = {
  q: "",
  suppressed: false,
  hasErrors: false,
  notBuyable: false,
  noBuyBox: false,
  oppMin: 0,
  healthMax: 100,
  sessMin: 0,
  errMin: 0,
  convMin: 0,
  convMax: 100,
  bbMin: 0,
  bbMax: 100,
  retMin: 0,
  retMax: 100,
  revMin: 0,
  revMax: 2000,
  unitsMin: 0,
  unitsMax: 100,
  health: "",
  status: "all",
  sort: "opportunity",
};
type Filter = typeof DEFAULT_FILTER;

const PRESETS: { id: string; label: string; f: Partial<Filter> }[] = [
  { id: "suppressed", label: "Suppressed — fix structure", f: { ...resetScopes(), suppressed: true, sort: "opportunity" } },
  { id: "leaky", label: "Leaky — traffic, no conversion", f: { ...resetScopes(), health: "leaky", sessMin: 10, sort: "traffic" } },
  { id: "highopp", label: "High opportunity", f: { ...resetScopes(), oppMin: 60, sort: "opportunity" } },
  { id: "errors", label: "Has errors", f: { ...resetScopes(), hasErrors: true, sort: "mostErrors" } },
  { id: "all", label: "Whole catalog", f: { ...resetScopes() } },
];
// Clears every narrowing filter (chips re-apply only their own keys).
function resetScopes(): Partial<Filter> {
  return {
    suppressed: false, hasErrors: false, notBuyable: false, noBuyBox: false,
    oppMin: 0, healthMax: 100, sessMin: 0, errMin: 0,
    convMin: 0, convMax: 100, bbMin: 0, bbMax: 100, retMin: 0, retMax: 100, revMin: 0, revMax: 2000, unitsMin: 0, unitsMax: 100,
    health: "", status: "all",
  };
}

const HEALTH_CHIPS = [
  { id: "", label: "All health" },
  { id: "winner", label: "Winner" },
  { id: "leaky", label: "Leaky" },
  { id: "high-return", label: "High-return" },
  { id: "dead", label: "Dead" },
  { id: "suppressed", label: "Suppressed" },
];
const STATUS_OPTS = [
  { id: "all", label: "All status" },
  { id: "buyable", label: "Buyable" },
  { id: "notBuyable", label: "Not buyable" },
  { id: "error", label: "Error" },
];
const SORTS = [
  { id: "opportunity", label: "Opportunity" },
  { id: "revenue", label: "Revenue $" },
  { id: "traffic", label: "Traffic" },
  { id: "units", label: "Units" },
  { id: "conversion", label: "Conversion" },
  { id: "buybox", label: "Buy Box %" },
  { id: "returns", label: "Return rate" },
  { id: "worstHealth", label: "Worst health" },
  { id: "mostErrors", label: "Most errors" },
];
const HEALTH_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  winner: { label: "Winner", bg: "var(--green-soft)", color: "var(--green-ink)" },
  leaky: { label: "Leaky", bg: "var(--warn-tint)", color: "var(--warn-strong)" },
  "high-return": { label: "High-return", bg: "var(--danger-tint)", color: "var(--danger)" },
  dead: { label: "Dead", bg: "var(--silver-tint)", color: "var(--silver-dark)" },
  suppressed: { label: "Suppressed", bg: "var(--danger-tint)", color: "var(--danger)" },
  new: { label: "New", bg: "var(--bg-elev)", color: "var(--ink-3)" },
};

function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toString().padStart(2, "0")}s`;
}
function fmt(n: number | null | undefined, d = 0) { return n == null ? "—" : Number(n).toFixed(d); }
function money(n: number | null | undefined) { return n == null ? "—" : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function pct(n: number | null | undefined, scale = 100, d = 1) { return n == null ? "—" : (Number(n) * (scale === 100 ? 100 : 1)).toFixed(d) + "%"; }

function Slider({ label, min = 0, max = 100, value, onChange, suffix }: { label: string; min?: number; max?: number; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3">{label}</span>
        <span className="text-[12px] font-semibold tabular text-ink">{value >= max ? `${value}+` : value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-[var(--green)]" />
    </div>
  );
}
function RangeTwo({ label, max, lo, hi, onLo, onHi, suffix }: { label: string; max: number; lo: number; hi: number; onLo: (v: number) => void; onHi: (v: number) => void; suffix?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3">{label}</span>
        <span className="text-[12px] font-semibold tabular text-ink">{lo}{suffix} – {hi >= max ? `${hi}+` : hi}{suffix}</span>
      </div>
      <input type="range" min={0} max={max} value={lo} onChange={(e) => onLo(Math.min(Number(e.target.value), hi))} className="mt-1 w-full accent-[var(--green)]" />
      <input type="range" min={0} max={max} value={hi} onChange={(e) => onHi(Math.max(Number(e.target.value), lo))} className="-mt-1 w-full accent-[var(--silver-dark)]" />
    </div>
  );
}

export function BulkFixPanel({ storeIndex }: { storeIndex: number }) {
  const [f, setF] = useState<Filter>(DEFAULT_FILTER);
  const [scope, setScope] = useState({ dedupe: true, brandVoice: true, suppression: true });
  const [pageSize, setPageSize] = useState(50);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [busy, setBusy] = useState<null | "enqueue" | "draining">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const autoRef = useRef(false);
  // Run timing — elapsed, ETA, and "last change N ago" so a stall is visible.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const [baseFinished, setBaseFinished] = useState(0);
  const [, setTick] = useState(0);
  const prevFinishedRef = useRef(0);

  const qs = useCallback(() => {
    const p = new URLSearchParams({ storeIndex: String(storeIndex), sort: f.sort, limit: String(pageSize), offset: String(offset) });
    if (f.q.trim()) p.set("q", f.q.trim());
    if (f.suppressed) p.set("suppressed", "1");
    if (f.hasErrors) p.set("hasErrors", "1");
    if (f.notBuyable) p.set("notBuyable", "1");
    if (f.noBuyBox) p.set("noBuyBox", "1");
    if (f.oppMin > 0) p.set("oppMin", String(f.oppMin));
    if (f.healthMax < 100) p.set("healthMax", String(f.healthMax));
    if (f.sessMin > 0) p.set("sessMin", String(f.sessMin));
    if (f.errMin > 0) p.set("errMin", String(f.errMin));
    if (f.convMin > 0) p.set("convMin", String(f.convMin));
    if (f.convMax < 100) p.set("convMax", String(f.convMax));
    if (f.bbMin > 0) p.set("bbMin", String(f.bbMin));
    if (f.bbMax < 100) p.set("bbMax", String(f.bbMax));
    if (f.retMin > 0) p.set("retMin", String(f.retMin));
    if (f.retMax < 100) p.set("retMax", String(f.retMax));
    if (f.revMin > 0) p.set("revMin", String(f.revMin));
    if (f.revMax < 2000) p.set("revMax", String(f.revMax));
    if (f.unitsMin > 0) p.set("unitsMin", String(f.unitsMin));
    if (f.unitsMax < 100) p.set("unitsMax", String(f.unitsMax));
    if (f.health) p.set("health", f.health);
    if (f.status !== "all") p.set("status", f.status);
    return p.toString();
  }, [f, storeIndex, pageSize, offset]);

  // Strip page-size/offset from the filter body sent to POST (server re-derives the pool).
  const filterBody = useMemo(() => {
    const { ...rest } = f;
    return rest;
  }, [f]);

  const poll = useCallback(async () => {
    const res = await fetch(`/api/amazon/growth/bulk-fix?${qs()}`);
    if (res.ok) {
      const j: ApiResp = await res.json();
      setData(j);
      // Stamp "last activity" whenever the finished count grows.
      const fin = j.stats.done + j.stats.skipped + j.stats.errored;
      if (fin > prevFinishedRef.current) setLastActivityAt(Date.now());
      prevFinishedRef.current = fin;
      return j.stats;
    }
    return null;
  }, [qs]);

  // Tick once a second while a run is active so elapsed/ETA/"last change" update.
  useEffect(() => {
    if (!startedAt || busy == null) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt, busy]);

  // Reset to first page whenever the filter changes.
  useEffect(() => { setOffset(0); }, [
    f.q, f.suppressed, f.hasErrors, f.notBuyable, f.noBuyBox, f.oppMin, f.healthMax,
    f.sessMin, f.errMin, f.convMin, f.convMax, f.bbMin, f.bbMax, f.retMin, f.retMax,
    f.revMin, f.revMax, f.unitsMin, f.unitsMax, f.health, f.status, pageSize,
  ]);

  // Debounced live pool/table as filters change.
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(async () => { await poll(); setLoading(false); }, 300);
    return () => clearTimeout(t);
  }, [poll]);

  const candidates = data?.candidates ?? [];
  const candSkus = candidates.map((c) => c.sku);
  const allRowsSelected = !!candSkus.length && candSkus.every((s) => selected.has(s));
  const toggle = (sku: string) => setSelected((s) => { const n = new Set(s); n.has(sku) ? n.delete(sku) : n.add(sku); return n; });
  const toggleAll = () => setSelected(allRowsSelected ? new Set() : new Set(candSkus));
  const scopeOn = scope.dedupe || scope.brandVoice || scope.suppression;
  const match = data?.match ?? null;

  async function run() {
    if (!scopeOn) { setMsg("Select at least one fix."); return; }
    const total = match ?? 0;
    if (allMatching ? total === 0 : selected.size === 0) return;
    if (allMatching && total > 200 && !confirm(`Queue ALL ${total.toLocaleString()} matching listings for fixing?`)) return;
    setBusy("enqueue");
    setMsg(null);
    // Start the run clock from the queue's current finished baseline.
    const baseFin = (data?.stats.done ?? 0) + (data?.stats.skipped ?? 0) + (data?.stats.errored ?? 0);
    setBaseFinished(baseFin);
    prevFinishedRef.current = baseFin;
    setStartedAt(Date.now());
    setLastActivityAt(Date.now());
    try {
      const payload = allMatching
        ? { storeIndex, filter: filterBody, scope, allMatching: true }
        : { storeIndex, scope, skus: [...selected] };
      const res = await fetch("/api/amazon/growth/bulk-fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await res.json();
      if (!j.ok) { setMsg(`Error: ${j.error}`); setBusy(null); return; }
      setMsg(`Queued ${j.queued} listings. Worker running…`);
      setSelected(new Set());
      autoRef.current = true;
      await drainLoop();
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
      setBusy(null);
    }
  }

  // Drain the queue batch-by-batch until empty or stopped.
  async function drainLoop() {
    setBusy("draining");
    try {
      for (let i = 0; i < 200 && autoRef.current; i++) {
        const res = await fetch("/api/amazon/growth/bulk-fix/drain", { method: "POST" });
        const j = await res.json();
        const s = await poll();
        if (!j.ok) { setMsg(`Worker error: ${j.error}`); break; }
        if (!s || s.requested + s.running === 0) break;
      }
    } finally {
      autoRef.current = false;
      setBusy(null);
    }
  }
  function stop() { autoRef.current = false; }

  const stats = data?.stats;
  const active = (stats?.requested ?? 0) + (stats?.running ?? 0);
  const finished = (stats?.done ?? 0) + (stats?.skipped ?? 0) + (stats?.errored ?? 0);
  const total = active + finished;
  const progressPct = total ? Math.round((finished / total) * 100) : 0;

  // Run timing (recomputed each tick).
  const nowMs = Date.now();
  const elapsedMs = startedAt ? nowMs - startedAt : 0;
  const processed = Math.max(0, finished - baseFinished);
  const ratePerMs = processed > 0 && elapsedMs > 0 ? processed / elapsedMs : 0;
  const etaMs = ratePerMs > 0 && active > 0 ? active / ratePerMs : null;
  const sinceActivityMs = lastActivityAt ? nowMs - lastActivityAt : 0;
  const stalled = active > 0 && sinceActivityMs > 90_000;

  return (
    <Panel>
      <PanelHeader
        title="Bulk fix — filter → pool → fix all"
        right={<Btn size="sm" icon={<RefreshCw size={13} />} onClick={() => poll()}>Refresh</Btn>}
      />
      <div className="grid gap-0 md:grid-cols-[300px_1fr]">
        {/* ── Filters ── */}
        <div className="space-y-4 border-rule p-4 md:border-r">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.id} onClick={() => setF((cur) => ({ ...cur, ...p.f }))} className="rounded-full border border-rule bg-surface px-2.5 py-1 text-[11px] text-ink-2 hover:bg-bg-elev hover:text-ink">{p.label}</button>
            ))}
          </div>

          <input
            value={f.q}
            onChange={(e) => setF({ ...f, q: e.target.value })}
            placeholder="Search product / SKU / ASIN…"
            className="h-7 w-full rounded-md border border-rule bg-surface px-2 text-[12px] text-ink placeholder:text-ink-4 focus:border-green-mid focus:outline-none"
          />

          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.suppressed} onChange={(e) => setF({ ...f, suppressed: e.target.checked })} /> Suppressed only</label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.hasErrors} onChange={(e) => setF({ ...f, hasErrors: e.target.checked })} /> Has errors</label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.notBuyable} onChange={(e) => setF({ ...f, notBuyable: e.target.checked })} /> Not buyable</label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.noBuyBox} onChange={(e) => setF({ ...f, noBuyBox: e.target.checked })} /> No Buy Box (&lt;90%)</label>

          <Slider label="Opportunity — at least" value={f.oppMin} onChange={(v) => setF({ ...f, oppMin: v })} />
          <Slider label="Health — at most" value={f.healthMax} onChange={(v) => setF({ ...f, healthMax: v })} />
          <Slider label="Traffic (sessions) — at least" max={500} value={f.sessMin} onChange={(v) => setF({ ...f, sessMin: v })} />
          <Slider label="Errors — at least" max={20} value={f.errMin} onChange={(v) => setF({ ...f, errMin: v })} />

          <div className="border-t border-rule pt-3 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">Sales &amp; performance (last 30d)</div>
          <RangeTwo label="Sales $" max={2000} lo={f.revMin} hi={f.revMax} onLo={(v) => setF({ ...f, revMin: v })} onHi={(v) => setF({ ...f, revMax: v })} />
          <RangeTwo label="Units sold" max={100} lo={f.unitsMin} hi={f.unitsMax} onLo={(v) => setF({ ...f, unitsMin: v })} onHi={(v) => setF({ ...f, unitsMax: v })} />
          <RangeTwo label="Conversion" max={100} lo={f.convMin} hi={f.convMax} onLo={(v) => setF({ ...f, convMin: v })} onHi={(v) => setF({ ...f, convMax: v })} suffix="%" />
          <RangeTwo label="Buy Box" max={100} lo={f.bbMin} hi={f.bbMax} onLo={(v) => setF({ ...f, bbMin: v })} onHi={(v) => setF({ ...f, bbMax: v })} suffix="%" />
          <RangeTwo label="Return rate" max={100} lo={f.retMin} hi={f.retMax} onLo={(v) => setF({ ...f, retMin: v })} onHi={(v) => setF({ ...f, retMax: v })} suffix="%" />

          <div className="border-t border-rule pt-3 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">Fixes to apply</div>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={scope.dedupe} onChange={(e) => setScope({ ...scope, dedupe: e.target.checked })} /> Dedupe duplicate attributes</label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={scope.brandVoice} onChange={(e) => setScope({ ...scope, brandVoice: e.target.checked })} /> Brand-voice scrub (title)</label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={scope.suppression} onChange={(e) => setScope({ ...scope, suppression: e.target.checked })} /> Suppression attrs (unit_count / weight)</label>
          <div className="rounded-lg bg-bg-elev px-3 py-2 text-[11px] text-ink-3 flex items-center gap-1.5"><Lock size={11} /> Only safe, derivable fixes are written; anything not confidently derivable is skipped with a reason. Price, UPC, brand &amp; product type are never changed.</div>
        </div>

        {/* ── Pool + table + run + progress ── */}
        <div className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-baseline gap-3">
              <span className="text-[26px] font-semibold tabular text-ink">{match == null ? "…" : match.toLocaleString()}</span>
              <span className="text-[12px] text-ink-3">listings match · {data?.counts.suppressed ?? 0} suppressed · {data?.counts.hasErrors ?? 0} with errors</span>
            </div>
            <select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} className="rounded-md border border-rule bg-surface px-2 py-1 text-[11px] text-ink-2">
              {SORTS.map((s) => <option key={s.id} value={s.id}>Sort: {s.label}</option>)}
            </select>
          </div>

          {/* Health + status chips */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {HEALTH_CHIPS.map((h) => (
              <button key={h.id} onClick={() => setF({ ...f, health: h.id })}
                className={cn("rounded-full border px-2.5 py-1 text-[11px]", f.health === h.id ? "border-green bg-green text-green-cream" : "border-rule bg-surface text-ink-2 hover:bg-bg-elev")}>{h.label}</button>
            ))}
            <span className="mx-1 h-4 w-px bg-rule" />
            {STATUS_OPTS.map((s) => (
              <button key={s.id} onClick={() => setF({ ...f, status: s.id })}
                className={cn("rounded-full border px-2.5 py-1 text-[11px]", f.status === s.id ? "border-silver-dark bg-silver-tint text-silver-dark" : "border-rule bg-surface text-ink-2 hover:bg-bg-elev")}>{s.label}</button>
            ))}
          </div>

          {/* Pool table */}
          <div className="max-h-[440px] overflow-auto rounded-lg border border-rule">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-rule text-left text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">
                  <th className="px-2 py-1.5"><input type="checkbox" checked={allRowsSelected} onChange={toggleAll} /></th>
                  <th className="px-2 py-1.5">Product</th>
                  <th className="px-2 py-1.5">Health</th>
                  {([["Opp", "opportunity"], ["Score", "worstHealth"], ["Sess", "traffic"], ["Units", "units"], ["Conv", "conversion"], ["BB%", "buybox"], ["Rev", "revenue"], ["Ret%", "returns"], ["Err", "mostErrors"]] as const).map(([label, key]) => (
                    <th key={key} className="px-2 py-1.5 cursor-pointer select-none hover:text-ink" onClick={() => setF({ ...f, sort: key })}>
                      {label}{f.sort === key && <span className="ml-0.5">▾</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && !candidates.length && <tr><td colSpan={12} className="px-2 py-5 text-center text-ink-3">Loading…</td></tr>}
                {!loading && !candidates.length && <tr><td colSpan={12} className="px-2 py-5 text-center text-ink-3">No listings match — loosen the filters.</td></tr>}
                {candidates.map((c) => {
                  const b = HEALTH_BADGE[c.health] || HEALTH_BADGE.new;
                  return (
                    <tr key={c.sku} className={cn("border-b border-rule/50 hover:bg-bg-elev/40", selected.has(c.sku) && "bg-green-soft/40")}>
                      <td className="px-2 py-1.5"><input type="checkbox" checked={selected.has(c.sku)} onChange={() => toggle(c.sku)} /></td>
                      <td className="px-2 py-1.5 max-w-[220px]">
                        <div className="flex items-center gap-1">
                          <span className="truncate text-ink">{c.itemName || c.sku}</span>
                          {c.asin && (
                            <a href={`https://www.amazon.com/dp/${c.asin}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Open on Amazon" className="shrink-0 text-ink-4 hover:text-green-ink">
                              <ExternalLink size={12} />
                            </a>
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-ink-3">{c.sku}{c.isSuppressed ? " · suppressed" : ""}</div>
                      </td>
                      <td className="px-2 py-1.5"><span className="rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap" style={{ background: b.bg, color: b.color }}>{b.label}</span></td>
                      <td className="px-2 py-1.5 tabular">{fmt(c.opportunityScore)}</td>
                      <td className="px-2 py-1.5 tabular">{fmt(c.healthScore)}</td>
                      <td className="px-2 py-1.5 tabular">{fmt(c.sessions30d)}</td>
                      <td className="px-2 py-1.5 tabular">{c.unitsOrdered30d || "—"}</td>
                      <td className="px-2 py-1.5 tabular">{pct(c.unitSessionPct)}</td>
                      <td className="px-2 py-1.5 tabular">{c.buyBoxPercentage != null ? c.buyBoxPercentage.toFixed(0) + "%" : "—"}</td>
                      <td className="px-2 py-1.5 tabular">{money(c.revenue30d)}</td>
                      <td className="px-2 py-1.5 tabular">{c.returnRate != null ? (c.returnRate * 100).toFixed(0) + "%" : "—"}</td>
                      <td className="px-2 py-1.5 tabular">{c.errorIssueCount || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-3">
            <span>{data?.page.total ? `${offset + 1}–${Math.min(offset + candidates.length, data.page.total)} of ${data.page.total.toLocaleString()}` : "0 of 0"}</span>
            <div className="flex items-center gap-2">
              <span>Per page</span>
              {[25, 50, 100].map((n) => (
                <button key={n} onClick={() => setPageSize(n)} className={cn("rounded px-1.5 py-0.5 font-mono", pageSize === n ? "bg-green text-green-cream" : "bg-bg-elev text-ink-2 hover:text-ink")}>{n}</button>
              ))}
              <Btn size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Prev</Btn>
              <Btn size="sm" disabled={!data || offset + pageSize >= data.page.total} onClick={() => setOffset(offset + pageSize)}>Next</Btn>
            </div>
          </div>

          {/* Run controls */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-ink-3">{selected.size} selected</span>
              <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <input type="checkbox" checked={allMatching} onChange={(e) => setAllMatching(e.target.checked)} />
                Apply to all {match ? match.toLocaleString() : ""} matching
              </label>
            </div>
            <div className="flex items-center gap-2">
              {busy === "draining" && <Btn variant="outline" icon={<Square size={13} />} onClick={stop}>Stop</Btn>}
              <Btn variant="primary" icon={<Wand2 size={13} />} loading={busy != null}
                disabled={!scopeOn || (allMatching ? !match : selected.size === 0)} onClick={run}>
                {allMatching ? `Fix all ${match ? match.toLocaleString() : 0} matching` : `Fix ${selected.size || ""} selected`}
              </Btn>
            </div>
          </div>
          {msg && <div className="mt-3 rounded-lg border border-rule bg-green-soft px-3 py-2 text-[12px] text-green-ink">{msg}</div>}

          {/* Progress */}
          {stats && total > 0 && (
            <div className="mt-3 rounded-lg border border-rule bg-bg-elev/40 p-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="font-mono uppercase tracking-[0.08em] text-ink-3">
                  Worker progress {active > 0 && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-ink align-middle" />}
                </span>
                <span className="text-ink-2">{finished} / {total} · {progressPct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-rule/40">
                <div className="h-full rounded-full bg-green-ink transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
                <span>Queued: <b className="text-ink-2">{stats.requested}</b></span>
                <span>Running: <b className="text-ink-2">{stats.running}</b></span>
                <span>Fixed: <b className="text-green-ink">{stats.done}</b></span>
                <span>Skipped: <b className="text-ink-2">{stats.skipped}</b></span>
                {stats.errored > 0 && <span>Errors: <b className="text-red-ink">{stats.errored}</b></span>}
                <span>Changes written: <b className="text-green-ink">{stats.changesTotal}</b></span>
              </div>
              {/* Timing: elapsed · ETA · last-activity (stall detector) */}
              {startedAt && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-rule/60 pt-2 text-[11px]">
                  <span className="text-ink-3">Elapsed <b className="text-ink-2 tabular">{fmtDur(elapsedMs)}</b></span>
                  {active > 0 ? (
                    <span className="text-ink-3">ETA <b className="text-ink-2 tabular">{etaMs != null ? `~${fmtDur(etaMs)}` : "—"}</b></span>
                  ) : (
                    <span className="text-green-ink">Done in {fmtDur(elapsedMs)}</span>
                  )}
                  {active > 0 && (
                    <span className={stalled ? "text-danger" : "text-ink-3"}>
                      Last change <b className={cn("tabular", stalled ? "text-danger" : "text-ink-2")}>{fmtDur(sinceActivityMs)} ago</b>
                      {stalled ? " — looks stalled" : ""}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* KPI summary */}
          {stats && (
            <div className="mt-3 grid grid-cols-3 gap-3">
              <KpiCard label="Listings fixed" value={stats.done} />
              <KpiCard label="Changes written" value={stats.changesTotal} icon={<Play size={14} />} />
              <KpiCard label="Skipped" value={stats.skipped} iconVariant="warn" />
            </div>
          )}

          {/* Recent results */}
          {data?.recent && data.recent.length > 0 && (
            <div className="mt-3 max-h-[260px] overflow-auto rounded-lg border border-rule">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-rule text-left text-[10px] font-mono uppercase tracking-wider text-ink-3">
                    <th className="px-2 py-1.5">Product</th>
                    <th className="px-2 py-1.5">Status</th>
                    <th className="px-2 py-1.5">What was done</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r, i) => (
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
