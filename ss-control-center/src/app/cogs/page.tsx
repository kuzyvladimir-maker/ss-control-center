"use client";

/**
 * SKU Cost Catalog (/cogs) — the "record" layer of the COGS engine.
 *
 * Every one of our SKUs and its true landed cost (COGS), HOW we got it
 * (own-brand / exact 1P / line-price / Google estimate), and its structural
 * bill-of-materials (each component + its cost + a link to donor content). This is
 * what Economics and the listing tools consume. The background sweep fills it in
 * automatically — this page is where Vladimir watches coverage reach 100% and spots
 * the SKUs that still need a human look (needsReview).
 */

import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { Loader2, AlertCircle, Search, X, RefreshCw, Boxes, DollarSign, AlertTriangle, CircleSlash, ChevronRight, ExternalLink } from "lucide-react";
import { PageHead, Btn, Panel, PanelHeader, PanelBody, KpiCard, HeroGreenCard, HeroLabel } from "@/components/kit";
import { cn } from "@/lib/utils";

type Component = {
  idx: number; product: string; flavor: string | null; size: string | null; qty: number;
  perUnitCost: number | null; lineCost: number | null; retailer: string | null;
  costMethod: string | null; donorProductId: string | null; isBundleComponent: boolean;
};
type Row = {
  sku: string; title: string | null; channel: string; costed: boolean;
  totalCost?: number; costPerUnit?: number; packSize?: number; confidence?: number;
  needsReview?: boolean; notes?: string; updatedAt?: string; compCount?: number;
  methods?: string[]; components?: Component[];
};
type Summary = {
  walmartTotal: number; walmartCosted: number; walmartRemaining: number; walmartCoveragePct: number;
  costedTotal: number; needsReview: number; byMethod: Record<string, number>;
};
type Resp = { ok: boolean; error?: string; summary: Summary; status: string; rows: Row[]; nextOffset: number | null };

const usd = (n: number | null | undefined) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Method → badge palette. own-brand = our product (trusted); exact = clean 1P;
// line-price / google = estimates (soft); none = no price (needs work).
const METHOD_STYLE: Record<string, string> = {
  "own-brand": "bg-green-soft text-green-ink",
  exact: "bg-info-tint text-info",
  "line-price": "bg-warn-tint text-warn-strong",
  google: "bg-warn-tint text-warn-strong",
  none: "bg-danger-tint text-danger",
};
const METHOD_LABEL: Record<string, string> = {
  "own-brand": "own-brand", exact: "1P exact", "line-price": "line-price est", google: "google est", none: "no price",
};
function MethodBadge({ m }: { m: string }) {
  return <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", METHOD_STYLE[m] || "bg-bg-elev text-ink-3")}>{METHOD_LABEL[m] || m}</span>;
}

