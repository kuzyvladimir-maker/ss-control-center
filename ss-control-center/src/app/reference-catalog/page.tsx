"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Loader2, AlertCircle, Search, X, RefreshCw, Wand2, ImageOff,
  Boxes, Tags, Store, ListChecks,
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
};
type Facets = {
  brands: { brand: string; n: number }[];
  categories: { category: string; n: number }[];
  retailers: { retailer: string; n: number }[];
};
type CatalogResp = {
  ok: boolean;
  products: ProductRow[];
  total: number;
  filtered: number;
  facets: Facets;
  growth: { d: string; n: number }[];
  queue: Record<string, number>;
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
                </tr>
              </thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.id} className="border-b border-rule/60 hover:bg-bg-elev/40">
                    <td className="px-4 py-2">
                      <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-rule bg-bg-elev">
                        {p.mainImageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.mainImageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <ImageOff size={16} className="text-ink-4" />
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-ink-2">{p.brand || "—"}</td>
                    <td className="px-2 py-2 text-ink max-w-[360px]"><div className="truncate" title={p.title || ""}>{p.title || "—"}</div></td>
                    <td className="px-2 py-2 text-ink-3 tabular">{p.size || "—"}</td>
                    <td className="px-2 py-2 text-right tabular text-ink">{money(p.bestPrice)}</td>
                    <td className="px-2 py-2 text-right tabular text-ink-3">{perMeasure(p.pricePerMeasure, p.unitMeasure)}</td>
                    <td className="px-2 py-2 text-ink-3">{p.bestRetailer || "—"}</td>
                    <td className="px-2 py-2 text-right tabular text-ink-3">{p.offerCount}</td>
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
