"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Loader2, AlertCircle, Search, X, RefreshCw, Wand2, ImageOff,
  Boxes, Tags, Store, ListChecks, ExternalLink, Camera,
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
    } catch (e) {
      setEnqueueMsg(e instanceof Error ? e.message : "enqueue failed");
    } finally {
      setEnqueuing(false);
    }
  }, [vector, load]);

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
            Queues a directed enrichment job. The worker searches live retailers (first-party only), then fills the catalog.
          </div>
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
            <option value="">All categories</option>
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
    </div>
  );
}
