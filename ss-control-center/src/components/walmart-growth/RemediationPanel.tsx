"use client";

/**
 * Walmart Growth — Listing Remediation.
 *
 * Packages the multipack-fix algorithm into the command center:
 *   - KPIs: listings improved, avg listing-quality lift, avg conversion lift,
 *     measurements pending.
 *   - "Applied — before / after": every change we made (images/bullets/desc) with
 *     the listing-quality / content / conversion / traffic delta once a post-change
 *     sweep lands.
 *   - "Recommended next": multipacks with content issues not yet fixed (pack >= 4
 *     first, wave-1 scope); select + queue them for the remediation worker.
 *
 * Reads /api/walmart/growth/remediation (history + summary + candidates + queue).
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ExternalLink, ArrowUpRight, ArrowDownRight, Sparkles, Image as ImageIcon, ListChecks } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard, RiskPill } from "@/components/kit";
import { cn } from "@/lib/utils";

interface Metrics { lq: number | null; content: number | null; conv: number | null; views: number | null; gmv: number | null; }
interface HistoryRow {
  sku: string; url: string | null; runAt: string; feedStatus: string | null; ok: boolean;
  packCount: number | null; newTitle: string | null; bulletsCount: number | null; imagesCount: number | null;
  descriptionLength: number | null; usedAiPolish: boolean; notes: string | null; measured: boolean;
  before: Metrics; after: Metrics; deltas: Metrics;
}
interface Candidate {
  sku: string; itemId: string | null; productName: string | null; packCount: number | null;
  lqScore: number | null; contentScore: number | null; issueCount: number | null;
  contentIssues: string[]; pageViews30d: number | null; conversionRate30d: number | null; gmv30d: number | null; inStock: boolean;
}
interface RemediationResponse {
  summary: { applied: number; measured: number; pendingMeasure: number; avgLqDelta: number | null; avgContentDelta: number | null; avgConvDelta: number | null; avgViewsDelta: number | null; };
  history: HistoryRow[];
  candidates: Candidate[];
  queue: Array<{ sku: string; status: string; queuedAt: string; feedId: string | null; error: string | null }>;
}

function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null) return "—";
  return Number(n).toFixed(digits);
}
function DeltaCell({ before, after, d, digits = 0, suffix = "" }: { before: number | null; after: number | null; d: number | null; digits?: number; suffix?: string }) {
  if (after == null) return <span className="text-ink-3">{fmt(before, digits)}{suffix} <span className="text-[10px]">· pending</span></span>;
  const up = (d ?? 0) > 0, down = (d ?? 0) < 0;
  const color = up ? "var(--green-ink)" : down ? "var(--danger)" : "var(--ink-3)";
  return (
    <span className="tabular">
      {fmt(before, digits)}{suffix} → <span style={{ color, fontWeight: 600 }}>{fmt(after, digits)}{suffix}</span>
      {d != null && d !== 0 && (
        <span className="ml-1 inline-flex items-center text-[10px]" style={{ color }}>
          {up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}{Math.abs(d).toFixed(digits)}
        </span>
      )}
    </span>
  );
}

export function RemediationPanel() {
  const [data, setData] = useState<RemediationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [queuing, setQueuing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/walmart/growth/remediation");
      setData(await res.json());
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = (sku: string) => setSelected((s) => { const n = new Set(s); n.has(sku) ? n.delete(sku) : n.add(sku); return n; });
  const toggleAll = (skus: string[]) => setSelected((s) => s.size === skus.length ? new Set() : new Set(skus));

  async function queueSelected() {
    if (!selected.size) return;
    setQueuing(true); setMsg(null);
    try {
      const res = await fetch("/api/walmart/growth/remediation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skus: [...selected] }) });
      const j = await res.json();
      setMsg(`Queued ${j.queued} listing(s) for remediation. The worker applies them and logs before/after.`);
      setSelected(new Set());
      await load();
    } catch { setMsg("Failed to queue — try again."); }
    finally { setQueuing(false); }
  }

  const s = data?.summary;
  const candidates = data?.candidates ?? [];
  const candSkus = candidates.map((c) => c.sku);

  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Listings improved" value={s ? s.applied : "—"} icon={<ListChecks size={15} />} />
        <KpiCard label="Avg listing-quality lift" value={s?.avgLqDelta != null ? `${s.avgLqDelta > 0 ? "+" : ""}${s.avgLqDelta.toFixed(1)}` : "—"}
          icon={<ArrowUpRight size={15} />} iconVariant={s?.avgLqDelta != null && s.avgLqDelta > 0 ? "default" : "warn"}
          trend={s?.measured ? { value: `${s.measured} measured`, positive: true } : undefined} />
        <KpiCard label="Avg conversion lift" value={s?.avgConvDelta != null ? `${(s.avgConvDelta * 100).toFixed(2)}pp` : "—"}
          icon={<Sparkles size={15} />} iconVariant={s?.avgConvDelta != null && s.avgConvDelta > 0 ? "default" : "warn"} />
        <KpiCard label="Awaiting measurement" value={s ? s.pendingMeasure : "—"} icon={<RefreshCw size={15} />} iconVariant="warn"
          trend={{ value: "after next sweep", positive: false }} />
      </div>

      {msg && <div className="rounded-lg border border-rule bg-green-soft px-3 py-2 text-[12px] text-green-ink">{msg}</div>}

      {/* Recommended next */}
      <Panel>
        <PanelHeader title="Recommended next — multipacks with content gaps" count={candidates.length}
          right={
            <div className="flex items-center gap-2">
              {selected.size > 0 && <span className="text-[12px] text-ink-3">{selected.size} selected</span>}
              <Btn size="sm" variant="primary" loading={queuing} disabled={!selected.size} onClick={queueSelected}>
                Queue remediation
              </Btn>
              <Btn size="sm" icon={<RefreshCw size={13} />} onClick={load}>Refresh</Btn>
            </div>
          } />
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3">
                <th className="px-3 py-2"><input type="checkbox" checked={!!candSkus.length && selected.size === candSkus.length} onChange={() => toggleAll(candSkus)} /></th>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">Pack</th>
                <th className="px-3 py-2">LQ</th>
                <th className="px-3 py-2">Content</th>
                <th className="px-3 py-2">Content gaps</th>
                <th className="px-3 py-2">Views 30d</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-3">Loading…</td></tr>}
              {!loading && !candidates.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-3">No multipack candidates pending — all caught up.</td></tr>}
              {candidates.map((c) => (
                <tr key={c.sku} className={cn("border-b border-rule/60 hover:bg-bg-elev/50", selected.has(c.sku) && "bg-green-soft/40")}>
                  <td className="px-3 py-2"><input type="checkbox" checked={selected.has(c.sku)} onChange={() => toggle(c.sku)} /></td>
                  <td className="px-3 py-2 max-w-[320px]">
                    <div className="truncate text-ink">{c.productName || c.sku}</div>
                    <div className="font-mono text-[10px] text-ink-3">{c.sku}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[11px]", (c.packCount ?? 0) >= 4 ? "bg-green-soft text-green-ink" : "bg-bg-elev text-ink-2")}>×{c.packCount ?? "?"}</span>
                  </td>
                  <td className="px-3 py-2 tabular">{fmt(c.lqScore)}</td>
                  <td className="px-3 py-2 tabular">{fmt(c.contentScore)}</td>
                  <td className="px-3 py-2 max-w-[280px]">
                    {c.contentIssues.length ? (
                      <span className="text-ink-2" title={c.contentIssues.join("\n")}>{c.contentIssues.slice(0, 2).join("; ")}{c.contentIssues.length > 2 ? ` +${c.contentIssues.length - 2}` : ""}</span>
                    ) : <span className="text-ink-3">—</span>}
                  </td>
                  <td className="px-3 py-2 tabular">{fmt(c.pageViews30d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Applied — before / after */}
      <Panel>
        <PanelHeader title="Applied — before / after" count={data?.history.length}
          right={data?.summary.pendingMeasure ? <span className="text-[11px] text-ink-3">deltas fill in after the next listing-quality sweep</span> : undefined} />
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3">
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">Changed</th>
                <th className="px-3 py-2">Listing quality</th>
                <th className="px-3 py-2">Content</th>
                <th className="px-3 py-2">Conversion</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {!loading && !data?.history.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-3">No remediations logged yet.</td></tr>}
              {data?.history.map((h, i) => (
                <tr key={h.sku + i} className="border-b border-rule/60 hover:bg-bg-elev/50">
                  <td className="px-3 py-2 max-w-[300px]">
                    <div className="truncate text-ink">{h.newTitle || h.sku}</div>
                    <div className="font-mono text-[10px] text-ink-3">{h.sku} · {new Date(h.runAt).toLocaleDateString()}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 text-[11px] text-ink-2">
                      <span className="inline-flex items-center gap-0.5"><ImageIcon size={11} />{h.imagesCount ?? "—"}</span>
                      <span className="inline-flex items-center gap-0.5"><ListChecks size={11} />{h.bulletsCount ?? "—"}</span>
                      {h.usedAiPolish && <Sparkles size={11} style={{ color: "var(--green-ink)" }} />}
                    </div>
                  </td>
                  <td className="px-3 py-2"><DeltaCell before={h.before.lq} after={h.after.lq} d={h.deltas.lq} digits={1} /></td>
                  <td className="px-3 py-2"><DeltaCell before={h.before.content} after={h.after.content} d={h.deltas.content} /></td>
                  <td className="px-3 py-2"><DeltaCell before={h.before.conv != null ? h.before.conv * 100 : null} after={h.after.conv != null ? h.after.conv * 100 : null} d={h.deltas.conv != null ? h.deltas.conv * 100 : null} digits={2} suffix="%" /></td>
                  <td className="px-3 py-2">
                    {h.ok ? <RiskPill level="low">live</RiskPill> : <RiskPill level="high">{h.feedStatus || "failed"}</RiskPill>}
                  </td>
                  <td className="px-3 py-2">
                    {h.url && <a href={h.url} target="_blank" rel="noreferrer" className="inline-flex items-center text-ink-3 hover:text-ink"><ExternalLink size={13} /></a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
