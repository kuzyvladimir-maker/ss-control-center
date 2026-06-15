"use client";

/**
 * Walmart Growth — Listing Optimizer (Builder).
 *
 * Filter the catalog with sliders (pack size, listing-quality, content score),
 * see a live match count, choose what to change, and queue the optimization.
 * Below: before/after impact of past runs + a content-gap heatmap for the catalog.
 *
 * Heavy work (image gen, Claude, feeds) runs in the worker that drains
 * WalmartRemediationQueue; this UI just builds the request and tracks results.
 */

import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import { RefreshCw, ExternalLink, ArrowUpRight, ArrowDownRight, Sparkles, Image as ImageIcon, ListChecks, Play, Lock, ChevronRight } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard, RiskPill } from "@/components/kit";
import { cn } from "@/lib/utils";

interface Metrics { lq: number | null; content: number | null; conv: number | null; views: number | null; gmv: number | null; }
interface HistoryRow { sku: string; url: string | null; runAt: string; ok: boolean; feedStatus: string | null; newTitle: string | null; bulletsCount: number | null; imagesCount: number | null; usedAiPolish: boolean; measured: boolean; before: Metrics; after: Metrics; deltas: Metrics; }
interface Rec { type: "auto" | "advisory"; title: string; detail: string; skus: string[]; fields: string[]; }
interface LqIssue { component: string; label: string; title: string; detail: string; impact: string; }
interface Candidate { sku: string; itemId: string | null; productName: string | null; packCount: number | null; lqScore: number | null; contentScore: number | null; issueCount: number | null; contentIssues: string[]; issues: LqIssue[]; pageViews30d: number | null; reviews: number; sales: number; units: number; orders: number; returns: number; conv: number | null; returnRate: number | null; health: string; status: string | null; inStock: boolean; }
interface ApiResp {
  period: number;
  counts: { match: number; pack4: number; withGaps: number };
  candidates: Candidate[];
  contentGapHeatmap: { title: string; count: number }[];
  summary: { applied: number; measured: number; pendingMeasure: number; avgLqDelta: number | null; avgContentDelta: number | null; avgConvDelta: number | null; };
  history: HistoryRow[];
  queue: { sku: string; status: string }[];
  queueStats: { queued: number; running: number; submitted: number; held: number; done: number; error: number; skipped: number };
  progress?: { elapsedMin: number; ratePerHour: number; remaining: number; etaHours: number | null; finished: number };
  sellerScore?: { listingQuality: number; components: { label: string; score: number | null }[] } | null;
  page: { limit: number; offset: number; total: number };
}

const SCOPE_FIELDS = [
  { key: "image", label: "Main image (N units)" },
  { key: "gallery", label: "Secondary gallery" },
  { key: "title", label: "Title" },
  { key: "bullets", label: "Bullets" },
  { key: "description", label: "Description" },
  { key: "attributes", label: "Attributes (nutrition, …)" },
] as const;

const PRESETS = [
  { id: "wave1", label: "Wave 1 · Published, pack ≥ 4", f: { packMin: 4, packMax: 24, lqMin: 0, lqMax: 100, contentMax: 100, hasIssues: true, excludeBundles: true } },
  { id: "lowcontent", label: "Weak content (≤ 90)", f: { packMin: 2, packMax: 24, lqMin: 0, lqMax: 100, contentMax: 90, hasIssues: true, excludeBundles: true } },
  { id: "all", label: "All multipacks", f: { packMin: 2, packMax: 24, lqMin: 0, lqMax: 100, contentMax: 100, hasIssues: false, excludeBundles: true } },
];

