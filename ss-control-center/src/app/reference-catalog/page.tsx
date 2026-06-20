"use client";

import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import {
  Loader2, AlertCircle, Search, X, RefreshCw, Wand2, ImageOff,
  Boxes, Tags, Store, ListChecks, ExternalLink, Camera, Check, Minus,
  Clock, CheckCircle2, XCircle,
} from "lucide-react";
import { PageHead, Btn, Panel, PanelHeader, PanelBody, KpiCard } from "@/components/kit";
import { cn } from "@/lib/utils";

type ProductRow = {
  id: string;
  brand: string | null;
  title: string | null;
  size: string | null;
  unitMeasure: string | null;
  category: string | null;
  mainImageUrl: string | null;
  bestPrice: number | null;
  bestRetailer: string | null;
  pricePerMeasure: number | null;
  offerCount: number;
  bestOfferUrl: string | null;
  needsReview: number | boolean | null;
  imgCount: number | null;
  hasDesc: number;
  hasIngr: number;
  hasNutri: number;
};
type Facets = {
  brands: { brand: string; n: number }[];
  categories: { category: string; n: number }[];
  retailers: { retailer: string; n: number }[];
};
type Quality = { fullGallery: number; withDesc: number; withBullets: number; withIngredients: number; withNutrition: number; withUpc: number; needsReview: number };
type CatalogResp = {
  ok: boolean;
  products: ProductRow[];
  total: number;
  filtered: number;
  facets: Facets;
  growth: { d: string; n: number }[];
  queue: Record<string, number>;
  quality: Quality | null;
  error?: string;
};

const money = (n: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);
const perMeasure = (n: number | null, unit: string | null) => (n == null ? "—" : `$${n.toFixed(3)}/${unit || "u"}`);

// Storage-class chip (Frozen | Refrigerated | Dry). Frozen is the one that matters
// most operationally (needs a cooler), so it gets the loud blue.
function TempBadge({ value }: { value: string | null }) {
  const v = (value || "").toLowerCase();
  if (v === "frozen") return <span className="shrink-0 rounded bg-info-tint px-1.5 py-0.5 text-[10px] font-medium text-info">Frozen</span>;
  if (v === "refrigerated") return <span className="shrink-0 rounded bg-green-soft px-1.5 py-0.5 text-[10px] font-medium text-green-ink">Chilled</span>;
  if (v === "dry") return <span className="shrink-0 rounded bg-bg-elev px-1.5 py-0.5 text-[10px] font-medium text-ink-3">Dry</span>;
  return null;
}

