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

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ExternalLink, ArrowUpRight, ArrowDownRight, Sparkles, Image as ImageIcon, ListChecks, Play, Lock } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard, RiskPill } from "@/components/kit";
import { cn } from "@/lib/utils";

interface Metrics { lq: number | null; content: number | null; conv: number | null; views: number | null; gmv: number | null; }
interface HistoryRow { sku: string; url: string | null; runAt: string; ok: boolean; feedStatus: string | null; newTitle: string | null; bulletsCount: number | null; imagesCount: number | null; usedAiPolish: boolean; measured: boolean; before: Metrics; after: Metrics; deltas: Metrics; }
interface Candidate { sku: string; productName: string | null; packCount: number | null; lqScore: number | null; contentScore: number | null; issueCount: number | null; contentIssues: string[]; pageViews30d: number | null; conversionRate30d: number | null; }
interface ApiResp {
  counts: { match: number; pack4: number; withGaps: number };
  candidates: Candidate[];
  contentGapHeatmap: { title: string; count: number }[];
  summary: { applied: number; measured: number; pendingMeasure: number; avgLqDelta: number | null; avgContentDelta: number | null; avgConvDelta: number | null; };
  history: HistoryRow[];
  queue: { sku: string; status: string }[];
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
  const [f, setF] = useState({ packMin: 4, packMax: 24, lqMin: 0, lqMax: 100, contentMax: 100, hasIssues: true, excludeBundles: true });
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<Record<string, boolean>>({ image: true, gallery: true, title: true, bullets: true, description: true, attributes: false });
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("packMin", String(f.packMin)); p.set("packMax", String(f.packMax));
    p.set("lqMin", String(f.lqMin)); p.set("lqMax", String(f.lqMax)); p.set("contentMax", String(f.contentMax));
    p.set("hasIssues", f.hasIssues ? "1" : "0"); p.set("excludeBundles", f.excludeBundles ? "1" : "0");
    return p.toString();
  }, [f]);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch(`/api/walmart/growth/remediation?${qs}`); setData(await r.json()); }
    finally { setLoading(false); }
  }, [qs]);
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [load]); // debounce slider changes

  const candidates = data?.candidates ?? [];
  const candSkus = candidates.map((c) => c.sku);
  const toggle = (sku: string) => setSelected((s) => { const n = new Set(s); n.has(sku) ? n.delete(sku) : n.add(sku); return n; });
  const allSelected = !!candSkus.length && candSkus.every((s) => selected.has(s));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(candSkus));
  const scopeCount = Object.values(scope).filter(Boolean).length;

  async function run() {
    if (!selected.size || !scopeCount) return;
    setRunning(true); setMsg(null);
    try {
      const r = await fetch("/api/walmart/growth/remediation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skus: [...selected], scope }) });
      const j = await r.json();
      setMsg(`Queued ${j.queued} listing(s). The optimizer applies them and logs before/after — watch the Impact section.`);
      setSelected(new Set()); await load();
    } catch { setMsg("Failed to queue — try again."); } finally { setRunning(false); }
  }

  const s = data?.summary;

  return (
    <div className="space-y-5">
      {/* Builder */}
      <Panel>
        <PanelHeader title="Build an optimization run" right={<Btn size="sm" icon={<RefreshCw size={13} />} onClick={load}>Refresh</Btn>} />
        <div className="grid gap-0 md:grid-cols-[300px_1fr]">
          {/* Filters */}
          <div className="space-y-4 border-rule p-4 md:border-r">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.id} onClick={() => setF(p.f)} className="rounded-full border border-rule bg-surface px-2.5 py-1 text-[11px] text-ink-2 hover:bg-bg-elev hover:text-ink">{p.label}</button>
              ))}
            </div>
            <Slider label="Pack size — min" min={2} max={24} value={f.packMin} onChange={(v) => setF({ ...f, packMin: Math.min(v, f.packMax) })} suffix="+" />
            <Slider label="Listing quality — min" min={0} max={100} value={f.lqMin} onChange={(v) => setF({ ...f, lqMin: Math.min(v, f.lqMax) })} />
            <Slider label="Listing quality — max" min={0} max={100} value={f.lqMax} onChange={(v) => setF({ ...f, lqMax: Math.max(v, f.lqMin) })} />
            <Slider label="Content score — at most" min={0} max={100} value={f.contentMax} onChange={(v) => setF({ ...f, contentMax: v })} />
            <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.hasIssues} onChange={(e) => setF({ ...f, hasIssues: e.target.checked })} /> Has content gaps</label>
            <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" checked={f.excludeBundles} onChange={(e) => setF({ ...f, excludeBundles: e.target.checked })} /> Exclude mixed bundles</label>
            <div className="rounded-lg bg-bg-elev px-3 py-2 text-[11px] text-ink-3 flex items-center gap-1.5"><Lock size={11} /> Price, UPC, brand &amp; product type are never changed.</div>
          </div>

          {/* Targets + scope + run */}
          <div className="p-4">
            <div className="mb-3 flex items-baseline gap-3">
              <span className="text-[26px] font-semibold tabular text-ink">{loading ? "…" : data?.counts.match ?? 0}</span>
              <span className="text-[12px] text-ink-3">listings match · {data?.counts.pack4 ?? 0} pack≥4 · {data?.counts.withGaps ?? 0} with content gaps</span>
            </div>
            <div className="max-h-[230px] overflow-y-auto rounded-lg border border-rule">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-surface"><tr className="border-b border-rule text-left text-[10px] font-mono uppercase tracking-[0.08em] text-ink-3">
                  <th className="px-2 py-1.5"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                  <th className="px-2 py-1.5">Product</th><th className="px-2 py-1.5">Pack</th><th className="px-2 py-1.5">LQ</th><th className="px-2 py-1.5">Cont</th><th className="px-2 py-1.5">Views</th>
                </tr></thead>
                <tbody>
                  {loading && <tr><td colSpan={6} className="px-2 py-5 text-center text-ink-3">Loading…</td></tr>}
                  {!loading && !candidates.length && <tr><td colSpan={6} className="px-2 py-5 text-center text-ink-3">No listings match — loosen the filters.</td></tr>}
                  {candidates.map((c) => (
                    <tr key={c.sku} className={cn("border-b border-rule/50 hover:bg-bg-elev/40", selected.has(c.sku) && "bg-green-soft/40")}>
                      <td className="px-2 py-1.5"><input type="checkbox" checked={selected.has(c.sku)} onChange={() => toggle(c.sku)} /></td>
                      <td className="px-2 py-1.5 max-w-[260px]"><div className="truncate text-ink">{c.productName || c.sku}</div><div className="font-mono text-[10px] text-ink-3">{c.sku}</div></td>
                      <td className="px-2 py-1.5"><span className={cn("rounded px-1.5 py-0.5 font-mono text-[11px]", (c.packCount ?? 0) >= 4 ? "bg-green-soft text-green-ink" : "bg-bg-elev text-ink-2")}>×{c.packCount ?? "?"}</span></td>
                      <td className="px-2 py-1.5 tabular">{fmt(c.lqScore)}</td><td className="px-2 py-1.5 tabular">{fmt(c.contentScore)}</td><td className="px-2 py-1.5 tabular">{fmt(c.pageViews30d)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 rounded-lg border border-rule p-3">
              <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3">What to change</div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {SCOPE_FIELDS.map((sf) => (
                  <label key={sf.key} className="flex items-center gap-1.5 text-[12px] text-ink-2"><input type="checkbox" checked={!!scope[sf.key]} onChange={(e) => setScope({ ...scope, [sf.key]: e.target.checked })} /> {sf.label}</label>
                ))}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <span className="text-[12px] text-ink-3">{selected.size} selected · {scopeCount} field{scopeCount === 1 ? "" : "s"}</span>
              <Btn variant="primary" icon={<Play size={13} />} loading={running} disabled={!selected.size || !scopeCount} onClick={run}>Run optimization{selected.size ? ` · ${selected.size}` : ""}</Btn>
            </div>
            {msg && <div className="mt-2 rounded-lg border border-rule bg-green-soft px-3 py-2 text-[12px] text-green-ink">{msg}</div>}
            {!!data?.queue.length && <div className="mt-2 text-[11px] text-ink-3">In queue: {data.queue.length} ({data.queue.filter((q) => q.status === "running").length} running)</div>}
          </div>
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