function fmt(n: number | null | undefined, d = 0) { return n == null ? "—" : Number(n).toFixed(d); }
function money(n: number | null | undefined) { return n == null ? "—" : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtDur(min: number | null | undefined) {
  if (min == null || !isFinite(min) || min < 0) return "—";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const HEALTH: Record<string, { label: string; bg: string; color: string }> = {
  winner: { label: "Winner", bg: "var(--green-soft)", color: "var(--green-ink)" },
  leaky: { label: "Leaky", bg: "var(--warn-tint)", color: "var(--warn-strong)" },
  "high-return": { label: "High-return", bg: "var(--danger-tint)", color: "var(--danger)" },
  dead: { label: "Dead", bg: "var(--silver-tint)", color: "var(--silver-dark)" },
  new: { label: "New", bg: "var(--bg-elev)", color: "var(--ink-3)" },
};
const SORTS = [
  { id: "views", label: "Traffic" }, { id: "sales", label: "Sales $" }, { id: "units", label: "Units" },
  { id: "conv", label: "Conversion" }, { id: "reviews", label: "Reviews" }, { id: "returnRate", label: "Return rate" }, { id: "lq", label: "Worst LQ" },
];

function Slider({ label, min, max, value, onChange, suffix }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3">{label}</span>
        <span className="text-[12px] font-semibold tabular text-ink">{value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[var(--green)]" />
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

const HEALTH_CHIPS = [{ id: "", label: "All health" }, { id: "winner", label: "Winner" }, { id: "leaky", label: "Leaky" }, { id: "high-return", label: "High-return" }, { id: "dead", label: "Dead" }, { id: "new", label: "New" }];
const STATUS_OPTS = [{ id: "all", label: "All status" }, { id: "published", label: "Published" }, { id: "unpublished", label: "Unpublished" }, { id: "error", label: "Error" }];

function DeltaCell({ before, after, d, digits = 0, suffix = "" }: { before: number | null; after: number | null; d: number | null; digits?: number; suffix?: string }) {
  if (after == null) return <span className="text-ink-3 text-[11px]">{fmt(before, digits)}{suffix} · pending</span>;
  const up = (d ?? 0) > 0, down = (d ?? 0) < 0;
  const color = up ? "var(--green-ink)" : down ? "var(--danger)" : "var(--ink-3)";
  return (
    <span className="tabular">{fmt(before, digits)}{suffix} → <span style={{ color, fontWeight: 600 }}>{fmt(after, digits)}{suffix}</span>
      {d != null && d !== 0 && <span className="ml-1 inline-flex items-center text-[10px]" style={{ color }}>{up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}{Math.abs(d).toFixed(digits)}</span>}
    </span>
  );
}

export function ListingOptimizer() {
  // Default = whole catalog (no filters); narrow with the controls. Presets re-apply scopes.
  const [f, setF] = useState({
    packMin: 1, packMax: 24, lqMin: 0, lqMax: 100, contentMax: 100, hasIssues: false, excludeBundles: false, oos: false,
    period: 30, sort: "views", status: "all", health: "",
    minSales: 0, maxSales: 1000, minUnits: 0, maxUnits: 50, minReviews: 0, maxReviews: 50, minReturnPct: 0, maxReturnPct: 100,
  });
  const [pageSize, setPageSize] = useState(50);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedRow, setExpandedRow] = useState<Set<string>>(new Set());
  const [rowAi, setRowAi] = useState<Record<string, { loading?: boolean; narrative?: string; recs?: Rec[] }>>({});
  const [scope, setScope] = useState<Record<string, boolean>>({ image: true, gallery: true, title: true, bullets: true, description: true, attributes: false });
  const [running, setRunning] = useState(false);
  const [allMatching, setAllMatching] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // AI analyst
  const [analysis, setAnalysis] = useState<{ narrative: string; recommendations: Rec[] } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [recSel, setRecSel] = useState<Set<number>>(new Set());
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("packMin", String(f.packMin)); p.set("packMax", String(f.packMax));
    p.set("lqMin", String(f.lqMin)); p.set("lqMax", String(f.lqMax)); p.set("contentMax", String(f.contentMax));
    p.set("hasIssues", f.hasIssues ? "1" : "0"); p.set("excludeBundles", f.excludeBundles ? "1" : "0");
    if (f.oos) p.set("oos", "1");
    p.set("period", String(f.period)); p.set("sort", f.sort);
    if (f.status !== "all") p.set("status", f.status);
    if (f.health) p.set("health", f.health);
    if (f.minSales) p.set("minSales", String(f.minSales));
    if (f.maxSales < 1000) p.set("maxSales", String(f.maxSales));
    if (f.minUnits) p.set("minUnits", String(f.minUnits));
    if (f.maxUnits < 50) p.set("maxUnits", String(f.maxUnits));
    if (f.minReviews) p.set("minReviews", String(f.minReviews));
    if (f.maxReviews < 50) p.set("maxReviews", String(f.maxReviews));
    if (f.minReturnPct) p.set("minReturnPct", String(f.minReturnPct));
    if (f.maxReturnPct < 100) p.set("maxReturnPct", String(f.maxReturnPct));
    p.set("limit", String(pageSize)); p.set("offset", String(offset));
    return p.toString();
  }, [f, pageSize, offset]);

  // Reset to first page whenever filters or page size change.
  useEffect(() => { setOffset(0); }, [f, pageSize]);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch(`/api/walmart/growth/remediation?${qs}`); setData(await r.json()); }
    finally { setLoading(false); }
  }, [qs]);
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [load]); // debounce slider changes

  // While the worker has active items, poll ONLY the lightweight counters (not the
  // heavy candidate/heatmap/history rows) — that read amplification is what
  // exhausted the DB read quota.
  const pollLight = useCallback(async () => {
    try {
      const r = await fetch(`/api/walmart/growth/remediation?light=1`);
      const j = await r.json();
      if (j?.queueStats) setData((d) => (d ? { ...d, queueStats: j.queueStats, progress: j.progress } : d));
    } catch { /* ignore transient */ }
  }, []);
  const activeWork = (data?.queueStats?.queued ?? 0) + (data?.queueStats?.running ?? 0) + (data?.queueStats?.submitted ?? 0) + (data?.queueStats?.held ?? 0);
  useEffect(() => {
    if (activeWork <= 0) return;
    const t = setInterval(pollLight, 30000);
    return () => clearInterval(t);
  }, [activeWork, pollLight]);

  const candidates = data?.candidates ?? [];
  const candSkus = candidates.map((c) => c.sku);
  const toggle = (sku: string) => setSelected((s) => { const n = new Set(s); n.has(sku) ? n.delete(sku) : n.add(sku); return n; });
  const allSelected = !!candSkus.length && candSkus.every((s) => selected.has(s));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(candSkus));
  const scopeCount = Object.values(scope).filter(Boolean).length;

  const toggleRow = (sku: string) => setExpandedRow((s) => { const n = new Set(s); n.has(sku) ? n.delete(sku) : n.add(sku); return n; });

  // Per-row actions: enqueue one listing, or run the AI analyst on just it.
  async function fixOne(sku: string) {
    try {
      await fetch("/api/walmart/growth/remediation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skus: [sku], scope }) });
      setMsg(`Queued ${sku} — watch Worker progress below.`); await load();
    } catch { setMsg("Failed to queue — try again."); }
  }
  async function askAiOne(sku: string) {
    setRowAi((s) => ({ ...s, [sku]: { loading: true } }));
    try {
      const r = await fetch(`/api/walmart/growth/remediation/analyze?${qs}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skus: [sku] }) });
      const j = await r.json();
      setRowAi((s) => ({ ...s, [sku]: { narrative: j.narrative, recs: j.recommendations || [] } }));
    } catch { setRowAi((s) => ({ ...s, [sku]: { narrative: "Analysis failed — try again." } })); }
  }

  async function run() {
    const total = data?.counts.match ?? 0;
    if (!scopeCount) return;
    if (allMatching ? total === 0 : !selected.size) return;
    if (allMatching && total > 200 && !confirm(`Queue ALL ${total.toLocaleString()} matching listings for optimization?`)) return;
    setRunning(true); setMsg(null);
    try {
      // allMatching → enqueue the whole filtered pool server-side (thousands);
      // otherwise just the checked rows.
      const url = allMatching ? `/api/walmart/growth/remediation?${qs}` : "/api/walmart/growth/remediation";
      const payload = allMatching ? { allMatching: true, scope } : { skus: [...selected], scope };
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json();
      setMsg(`Queued ${j.queued} listing(s). The worker drains the queue automatically (≈every 2 min) — watch "In queue" below and the Impact section.`);
      setSelected(new Set()); await load();
    } catch { setMsg("Failed to queue — try again."); } finally { setRunning(false); }
  }

  async function analyze() {
    setAnalyzing(true); setAnalysis(null); setRecSel(new Set()); setApplyMsg(null);
    try {
      // If rows are checked, analyze exactly those; otherwise the whole filtered pool.
      const body = JSON.stringify(selected.size ? { skus: [...selected] } : {});
      const r = await fetch(`/api/walmart/growth/remediation/analyze?${qs}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      setAnalysis(await r.json());
    } catch { setApplyMsg("Analysis failed — try again."); } finally { setAnalyzing(false); }
  }

  // Apply selected AUTO recommendations: enqueue their SKUs with the recommended field scope.
  async function applyRecs() {
    if (!analysis) return;
    const chosen = [...recSel].map((i) => analysis.recommendations[i]).filter((r) => r && r.type === "auto" && r.skus.length);
    if (!chosen.length) return;
    setApplyMsg(null);
    let queued = 0;
    for (const rec of chosen) {
      const sc: Record<string, boolean> = { image: false, gallery: false, title: false, bullets: false, description: false, attributes: false };
      for (const f of rec.fields) if (f in sc) sc[f] = true;
      try {
        const r = await fetch("/api/walmart/growth/remediation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skus: rec.skus, scope: sc }) });
        queued += (await r.json()).queued || 0;
      } catch { /* skip */ }
    }
    setApplyMsg(`Queued ${queued} listing(s) from ${chosen.length} recommendation(s).`);
    setRecSel(new Set()); await load();
  }

  const s = data?.summary;

  const scoreTone = (s: number | null | undefined) => s == null ? "var(--ink-3)" : s >= 70 ? "var(--green-ink)" : s >= 40 ? "var(--warn-strong)" : "var(--danger)";

  return (
    <div className="space-y-5">
      {/* Listing-quality health strip — Walmart's own seller score + 6 components.
          (Folds in the old Listing Quality tab so this is the single hub.) */}
      {data?.sellerScore && (
        <Panel>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <div className="flex shrink-0 items-center gap-3 sm:pr-4 sm:border-r sm:border-rule">
              <div>
                <div className="text-[11px] font-mono uppercase tracking-[0.1em] text-ink-3">Listing quality</div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[28px] font-semibold tabular leading-none" style={{ color: scoreTone(data.sellerScore.listingQuality) }}>{data.sellerScore.listingQuality}</span>
                  <span className="text-[13px] text-ink-3">/100</span>
                </div>
                <div className="text-[10px] text-ink-3">Walmart seller score</div>
              </div>
            </div>
            <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {data.sellerScore.components.map((c) => (
                <div key={c.label} className="rounded-lg border border-rule bg-surface px-2.5 py-1.5">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="truncate text-[10px] font-mono uppercase tracking-[0.06em] text-ink-3">{c.label}</span>
                    <span className="text-[13px] font-semibold tabular" style={{ color: scoreTone(c.score) }}>{c.score == null ? "—" : c.score}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-elev">
                    <div className="h-full rounded-full" style={{ width: `${c.score ?? 0}%`, background: scoreTone(c.score) }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {/* Builder */}
      <Panel>
        <PanelHeader title="Build an optimization run" right={<Btn size="sm" icon={<RefreshCw size={13} />} onClick={load}>Refresh</Btn>} />
        <div className="grid gap-0 md:grid-cols-[300px_1fr]">
          {/* Filters */}
          <div className="space-y-4 border-rule p-4 md:border-r">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.id} onClick={() => setF((cur) => ({ ...cur, ...p.f }))} className="rounded-full border border-rule bg-surface px-2.5 py-1 text-[11px] text-ink-2 hover:bg-bg-elev hover:text-ink">{p.label}</button>
              ))}
            </div>
            <Slider label="Pack size — min" min={2} max={24} value={f.packMin} onChange={(v) => setF({ ...f, packMin: Math.min(v, f.packMax) })} suffix="+" />
            <Slider label="Listing quality — min" min={0} max={100} value={f.lqMin} onChange={(v) => setF({ ...f, lqMin: Math.min(v, f.lqMax) })} />
            <Slider label="Listing quality — max" min={0} max={100} value={f.lqMax} onChange={(v) => setF({ ...f, lqMax: Math.max(v, f.lqMin) })} />
            <Slider label="Content score — at most" min={0} max={100} value={f.contentMax} onChange={(v) => setF({ ...f, contentMax: v })} />
            <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.hasIssues} onChange={(e) => setF({ ...f, hasIssues: e.target.checked })} /> Has content gaps</label>
            <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.excludeBundles} onChange={(e) => setF({ ...f, excludeBundles: e.target.checked })} /> Exclude mixed bundles</label>
            <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.oos} onChange={(e) => setF({ ...f, oos: e.target.checked })} /> Out of stock only</label>

            <div className="border-t border-rule pt-3 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">Performance ({f.period}d) — range</div>
            <RangeTwo label="Sales $" max={1000} lo={f.minSales} hi={f.maxSales} onLo={(v) => setF({ ...f, minSales: v })} onHi={(v) => setF({ ...f, maxSales: v })} />
            <RangeTwo label="Units" max={50} lo={f.minUnits} hi={f.maxUnits} onLo={(v) => setF({ ...f, minUnits: v })} onHi={(v) => setF({ ...f, maxUnits: v })} />
            <RangeTwo label="Reviews" max={50} lo={f.minReviews} hi={f.maxReviews} onLo={(v) => setF({ ...f, minReviews: v })} onHi={(v) => setF({ ...f, maxReviews: v })} />
            <RangeTwo label="Return rate" max={100} lo={f.minReturnPct} hi={f.maxReturnPct} onLo={(v) => setF({ ...f, minReturnPct: v })} onHi={(v) => setF({ ...f, maxReturnPct: v })} suffix="%" />

            <div className="rounded-lg bg-bg-elev px-3 py-2 text-[11px] text-ink-3 flex items-center gap-1.5"><Lock size={11} /> Price, UPC, brand &amp; product type are never changed.</div>
          </div>

          {/* Targets + scope + run */}
          <div className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-baseline gap-3">
                <span className="text-[26px] font-semibold tabular text-ink">{loading ? "…" : data?.counts.match ?? 0}</span>
                <span className="text-[12px] text-ink-3">match · {data?.counts.pack4 ?? 0} pack≥4 · {data?.counts.withGaps ?? 0} with gaps</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex rounded-md border border-rule overflow-hidden">
                  {[30, 90, 180].map((d) => (
                    <button key={d} onClick={() => setF({ ...f, period: d })} className={cn("px-2 py-1 text-[11px] font-mono", f.period === d ? "bg-green text-green-cream" : "bg-surface text-ink-2 hover:bg-bg-elev")}>{d}d</button>
                  ))}
                </div>
                <select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} className="rounded-md border border-rule bg-surface px-2 py-1 text-[11px] text-ink-2">
                  {SORTS.map((s) => <option key={s.id} value={s.id}>Sort: {s.label}</option>)}
                </select>
              </div>
            </div>
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
            <div className="max-h-[440px] overflow-auto rounded-lg border border-rule">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-surface"><tr className="border-b border-rule text-left text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">
                  <th className="px-2 py-1.5"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                  <th className="px-2 py-1.5">Product</th>
                  <th className="px-2 py-1.5">Health</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Stock</th>
                  <th className="px-2 py-1.5">Pack</th>
                  {([["LQ", "lq"], ["Sales", "sales"], ["Units", "units"], ["Views", "views"], ["Conv", "conv"], ["Rev", "reviews"], ["Ret%", "returnRate"]] as const).map(([label, key]) => (
                    <th key={key} className="px-2 py-1.5 cursor-pointer select-none hover:text-ink" onClick={() => setF({ ...f, sort: key })}>
                      {label}{f.sort === key && <span className="ml-0.5">▾</span>}
                    </th>
                  ))}
                </tr></thead>
                <tbody>
                  {loading && <tr><td colSpan={13} className="px-2 py-5 text-center text-ink-3">Loading…</td></tr>}
                  {!loading && !candidates.length && <tr><td colSpan={13} className="px-2 py-5 text-center text-ink-3">No listings match — loosen the filters.</td></tr>}
                  {candidates.map((c) => {
                    const h = HEALTH[c.health] || HEALTH.new;
                    const open = expandedRow.has(c.sku);
                    const ai = rowAi[c.sku];
                    return (
                      <Fragment key={c.sku}>
                      <tr className={cn("border-b border-rule/50 hover:bg-bg-elev/40", selected.has(c.sku) && "bg-green-soft/40", open && "bg-bg-elev/30")}>
                        <td className="px-2 py-1.5"><input type="checkbox" checked={selected.has(c.sku)} onChange={() => toggle(c.sku)} /></td>
                        <td className="px-2 py-1.5 max-w-[220px] cursor-pointer" onClick={() => toggleRow(c.sku)}>
                          <div className="flex items-center gap-1">
                            <ChevronRight size={12} className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
                            <div className="min-w-0">
                              <div className="truncate text-ink">{c.productName || c.sku}</div>
                              <div className="font-mono text-[10px] text-ink-3">{c.sku}{c.issueCount ? ` · ${c.issueCount} issues` : ""}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-1.5"><span className="rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap" style={{ background: h.bg, color: h.color }}>{h.label}</span></td>
                        <td className="px-2 py-1.5 text-[10px] text-ink-3 whitespace-nowrap">{c.status === "PUBLISHED" ? "Pub" : c.status === "UNPUBLISHED" ? "Unpub" : c.status === "SYSTEM_PROBLEM" ? "Error" : "—"}</td>
                        <td className="px-2 py-1.5"><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap", c.inStock ? "bg-green-soft text-green-ink" : "bg-red-soft text-red-ink")}>{c.inStock ? "In stock" : "Out"}</span></td>
                        <td className="px-2 py-1.5"><span className={cn("rounded px-1.5 py-0.5 font-mono text-[11px]", (c.packCount ?? 0) >= 4 ? "bg-green-soft text-green-ink" : "bg-bg-elev text-ink-2")}>×{c.packCount ?? "?"}</span></td>
                        <td className="px-2 py-1.5 tabular">{fmt(c.lqScore)}</td>
                        <td className="px-2 py-1.5 tabular">{money(c.sales)}</td>
                        <td className="px-2 py-1.5 tabular">{c.units || "—"}</td>
                        <td className="px-2 py-1.5 tabular">{fmt(c.pageViews30d)}</td>
                        <td className="px-2 py-1.5 tabular">{c.conv != null ? (c.conv * 100).toFixed(1) + "%" : "—"}</td>
                        <td className="px-2 py-1.5 tabular">{c.reviews || "—"}</td>
                        <td className="px-2 py-1.5 tabular">{c.returnRate != null ? (c.returnRate * 100).toFixed(0) + "%" : "—"}</td>
                      </tr>
                      {open && (
                        <tr className="border-b border-rule/50 bg-bg-elev/20">
                          <td colSpan={13} className="px-4 py-3">
                            <div className="mb-1.5 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">Walmart's flagged issues</div>
                            {c.issues?.length ? (
                              <ul className="space-y-1">
                                {c.issues.map((iss, i) => (
                                  <li key={i} className="flex items-start gap-2 text-[12px] text-ink-2">
                                    <span className={cn("mt-0.5 rounded px-1 py-0.5 text-[9px] font-medium uppercase whitespace-nowrap", iss.impact === "HIGH" ? "bg-red-soft text-red-ink" : iss.impact === "MEDIUM" ? "bg-warn-tint text-warn-strong" : "bg-bg-elev text-ink-3")}>{iss.impact || "—"}</span>
                                    <span><b className="text-ink">{iss.label}:</b> {iss.title}{iss.detail && iss.detail !== iss.title ? <span className="text-ink-3"> — {iss.detail}</span> : null}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : <div className="text-[12px] text-ink-3">No issues flagged by Walmart for this listing.</div>}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <Btn size="sm" variant="primary" icon={<Play size={12} />} onClick={() => fixOne(c.sku)}>Fix this listing</Btn>
                              <Btn size="sm" icon={<Sparkles size={12} />} loading={ai?.loading} onClick={() => askAiOne(c.sku)}>Ask AI</Btn>
                              {c.itemId && <a href={`https://www.walmart.com/ip/${c.itemId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"><ExternalLink size={12} /> View on Walmart</a>}
                            </div>
                            {ai && !ai.loading && (
                              <div className="mt-2 rounded-lg border border-rule bg-surface p-2.5 text-[12px]">
                                {ai.narrative && <div className="text-ink-2">{ai.narrative}</div>}
                                {ai.recs?.length ? (
                                  <ul className="mt-1.5 space-y-1">
                                    {ai.recs.map((r, i) => (
                                      <li key={i} className="text-ink-2">
                                        <span className={cn("mr-1 rounded px-1 py-0.5 text-[9px] font-medium uppercase", r.type === "auto" ? "bg-green-soft text-green-ink" : "bg-warn-tint text-warn-strong")}>{r.type === "auto" ? "auto-fix" : "needs you"}</span>
                                        <b className="text-ink">{r.title}</b>{r.detail ? ` — ${r.detail}` : ""}
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-3">
              <span>
                {data?.page.total ? `${offset + 1}–${Math.min(offset + (data?.candidates.length || 0), data.page.total)} of ${data.page.total.toLocaleString()}` : "0 of 0"}
              </span>
              <div className="flex items-center gap-2">
                <span>Per page</span>
                {[25, 50, 100].map((n) => (
                  <button key={n} onClick={() => setPageSize(n)} className={cn("rounded px-1.5 py-0.5 font-mono", pageSize === n ? "bg-green text-green-cream" : "bg-bg-elev text-ink-2 hover:text-ink")}>{n}</button>
                ))}
                <Btn size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Prev</Btn>
                <Btn size="sm" disabled={!data || offset + pageSize >= data.page.total} onClick={() => setOffset(offset + pageSize)}>Next</Btn>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-rule p-3">
              <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3">What to change</div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {SCOPE_FIELDS.map((sf) => (
                  <label key={sf.key} className="flex items-center gap-1.5 text-[12px] text-ink-2"><input type="checkbox" checked={!!scope[sf.key]} onChange={(e) => setScope({ ...scope, [sf.key]: e.target.checked })} /> {sf.label}</label>
                ))}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className="text-[12px] text-ink-3">{selected.size} selected · {scopeCount} field{scopeCount === 1 ? "" : "s"}</span>
                <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
                  <input type="checkbox" checked={allMatching} onChange={(e) => setAllMatching(e.target.checked)} />
                  Apply to all {data?.counts.match ? data.counts.match.toLocaleString() : ""} matching
                </label>
              </div>
              <Btn variant="primary" icon={<Play size={13} />} loading={running}
                disabled={scopeCount === 0 || (allMatching ? !(data?.counts.match) : !selected.size)} onClick={run}>
                {allMatching ? `Run on all ${data?.counts.match ? data.counts.match.toLocaleString() : 0}` : `Run optimization${selected.size ? ` · ${selected.size}` : ""}`}
              </Btn>
            </div>
            {msg && <div className="mt-2 rounded-lg border border-rule bg-green-soft px-3 py-2 text-[12px] text-green-ink">{msg}</div>}
            {data?.queueStats && (() => {
              const s = data.queueStats;
              const active = s.queued + s.running + s.submitted;
              const finished = s.done + s.error + s.skipped;
              const total = active + finished;
              if (total === 0) return null;
              const pct = total ? Math.round((finished / total) * 100) : 0;
              return (
                <div className="mt-3 rounded-lg border border-rule bg-bg-elev/40 p-3">
                  <div className="mb-1.5 flex items-center justify-between text-[11px]">
                    <span className="font-mono uppercase tracking-[0.08em] text-ink-3">Worker progress {active > 0 && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-ink align-middle" />}</span>
                    <span className="text-ink-2">{finished} / {total} done · {pct}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-rule/40">
                    <div className="h-full rounded-full bg-green-ink transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
                    <span>Waiting: <b className="text-ink-2">{s.queued}</b></span>
                    <span>Building: <b className="text-ink-2">{s.running}</b></span>
                    <span>Awaiting Walmart: <b className="text-ink-2">{s.submitted}</b></span>
                    <span>Done: <b className="text-green-ink">{s.done}</b></span>
                    {s.error > 0 && <span>Errors: <b className="text-red-ink">{s.error}</b></span>}
                    {s.skipped > 0 && <span>Skipped: <b className="text-ink-2">{s.skipped}</b></span>}
                    {s.held > 0 && <span>Held (next batches): <b className="text-ink-2">{s.held}</b></span>}
                  </div>
                  {data?.progress && (active > 0 || s.held > 0) && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule/40 pt-2 text-[11px] text-ink-2">
                      <span>Elapsed: <b>{fmtDur(data.progress.elapsedMin)}</b></span>
                      <span>Rate: <b>{data.progress.ratePerHour ? Math.round(data.progress.ratePerHour) : "—"}</b>/hr</span>
                      <span>Remaining: <b>{data.progress.remaining.toLocaleString()}</b></span>
                      <span>ETA: <b className="text-ink">{data.progress.etaHours != null ? fmtDur(data.progress.etaHours * 60) : "calculating…"}</b></span>
                    </div>
                  )}
                  {active > 0 && <div className="mt-1.5 text-[10px] text-ink-3">Auto-refreshing — the worker drains the queue automatically.</div>}
                </div>
              );
            })()}
          </div>
        </div>
      </Panel>

      {/* AI analyst */}
      <Panel>
        <PanelHeader title="AI analyst — diagnose this pool"
          right={<Btn size="sm" variant="primary" icon={<Sparkles size={13} />} loading={analyzing} onClick={analyze}>Analyze {selected.size ? `${selected.size} selected` : (data?.counts.match ? `${Math.min(data.counts.match, 60)} listings` : "pool")}</Btn>} />
        <div className="p-4">
          {!analysis && !analyzing && (
            <p className="text-[12px] text-ink-3">Reads the filtered pool — sales, units, conversion, stock, reviews, listing quality and Walmart&apos;s own flagged issues — and recommends how to lift conversion &amp; sales. Auto-fixable items can be queued in one click; the rest are flagged as manual.</p>
          )}
          {analyzing && <p className="text-[12px] text-ink-3">Analyzing up to 60 listings… reading metrics, issues &amp; Walmart policy (a few seconds).</p>}
          {analysis && (
            <div className="space-y-3">
              <p className="text-[13px] text-ink-2 whitespace-pre-wrap">{analysis.narrative}</p>
              {analysis.recommendations.map((rec, i) => {
                const auto = rec.type === "auto" && rec.skus.length > 0;
                return (
                  <div key={i} className={cn("rounded-lg border p-3", auto ? "border-rule" : "border-rule bg-bg-elev/30")}>
                    <div className="flex items-start gap-2">
                      {auto ? (
                        <input type="checkbox" className="mt-1" checked={recSel.has(i)} onChange={() => setRecSel((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; })} />
                      ) : <span className="mt-0.5 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase" style={{ background: "var(--warn-tint)", color: "var(--warn-strong)" }}>Manual</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-semibold text-ink">{rec.title}</span>
                          {rec.skus.length > 0 && <span className="text-[11px] text-ink-3">{rec.skus.length} listing{rec.skus.length === 1 ? "" : "s"}</span>}
                          {auto && rec.fields.length > 0 && <span className="font-mono text-[10px] text-green-ink">{rec.fields.join(" · ")}</span>}
                        </div>
                        <p className="mt-1 text-[12px] text-ink-2">{rec.detail}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
              {analysis.recommendations.some((r) => r.type === "auto" && r.skus.length) && (
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-ink-3">{recSel.size} recommendation(s) selected</span>
                  <Btn variant="primary" icon={<Play size={13} />} disabled={!recSel.size} onClick={applyRecs}>Apply selected</Btn>
                </div>
              )}
              {applyMsg && <div className="rounded-lg border border-rule bg-green-soft px-3 py-2 text-[12px] text-green-ink">{applyMsg}</div>}
            </div>
          )}
        </div>
      </Panel>

      {/* Impact KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Listings improved" value={s ? s.applied : "—"} icon={<ListChecks size={15} />} />
        <KpiCard label="Avg listing-quality lift" value={s?.avgLqDelta != null ? `${s.avgLqDelta > 0 ? "+" : ""}${s.avgLqDelta.toFixed(1)}` : "—"} icon={<ArrowUpRight size={15} />} iconVariant={s?.avgLqDelta != null && s.avgLqDelta > 0 ? "default" : "warn"} trend={s?.measured ? { value: `${s.measured} measured`, positive: true } : undefined} />
        <KpiCard label="Avg conversion lift" value={s?.avgConvDelta != null ? `${(s.avgConvDelta * 100).toFixed(2)}pp` : "—"} icon={<Sparkles size={15} />} iconVariant={s?.avgConvDelta != null && s.avgConvDelta > 0 ? "default" : "warn"} />
        <KpiCard label="Awaiting measurement" value={s ? s.pendingMeasure : "—"} icon={<RefreshCw size={15} />} iconVariant="warn" trend={{ value: "after next sweep", positive: false }} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Impact history */}
        <Panel>
          <PanelHeader title="Impact — before / after" count={data?.history.length} />
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="border-b border-rule text-left text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3">
                <th className="px-3 py-2">Product</th><th className="px-3 py-2">Changed</th><th className="px-3 py-2">Listing quality</th><th className="px-3 py-2">Conversion</th><th className="px-3 py-2">Status</th><th className="px-3 py-2"></th>
              </tr></thead>
              <tbody>
                {!loading && !data?.history.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-ink-3">No runs yet — build one above.</td></tr>}
                {data?.history.map((h, i) => (
                  <tr key={h.sku + i} className="border-b border-rule/60 hover:bg-bg-elev/40">
                    <td className="px-3 py-2 max-w-[280px]"><div className="truncate text-ink">{h.newTitle || h.sku}</div><div className="font-mono text-[10px] text-ink-3">{h.sku} · {new Date(h.runAt).toLocaleDateString()}</div></td>
                    <td className="px-3 py-2"><div className="flex items-center gap-2 text-[11px] text-ink-2"><span className="inline-flex items-center gap-0.5"><ImageIcon size={11} />{h.imagesCount ?? "—"}</span><span className="inline-flex items-center gap-0.5"><ListChecks size={11} />{h.bulletsCount ?? "—"}</span>{h.usedAiPolish && <Sparkles size={11} style={{ color: "var(--green-ink)" }} />}</div></td>
                    <td className="px-3 py-2"><DeltaCell before={h.before.lq} after={h.after.lq} d={h.deltas.lq} digits={1} /></td>
                    <td className="px-3 py-2"><DeltaCell before={h.before.conv != null ? h.before.conv * 100 : null} after={h.after.conv != null ? h.after.conv * 100 : null} d={h.deltas.conv != null ? h.deltas.conv * 100 : null} digits={2} suffix="%" /></td>
                    <td className="px-3 py-2">{h.ok ? <RiskPill level="low">live</RiskPill> : <RiskPill level="high">{h.feedStatus || "pending"}</RiskPill>}</td>
                    <td className="px-3 py-2">{h.url && <a href={h.url} target="_blank" rel="noreferrer" className="inline-flex items-center text-ink-3 hover:text-ink"><ExternalLink size={13} /></a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Content-gap heatmap */}
        <Panel>
          <PanelHeader title="Most common content gaps" />
          <div className="p-3 space-y-1.5">
            {!data?.contentGapHeatmap.length && <div className="text-[12px] text-ink-3">No content gaps found.</div>}
            {data?.contentGapHeatmap.map((g) => {
              const max = data.contentGapHeatmap[0].count || 1;
              return (
                <div key={g.title}>
                  <div className="flex items-baseline justify-between text-[11px]"><span className="truncate text-ink-2" title={g.title}>{g.title}</span><span className="tabular text-ink-3">{g.count}</span></div>
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-bg-elev"><div className="h-full rounded-full" style={{ width: `${(g.count / max) * 100}%`, background: "var(--warn)" }} /></div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
    </div>
  );
}