export default function ReferenceCatalogPage() {
  const [data, setData] = useState<CatalogResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [retailer, setRetailer] = useState("");
  const [sort, setSort] = useState("new");

  // vector enrichment box
  const [vector, setVector] = useState("");
  const [enqueuing, setEnqueuing] = useState(false);
  const [enqueueMsg, setEnqueueMsg] = useState<string | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);

  const loadJobs = useCallback(async () => {
    try { const r = await fetch("/api/reference-catalog/enqueue"); const j = await r.json(); if (j.ok) setJobs(j.jobs || []); } catch { /* */ }
  }, []);

  // product detail drawer
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ product: any; offers: any[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id); setDetail(null); setDetailLoading(true);
    try { const r = await fetch(`/api/reference-catalog/detail?id=${encodeURIComponent(id)}`); const j = await r.json(); if (j.ok) setDetail({ product: j.product, offers: j.offers }); } catch { /* */ } finally { setDetailLoading(false); }
  }, []);
  const closeDetail = () => { setSelectedId(null); setDetail(null); };

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (debounced) p.set("search", debounced);
      if (brand) p.set("brand", brand);
      if (category) p.set("category", category);
      if (retailer) p.set("retailer", retailer);
      if (sort) p.set("sort", sort);
      const res = await fetch(`/api/reference-catalog?${p}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: CatalogResp = await res.json();
      if (!j.ok) throw new Error(j.error || "load failed");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [debounced, brand, category, retailer, sort]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadJobs(); }, [loadJobs]);

  // While any job is queued/running, poll jobs (and the catalog) so the progress
  // panel and counts update live as the worker drains the queue.
  const hasActive = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => { loadJobs(); load(); }, 6000);
    return () => clearInterval(t);
  }, [hasActive, loadJobs, load]);

  const submitVector = useCallback(async () => {
    const target = vector.trim();
    if (!target) return;
    setEnqueuing(true);
    setEnqueueMsg(null);
    try {
      const res = await fetch("/api/reference-catalog/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, targetType: "brand" }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "enqueue failed");
      setEnqueueMsg(j.created ? `Queued "${target}" for enrichment` : `"${target}" is already in the queue`);
      setVector("");
      load();
      loadJobs();
    } catch (e) {
      setEnqueueMsg(e instanceof Error ? e.message : "enqueue failed");
    } finally {
      setEnqueuing(false);
    }
  }, [vector, load, loadJobs]);

  // Cumulative growth for the sparkline (a steadily-rising line).
  const growthCumulative = useMemo(() => {
    if (!data?.growth?.length) return undefined;
    let acc = 0;
    const arr = data.growth.map((g) => (acc += Number(g.n)));
    return arr.length >= 2 ? arr : undefined;
  }, [data?.growth]);

  const q = data?.queue || {};
  const brandsCount = data?.facets.brands.length ?? 0;
  const retailersCount = data?.facets.retailers.length ?? 0;
  const queuedCount = (q.queued || 0) + (q.running || 0);

  const growthDays = data?.growth ?? [];
  const growthMax = Math.max(1, ...growthDays.map((g) => Number(g.n)));
  const todayAdded = growthDays.length ? Number(growthDays[growthDays.length - 1].n) : 0;
  const retailers = data?.facets.retailers ?? [];
  const retailerMax = Math.max(1, ...retailers.map((r) => Number(r.n)));

  const anyFilter = !!(debounced || brand || category || retailer);
  const clearFilters = () => { setSearch(""); setBrand(""); setCategory(""); setRetailer(""); };

  return (
    <div className="space-y-5">
      <PageHead
        title="Reference Catalog"
        subtitle={<>Donor product knowledge base · {data?.total ?? 0} unique products{anyFilter ? ` · ${data?.filtered ?? 0} match` : ""}</>}
        actions={<Btn variant="default" icon={<RefreshCw size={13} />} onClick={load} loading={loading}>Refresh</Btn>}
      />

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Products" value={data?.total ?? 0} icon={<Boxes size={15} />} sparkline={growthCumulative} />
        <KpiCard label="Brands" value={brandsCount} icon={<Tags size={15} />} />
        <KpiCard label="Retailers" value={retailersCount} icon={<Store size={15} />} />
        <KpiCard
          label="Enrichment queue"
          value={queuedCount}
          icon={<ListChecks size={15} />}
          iconVariant={queuedCount > 0 ? "warn" : "default"}
          chips={[
            { label: `done ${q.done || 0}`, variant: "ok" },
            ...(q.error ? [{ label: `err ${q.error}`, variant: "urgent" as const }] : []),
          ]}
        />
      </div>

      {/* Growth + breakdown visualization */}
      <div className="grid gap-3 md:grid-cols-2">
        <Panel>
          <PanelHeader title="Catalog growth" right={<span className="text-[11.5px] text-ink-3">+{todayAdded} latest</span>} />
          <PanelBody>
            {growthDays.length ? (
              <div className="flex h-28 items-end gap-1">
                {growthDays.map((g) => (
                  <div key={g.d} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${g.d}: +${g.n}`}>
                    <div className="w-full rounded-t bg-green" style={{ height: `${Math.max(4, (Number(g.n) / growthMax) * 90)}px` }} />
                    <div className="text-[9px] text-ink-4">{g.d.slice(5)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-[12.5px] text-ink-3">No data yet.</div>
            )}
            <div className="mt-2 text-[11.5px] text-ink-3">New unique products added per day · {data?.total ?? 0} total</div>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="By retailer" count={retailers.length} />
          <PanelBody>
            {retailers.length ? (
              <div className="space-y-1.5">
                {retailers.map((r) => (
                  <div key={r.retailer} className="flex items-center gap-2">
                    <div className="w-20 truncate text-[12px] capitalize text-ink-2">{r.retailer}</div>
                    <div className="h-3 flex-1 overflow-hidden rounded bg-bg-elev">
                      <div className="h-full rounded bg-green" style={{ width: `${(Number(r.n) / retailerMax) * 100}%` }} />
                    </div>
                    <div className="w-12 text-right text-[11.5px] tabular text-ink-3">{r.n}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-[12.5px] text-ink-3">No offers yet.</div>
            )}
            <div className="mt-2 text-[11.5px] text-ink-3">Offers per retailer (price points across stores)</div>
          </PanelBody>
        </Panel>
      </div>

      {/* Content completeness — verify the engine is collecting content */}
      {data?.quality && (
        <Panel>
          <PanelHeader
            title="Content completeness"
            right={<span className="text-[11.5px] text-ink-3">{data.total} products{Number(data.quality.needsReview) > 0 ? ` · ${data.quality.needsReview} need review` : ""}</span>}
          />
          <PanelBody>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 md:grid-cols-3">
              {([
                ["≥5 photos", data.quality.fullGallery],
                ["Description", data.quality.withDesc],
                ["Bullets", data.quality.withBullets],
                ["Ingredients", data.quality.withIngredients],
                ["Nutrition", data.quality.withNutrition],
                ["UPC", data.quality.withUpc],
              ] as [string, number][]).map(([label, value]) => {
                const v = Number(value);
                const pct = data.total ? Math.round((v / data.total) * 100) : 0;
                return (
                  <div key={label}>
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="text-ink-2">{label}</span>
                      <span className="tabular text-ink-3">{v} · {pct}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded bg-bg-elev">
                      <div className="h-full rounded bg-green" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 text-[11.5px] text-ink-3">Full content lands as the harvest worker processes each product (BlueCart detail + vision image-QC). Click any row to inspect what was collected.</div>
          </PanelBody>
        </Panel>
      )}

      {/* Vector enrichment */}
      <Panel>
        <PanelHeader title="Enrich the catalog" right={<span className="text-[11.5px] text-ink-3">queued {q.queued || 0} · running {q.running || 0} · done {q.done || 0}</span>} />
        <PanelBody>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2 min-w-[240px]">
              <Wand2 size={15} className="text-ink-3" />
              <input
                value={vector}
                onChange={(e) => setVector(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitVector(); }}
                placeholder='Enrich by brand — e.g. "Jimmy Dean", "Uncrustables"…'
                className="flex-1 bg-transparent text-[13px] text-ink outline-none"
              />
            </div>
            <Btn variant="primary" size="md" icon={<Wand2 size={14} />} onClick={submitVector} loading={enqueuing} disabled={!vector.trim()}>
              Enrich
            </Btn>
          </div>
          {enqueueMsg && <div className="mt-2 text-[12.5px] text-green-ink">{enqueueMsg}</div>}
          <div className="mt-2 text-[11.5px] text-ink-3">
            Queues a directed enrichment job. The worker searches live retailers (first-party only), then fills the catalog. A queued job starts within a couple of minutes.
          </div>

          {/* Live job progress */}
          {jobs.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-rule pt-3">
              {jobs.slice(0, 8).map((j) => <JobRow key={j.id} job={j} />)}
            </div>
          )}
        </PanelBody>
      </Panel>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2 min-w-[220px]">
          <Search size={15} className="text-ink-3" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product or brand…"
            className="flex-1 bg-transparent text-[13px] text-ink outline-none"
          />
          {search && <button onClick={() => setSearch("")} className="text-ink-3 hover:text-ink"><X size={14} /></button>}
        </div>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} className="rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] text-ink outline-none">
          <option value="">All brands</option>
          {data?.facets.brands.map((b) => <option key={b.brand} value={b.brand}>{b.brand} ({b.n})</option>)}
        </select>
        {data && data.facets.categories.length > 0 && (
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] text-ink outline-none">
            <option value="">All storage</option>
            {data.facets.categories.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.n})</option>)}
          </select>
        )}
        <select value={retailer} onChange={(e) => setRetailer(e.target.value)} className="rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] text-ink outline-none">
          <option value="">All retailers</option>
          {data?.facets.retailers.map((r) => <option key={r.retailer} value={r.retailer}>{r.retailer} ({r.n})</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-lg border border-rule bg-surface px-2.5 py-2 text-[12.5px] text-ink outline-none">
          <option value="new">Newest</option>
          <option value="price">Cheapest</option>
          <option value="ppm">Best $/unit</option>
        </select>
        {anyFilter && <Btn variant="ghost" icon={<X size={13} />} onClick={clearFilters}>Clear</Btn>}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-tint px-3 py-2 text-[13px] text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /><div>{error}</div>
        </div>
      )}

      {/* Table */}
      <Panel>
        <PanelHeader title="Products" count={data?.filtered ?? 0} />
        {loading && !data ? (
          <div className="flex items-center justify-center gap-2 px-4 py-12">
            <Loader2 size={16} className="animate-spin" /><span className="text-[13px] text-ink-3">Loading catalog…</span>
          </div>
        ) : !data?.products.length ? (
          <div className="px-4 py-12 text-center text-[13px] text-ink-3">
            No products yet. Use “Enrich the catalog” above to queue a brand.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-rule text-left text-[11px] font-mono uppercase tracking-wider text-ink-3">
                  <th className="px-4 py-2 font-medium">Photo</th>
                  <th className="px-2 py-2 font-medium">Brand</th>
                  <th className="px-2 py-2 font-medium">Product</th>
                  <th className="px-2 py-2 font-medium">Size</th>
                  <th className="px-2 py-2 font-medium text-right">Best price</th>
                  <th className="px-2 py-2 font-medium text-right">$/unit</th>
                  <th className="px-2 py-2 font-medium">Retailer</th>
                  <th className="px-2 py-2 font-medium text-right">Offers</th>
                  <th className="px-2 py-2 font-medium">Content</th>
                  <th className="px-2 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.id} onClick={() => openDetail(p.id)} className="cursor-pointer border-b border-rule/60 hover:bg-bg-elev/40">
                    <td className="px-4 py-2">
                      <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-rule bg-bg-elev">
                        {p.mainImageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.mainImageUrl} alt="" className="h-full w-full object-contain" loading="lazy" />
                        ) : (
                          <ImageOff size={16} className="text-ink-4" />
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-ink-2">{p.brand || "—"}</td>
                    <td className="px-2 py-2 text-ink max-w-[360px]">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate" title={p.title || ""}>{p.title || "—"}</span>
                        <TempBadge value={p.category} />
                        {p.needsReview ? <span className="shrink-0 rounded bg-warn-tint px-1.5 py-0.5 text-[10px] font-medium text-warn-strong" title="Image QC flagged — no clean front photo">review</span> : null}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-ink-3 tabular">{p.size || "—"}</td>
                    <td className="px-2 py-2 text-right tabular text-ink">{money(p.bestPrice)}</td>
                    <td className="px-2 py-2 text-right tabular text-ink-3">{perMeasure(p.pricePerMeasure, p.unitMeasure)}</td>
                    <td className="px-2 py-2 text-ink-3">{p.bestRetailer || "—"}</td>
                    <td className="px-2 py-2 text-right tabular text-ink-3">{p.offerCount}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span className="inline-flex items-center gap-0.5 tabular text-ink-3"><Camera size={11} />{p.imgCount ?? 0}</span>
                        <span className={p.hasDesc ? "text-green-ink" : "text-ink-4"} title="Description">D</span>
                        <span className={p.hasIngr ? "text-green-ink" : "text-ink-4"} title="Ingredients">I</span>
                        <span className={p.hasNutri ? "text-green-ink" : "text-ink-4"} title="Nutrition">N</span>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      {p.bestOfferUrl ? (
                        <a href={p.bestOfferUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Open source listing" className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-rule text-ink-3 hover:border-green-mid/40 hover:text-green-ink">
                          <ExternalLink size={14} />
                        </a>
                      ) : <span className="text-ink-4">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Product detail drawer — verify what the engine collected per product */}
      {selectedId && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={closeDetail}>
          <div className="h-full w-full max-w-[560px] overflow-y-auto bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-rule bg-surface px-4 py-3">
              <div className="text-[14px] font-semibold text-ink">Product detail</div>
              <button onClick={closeDetail} className="text-ink-3 hover:text-ink"><X size={16} /></button>
            </div>
            {detailLoading ? (
              <div className="flex items-center gap-2 px-4 py-12 text-[13px] text-ink-3"><Loader2 size={16} className="animate-spin" />Loading…</div>
            ) : !detail ? (
              <div className="px-4 py-12 text-[13px] text-ink-3">Failed to load.</div>
            ) : (
              <DetailBody product={detail.product} offers={detail.offers} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── Enrichment job row ──────────────────────────────
   One queued/running/done/error job with a live result summary (products + offers
   found, which retailers were hit). Gives the "vector" box the progress Vladimir
   asked for — what it found, per job. */
function JobRow({ job }: { job: any }) {
  let res: any = null;
  try { res = job.result ? JSON.parse(job.result) : null; } catch { /* */ }
  const status = job.status as string;
  const icon = status === "done" ? <CheckCircle2 size={14} className="shrink-0 text-green-ink" />
    : status === "running" ? <Loader2 size={14} className="shrink-0 animate-spin text-info" />
    : status === "error" ? <XCircle size={14} className="shrink-0 text-danger" />
    : <Clock size={14} className="shrink-0 text-ink-4" />;
  const retailers: string[] = res?.retailersHit || [];
  return (
    <div className="flex items-center gap-2.5 text-[12.5px]">
      {icon}
      <span className="font-medium capitalize text-ink">{job.target}</span>
      <div className="flex-1 truncate text-ink-3">
        {status === "queued" && <span>queued — starts within ~2 min</span>}
        {status === "running" && <span>searching retailers…</span>}
        {status === "done" && res && (
          <span>
            <span className="text-green-ink">+{res.productsCreated} products</span>
            {" · "}{res.offersUpserted} offers
            {retailers.length ? <span className="text-ink-4">{" · "}{retailers.join(", ")}</span> : null}
            {res.rejected ? <span className="text-ink-4">{" · "}{res.rejected} filtered out</span> : null}
          </span>
        )}
        {status === "done" && !res && <span className="text-ink-4">done</span>}
        {status === "error" && <span className="text-danger">{job.error || "failed"}</span>}
      </div>
    </div>
  );
}

/* ───────────────────────── Product detail drawer body ─────────────────────────
   Shows EVERY field harvested for a product so Vladimir can verify the engine
   captured the full record: identity, price rollup, per-retailer offers (all
   columns), full content (description / bullets / ingredients / specs /
   nutrition), a collected-vs-missing checklist, and source metadata. */

function fmtDate(s: any): string {
  if (!s) return "—";
  const str = String(s);
  return str.length >= 10 ? str.slice(0, 10) : str;
}

// One labeled field. Renders a muted "—" when empty so missing data is visible.
function Field({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  const empty = value == null || value === "" || (Array.isArray(value) && !value.length);
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-[11.5px] text-ink-3">{label}</span>
      <span className={cn("text-right text-[12px]", empty ? "text-ink-4" : mono ? "tabular text-ink-2" : "text-ink-2")}>
        {empty ? "—" : String(value)}
      </span>
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-rule bg-bg-elev/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function DetailBody({ product: p, offers }: { product: any; offers: any[] }) {
  const imgs: string[] = p.imageUrls || [];
  const bullets: string[] = p.bullets || [];
  const attrs: { name: string; value: string }[] = p.attributes || [];
  const nutriRows: { label: string; value: string }[] = p.nutritionRows || [];

  // Collected-vs-missing checklist — at-a-glance content QA for this one product.
  const checklist: [string, boolean][] = [
    ["Title", !!p.title],
    ["≥5 photos", imgs.length >= 5],
    ["Description", !!p.description],
    ["Bullets", bullets.length > 0],
    ["Ingredients", !!p.ingredients],
    ["Nutrition", !!(nutriRows.length || p.nutritionRaw)],
    ["Specs", attrs.length > 0],
    ["UPC", !!p.upc],
    ["Price", p.bestPrice != null],
  ];
  const done = checklist.filter(([, v]) => v).length;

  return (
    <div className="space-y-4 p-4">
      {/* Gallery */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Photos</div>
          <span className="text-[11px] text-ink-3">{imgs.length} image{imgs.length === 1 ? "" : "s"}</span>
        </div>
        {imgs.length ? (
          <div className="flex flex-wrap gap-2">
            {imgs.map((u, i) => (
              <a key={i} href={u} target="_blank" rel="noreferrer" className="h-20 w-20 overflow-hidden rounded border border-rule bg-bg-elev hover:border-green-mid/50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="" className="h-full w-full object-contain" loading="lazy" />
              </a>
            ))}
          </div>
        ) : (
          <div className="text-[12.5px] text-ink-4">No gallery harvested yet — only a thumbnail.</div>
        )}
      </div>

      {/* Title + flags */}
      <div>
        <div className="flex items-start gap-2">
          <div className="text-[15px] font-semibold leading-snug text-ink">{p.title || "—"}</div>
          <TempBadge value={p.category} />
          {p.needsReview ? <span className="mt-0.5 shrink-0 rounded bg-warn-tint px-1.5 py-0.5 text-[10px] font-medium text-warn-strong" title="Image QC flagged — no clean front photo">review</span> : null}
        </div>
        <div className="mt-1 text-[12.5px] text-ink-3">{[p.brand, p.size].filter(Boolean).join(" · ") || "—"}</div>
      </div>

      {/* Collected-content checklist */}
      <Section title="Collected content" right={<span className="text-[11px] text-ink-3">{done}/{checklist.length}</span>}>
        <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
          {checklist.map(([label, ok]) => (
            <div key={label} className="flex items-center gap-1.5 text-[11.5px]">
              {ok ? <Check size={13} className="shrink-0 text-green-ink" /> : <Minus size={13} className="shrink-0 text-ink-4" />}
              <span className={ok ? "text-ink-2" : "text-ink-4"}>{label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Identity */}
      <Section title="Identity">
        <Field label="Brand" value={p.brand} />
        <Field label="Product line" value={p.productLine} />
        <Field label="Flavor" value={p.flavor} />
        <Field label="Container" value={p.containerType} />
        <Field label="Size" value={p.size} />
        <Field label="Unit measure" value={p.unitAmount != null || p.unitMeasure ? `${p.unitAmount ?? "?"} ${p.unitMeasure ?? ""}`.trim() : null} mono />
        <Field label="Storage class" value={p.category} />
        <Field label="UPC" value={p.upc} mono />
        <Field label="GTIN" value={p.gtin} mono />
        <Field label="Confidence" value={p.confidence != null ? `${Math.round(Number(p.confidence) * 100)}%` : null} mono />
      </Section>

      {/* Price rollup */}
      <Section title="Best cost">
        <Field label="Best price" value={p.bestPrice != null ? money(Number(p.bestPrice)) : null} mono />
        <Field label="Best retailer" value={p.bestRetailer} />
        <Field label="$/measure" value={p.pricePerMeasure != null ? perMeasure(Number(p.pricePerMeasure), p.unitMeasure) : null} mono />
        <Field label="Currency" value={p.currency} />
      </Section>

      {/* Per-retailer offers — every column */}
      <Section title="Offers by retailer" right={<span className="text-[11px] text-ink-3">{offers.length}</span>}>
        {offers.length ? (
          <div className="space-y-2.5">
            {offers.map((o: any, i: number) => (
              <div key={i} className="rounded-md border border-rule bg-surface p-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium capitalize text-ink">{o.retailer}</span>
                    {o.via && o.via !== "direct" && <span className="rounded bg-bg-elev px-1.5 py-0.5 text-[10px] text-ink-3">{o.via}</span>}
                    {o.isFirstParty ? <span className="rounded bg-green-soft px-1.5 py-0.5 text-[10px] text-green-ink">1P</span> : <span className="rounded bg-bg-elev px-1.5 py-0.5 text-[10px] text-ink-3">3P</span>}
                    {o.inStock === false && <span className="rounded bg-warn-tint px-1.5 py-0.5 text-[10px] text-warn-strong">out of stock</span>}
                  </div>
                  {o.productUrl && <a href={o.productUrl} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-green-ink"><ExternalLink size={13} /></a>}
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-x-4">
                  <Field label="Price" value={o.price != null ? money(Number(o.price)) : null} mono />
                  <Field label="$/unit" value={o.pricePerUnit != null ? `$${Number(o.pricePerUnit).toFixed(2)}` : null} mono />
                  <Field label="Pack size" value={o.packSizeSeen} mono />
                  <Field label="ZIP" value={o.zip} mono />
                  <Field label="Seller" value={o.sellerName} />
                  <Field label="Source" value={o.sourceApi} />
                  <Field label="Item ID" value={o.retailerProductId} mono />
                  <Field label="Fetched" value={fmtDate(o.fetchedAt)} mono />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[12.5px] text-ink-4">No offers.</div>
        )}
      </Section>

      {/* Full content */}
      {p.description && (
        <Section title="Description"><div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{p.description}</div></Section>
      )}
      {bullets.length > 0 && (
        <Section title="Highlights"><ul className="list-disc space-y-0.5 pl-4 text-[12.5px] text-ink-2">{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul></Section>
      )}
      {p.ingredients && (
        <Section title="Ingredients"><div className="text-[12px] leading-relaxed text-ink-2">{p.ingredients}</div></Section>
      )}
      {attrs.length > 0 && (
        <Section title="Specifications" right={<span className="text-[11px] text-ink-3">{attrs.length}</span>}>
          <div className="grid grid-cols-1 gap-y-1">
            {attrs.map((a, i) => <div key={i} className="flex justify-between gap-3 text-[12px]"><span className="text-ink-3">{a.name}</span><span className="text-right text-ink-2">{a.value}</span></div>)}
          </div>
        </Section>
      )}
      {(nutriRows.length > 0 || p.nutritionRaw) && (
        <Section title="Nutrition facts">
          {nutriRows.length > 0 ? (
            <div className="grid grid-cols-1 gap-y-1">
              {nutriRows.map((n, i) => <div key={i} className="flex justify-between gap-3 text-[12px]"><span className="text-ink-3">{n.label}</span><span className="text-right text-ink-2">{n.value}</span></div>)}
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words text-[11.5px] text-ink-3">{String(p.nutritionRaw)}</div>
          )}
        </Section>
      )}

      {/* Metadata */}
      <Section title="Record metadata">
        <Field label="Product ID" value={p.id} mono />
        <Field label="Identity key" value={p.identityKey} mono />
        <Field label="Added" value={fmtDate(p.createdAt)} mono />
        <Field label="Updated" value={fmtDate(p.updatedAt)} mono />
      </Section>
    </div>
  );
}