export default function CogsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [channel, setChannel] = useState("");
  const [method, setMethod] = useState("");
  const [status, setStatus] = useState("costed");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebounced(search.trim().toLowerCase()), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (debounced) p.set("q", debounced);
      if (channel) p.set("channel", channel);
      if (method) p.set("method", method);
      if (reviewOnly) p.set("review", "1");
      p.set("status", status);
      p.set("limit", "100");
      const res = await fetch(`/api/cogs/catalog?${p}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: Resp = await res.json();
      if (!j.ok) throw new Error(j.error || "load failed");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally { setLoading(false); }
  }, [debounced, channel, method, status, reviewOnly]);

  useEffect(() => { load(); }, [load]);

  const s = data?.summary;
  const anyFilter = !!(debounced || channel || method || reviewOnly || status !== "costed");
  const clearFilters = () => { setSearch(""); setChannel(""); setMethod(""); setReviewOnly(false); setStatus("costed"); };

  return (
    <div className="space-y-5">
      <PageHead
        title="SKU Cost Catalog"
        subtitle={<>True landed cost (COGS) for every listing · {s?.costedTotal ?? 0} costed{s ? ` · ${s.walmartCoveragePct}% of published Walmart` : ""}</>}
        actions={<Btn variant="default" icon={<RefreshCw size={13} />} onClick={load} loading={loading}>Refresh</Btn>}
      />

      {/* HERO — lead with coverage + one plain next-step (Vladimir's UI rule). */}
      <HeroGreenCard>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <HeroLabel>Cost coverage</HeroLabel>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular text-white">{s?.walmartCoveragePct ?? 0}%</span>
              <span className="text-[13px] text-white/70">{s?.walmartCosted ?? 0} of {s?.walmartTotal ?? 0} published Walmart SKUs</span>
            </div>
            <div className="mt-2 h-2 w-full max-w-md overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-white" style={{ width: `${Math.min(100, s?.walmartCoveragePct ?? 0)}%` }} />
            </div>
            <p className="mt-2 text-[12.5px] leading-snug text-white/80">
              The engine fills the rest automatically (~2 weeks). Costs flow into Economics and the listing tools.
              {s && s.needsReview > 0 ? ` ${s.needsReview} costed with a soft estimate — worth a human check.` : ""}
            </p>
          </div>
          {s && s.needsReview > 0 && (
            <Btn variant="primary" size="md" icon={<AlertTriangle size={14} />} onClick={() => { setReviewOnly(true); setStatus("costed"); }}>
              Review flagged ({s.needsReview})
            </Btn>
          )}
        </div>
      </HeroGreenCard>

      {/* KPIs — all clickable into their slice (Vladimir's drill-down rule). */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Costed SKUs" value={s?.costedTotal ?? 0} icon={<DollarSign size={15} />} onClick={() => { setStatus("costed"); setReviewOnly(false); setMethod(""); }} />
        <KpiCard label="Uncosted (Walmart)" value={s?.walmartRemaining ?? 0} icon={<CircleSlash size={15} />} iconVariant={(s?.walmartRemaining ?? 0) > 0 ? "warn" : "default"} onClick={() => { setStatus("uncosted"); setReviewOnly(false); }} />
        <KpiCard label="Needs review" value={s?.needsReview ?? 0} icon={<AlertTriangle size={15} />} iconVariant={(s?.needsReview ?? 0) > 0 ? "warn" : "default"} onClick={() => { setReviewOnly(true); setStatus("costed"); }} />
        <KpiCard label="Own-brand" value={s?.byMethod?.["own-brand"] ?? 0} icon={<Boxes size={15} />} onClick={() => { setMethod("own-brand"); setStatus("costed"); }} />
      </div>

      {/* Method mix chips */}
      {s && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <span className="font-medium text-ink-2">Priced by:</span>
          {(["own-brand", "exact", "line-price", "google", "none"] as const).map((m) =>
            s.byMethod?.[m] ? (
              <button key={m} onClick={() => { setMethod(method === m ? "" : m); setStatus("costed"); }} className={cn("rounded-full border px-2 py-0.5", method === m ? "border-green bg-green-soft text-green-ink" : "border-rule hover:bg-bg-elev")}>
                {METHOD_LABEL[m]} · {s.byMethod[m]}
              </button>
            ) : null,
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU or title…"
            className="w-full rounded-lg border border-rule bg-surface py-2 pl-8 pr-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-4" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] text-ink outline-none">
          <option value="costed">Costed</option>
          <option value="uncosted">Uncosted (Walmart)</option>
        </select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} className="rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] text-ink outline-none">
          <option value="">All channels</option>
          <option value="walmart">Walmart</option>
          <option value="amazon">Amazon</option>
        </select>
        <select value={method} onChange={(e) => setMethod(e.target.value)} className="rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] text-ink outline-none">
          <option value="">All methods</option>
          <option value="own-brand">Own-brand</option>
          <option value="exact">1P exact</option>
          <option value="line-price">Line-price est</option>
          <option value="google">Google est</option>
          <option value="none">No price</option>
        </select>
        <label className="flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] text-ink-2">
          <input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} /> Needs review
        </label>
        {anyFilter && <Btn variant="ghost" icon={<X size={13} />} onClick={clearFilters}>Clear</Btn>}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-tint px-3 py-2 text-[13px] text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /><div>{error}</div>
        </div>
      )}

      {/* Table */}
      <Panel>
        <PanelHeader title={status === "uncosted" ? "Uncosted SKUs" : "Costed SKUs"} count={data?.rows.length ?? 0} />
        {loading && !data ? (
          <div className="flex items-center justify-center gap-2 px-4 py-12">
            <Loader2 size={16} className="animate-spin" /><span className="text-[13px] text-ink-3">Loading cost catalog…</span>
          </div>
        ) : !data?.rows.length ? (
          <div className="px-4 py-12 text-center text-[13px] text-ink-3">No SKUs match.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-rule text-left text-[11px] font-mono uppercase tracking-wider text-ink-3">
                  <th className="px-4 py-2 font-medium">SKU</th>
                  <th className="px-2 py-2 font-medium">Product</th>
                  <th className="px-2 py-2 font-medium">Channel</th>
                  {status === "costed" && <>
                    <th className="px-2 py-2 font-medium text-right">COGS</th>
                    <th className="px-2 py-2 font-medium text-right">$/unit</th>
                    <th className="px-2 py-2 font-medium text-right">Pack</th>
                    <th className="px-2 py-2 font-medium">Priced by</th>
                    <th className="px-2 py-2 font-medium text-right">Parts</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const isOpen = expanded === r.sku;
                  const canExpand = status === "costed" && (r.compCount ?? 0) > 0;
                  return (
                    <Fragment key={r.sku}>
                      <tr onClick={() => canExpand && setExpanded(isOpen ? null : r.sku)}
                        className={cn("border-b border-rule/60", canExpand && "cursor-pointer hover:bg-bg-elev/40", isOpen && "bg-bg-elev/30")}>
                        <td className="px-4 py-2 font-mono text-[12px] text-ink-2">
                          <div className="flex items-center gap-1">
                            {canExpand && <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", isOpen && "rotate-90")} />}
                            {r.sku}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-ink max-w-[380px]">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate" title={r.title || ""}>{r.title || "—"}</span>
                            {r.needsReview ? <span className="shrink-0 rounded bg-warn-tint px-1.5 py-0.5 text-[10px] font-medium text-warn-strong">review</span> : null}
                          </div>
                        </td>
                        <td className="px-2 py-2 capitalize text-ink-3">{r.channel}</td>
                        {status === "costed" && <>
                          <td className="px-2 py-2 text-right tabular font-medium text-ink">{usd(r.totalCost)}</td>
                          <td className="px-2 py-2 text-right tabular text-ink-3">{usd(r.costPerUnit)}</td>
                          <td className="px-2 py-2 text-right tabular text-ink-3">{r.packSize || "—"}</td>
                          <td className="px-2 py-2">
                            <div className="flex flex-wrap gap-1">{(r.methods || []).map((m) => <MethodBadge key={m} m={m} />)}</div>
                          </td>
                          <td className="px-2 py-2 text-right tabular text-ink-3">{r.compCount || "—"}</td>
                        </>}
                      </tr>
                      {isOpen && r.components && (
                        <tr className="border-b border-rule/60 bg-bg-elev/20">
                          <td colSpan={8} className="px-4 py-2">
                            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3 mb-1">Bill of materials</div>
                            <table className="w-full text-[12px]">
                              <tbody>
                                {r.components.map((c) => (
                                  <tr key={c.idx} className="border-t border-rule/40">
                                    <td className="py-1 pr-2 text-ink">{c.product}{c.size ? <span className="text-ink-4"> · {c.size}</span> : ""}</td>
                                    <td className="py-1 px-2 tabular text-ink-3">×{c.qty}</td>
                                    <td className="py-1 px-2 text-right tabular text-ink-2">{usd(c.perUnitCost)}/u</td>
                                    <td className="py-1 px-2 text-right tabular font-medium text-ink">{usd(c.lineCost)}</td>
                                    <td className="py-1 px-2">{c.costMethod ? <MethodBadge m={c.costMethod} /> : null}</td>
                                    <td className="py-1 px-2 text-ink-4">{c.retailer || ""}</td>
                                    <td className="py-1 pl-2 text-right">
                                      {c.donorProductId ? (
                                        <a href={`/reference-catalog?product=${c.donorProductId}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 text-[11px] text-info hover:underline">
                                          content <ExternalLink size={10} />
                                        </a>
                                      ) : <span className="text-[11px] text-ink-4">—</span>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {r.notes && <div className="mt-1.5 text-[11px] text-ink-4">{r.notes}</div>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
