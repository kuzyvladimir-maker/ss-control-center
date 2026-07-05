"use client";

/**
 * Catalog Status — the dashboard for the background catalog operation.
 *
 * One place to watch the crons grind: how many listings we have, how many are
 * enriched (Reference/Donor catalog), how many have a true cost (COGS catalog), the
 * good-vs-needs-review split, and a progress graph over time (hourly snapshots).
 * Leads to the two detail catalogs: /cogs (cost) and /reference-catalog (content).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, AlertCircle, RefreshCw, DollarSign, Database, AlertTriangle, Boxes, ChevronRight, CheckCircle2 } from "lucide-react";
import { PageHead, Btn, Panel, PanelHeader, PanelBody, KpiCard, HeroGreenCard, HeroLabel } from "@/components/kit";
import { CatalogTabs } from "@/components/catalog/CatalogTabs";
import { cn } from "@/lib/utils";

type Stats = {
  walmartTotal: number; walmartPublished: number; costedTotal: number; costedPublished: number;
  needsReview: number; ownBrand: number; exact: number; linePrice: number; google: number;
  donorProducts: number; donorOffers: number; withBom: number;
};
type Point = Stats & { capturedAt: string };
type Svc = { key: string; name: string; status: string; remaining: number | null; note?: string };
type ServiceHealth = { at: string; services: Svc[]; anyDry: boolean; anyLow: boolean };
type Resp = { ok: boolean; error?: string; current: Stats; series: Point[]; serviceHealth?: ServiceHealth | null };

const fmt = (n: number) => (n ?? 0).toLocaleString("en-US");

export default function CatalogStatusPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/catalog-status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: Resp = await res.json();
      if (!j.ok) throw new Error(j.error || "load failed");
      setData(j);
      setUpdatedAt(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Keep the dashboard live — refetch every 5 min (the underlying snapshot is hourly).
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    timer.current = setInterval(load, 5 * 60 * 1000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  const s = data?.current;
  const coverage = s && s.walmartPublished ? Math.round((s.costedPublished / s.walmartPublished) * 1000) / 10 : 0;
  const good = s ? s.ownBrand + s.exact : 0; // confident: own-brand + clean 1P
  const estimate = s ? s.linePrice + s.google : 0; // soft: line-price + google
  const series = data?.series || [];

  // Progress chart: costed SKUs over time (from hourly snapshots).
  const chartMax = Math.max(1, ...series.map((p) => p.costedTotal));
  const donorMax = Math.max(1, ...series.map((p) => p.donorProducts));

  return (
    <div className="space-y-5">
      <PageHead
        title="Catalog"
        subtitle={<>Background enrichment &amp; cost-collection progress{updatedAt ? ` · updated ${updatedAt}` : ""}</>}
        actions={<Btn variant="default" icon={<RefreshCw size={13} />} onClick={load} loading={loading}>Refresh</Btn>}
      />
      <CatalogTabs />

      {/* PAID-SERVICE ALERT — loud when a data provider runs dry/low, so we never
          silently degrade to Google-estimates again. */}
      {data?.serviceHealth && (data.serviceHealth.anyDry || data.serviceHealth.anyLow) && (
        <div className={cn(
          "flex flex-wrap items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]",
          data.serviceHealth.anyDry ? "border-danger/30 bg-danger-tint text-danger" : "border-warn/30 bg-warn-tint text-warn-strong",
        )}>
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold">
              {data.serviceHealth.anyDry ? "A paid data service is OUT OF CREDITS — cost results are degrading to estimates." : "A paid data service is running low."}
            </div>
            <div className="mt-0.5 text-ink-2">
              {data.serviceHealth.services.filter((s) => s.status === "dry" || s.status === "low").map((s) => (
                <span key={s.key} className="mr-3 inline-block">
                  <b>{s.name}</b>: {s.status === "dry" ? "0 credits" : `${fmt(s.remaining ?? 0)} left`}{s.note ? ` — ${s.note}` : ""}
                </span>
              ))}
              <span className="text-ink-3">Top up to restore Target/Sam's/Costco/Publix sourcing; until then items fall to Google (flagged).</span>
            </div>
          </div>
        </div>
      )}

      {/* HERO — overall COGS coverage of the live catalog */}
      <HeroGreenCard>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <HeroLabel>Cost coverage</HeroLabel>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular text-white">{coverage}%</span>
              <span className="text-[13px] text-white/70">{fmt(s?.costedPublished ?? 0)} of {fmt(s?.walmartPublished ?? 0)} live listings have a true cost</span>
            </div>
            <div className="mt-2 h-2 w-full max-w-md overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-white" style={{ width: `${Math.min(100, coverage)}%` }} />
            </div>
            <p className="mt-2 text-[12.5px] leading-snug text-white/80">
              The background crons grind through the catalog hourly (~2 weeks to full). This page updates as they go.
            </p>
          </div>
        </div>
      </HeroGreenCard>

      {/* KPIs — clickable into the detail catalogs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Live listings" value={fmt(s?.walmartPublished ?? 0)} icon={<Boxes size={15} />} href="/cogs" />
        <KpiCard label="Cost obtained" value={fmt(s?.costedTotal ?? 0)} icon={<DollarSign size={15} />} href="/cogs" />
        <KpiCard label="Enriched (donor)" value={fmt(s?.donorProducts ?? 0)} icon={<Database size={15} />} href="/reference-catalog" />
        <KpiCard label="Needs review" value={fmt(s?.needsReview ?? 0)} icon={<AlertTriangle size={15} />} iconVariant={(s?.needsReview ?? 0) > 0 ? "warn" : "default"} href="/cogs?review=1" />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-tint px-3 py-2 text-[13px] text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" /><div>{error}</div>
        </div>
      )}

      {/* Progress over time */}
      <div className="grid gap-3 md:grid-cols-2">
        <Panel>
          <PanelHeader title="Cost collection over time" right={<span className="text-[11.5px] text-ink-3">{fmt(s?.costedTotal ?? 0)} costed</span>} />
          <PanelBody>
            {series.length > 1 ? (
              <div className="flex h-32 items-end gap-[3px]">
                {series.map((p, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center justify-end" title={`${new Date(p.capturedAt).toLocaleString()}: ${fmt(p.costedTotal)} costed`}>
                    <div className="w-full rounded-t bg-green" style={{ height: `${Math.max(2, (p.costedTotal / chartMax) * 112)}px` }} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-10 text-center text-[12.5px] text-ink-3">Graph builds up hourly — check back soon.</div>
            )}
            <div className="mt-2 text-[11.5px] text-ink-3">SKUs with a true cost, captured hourly.</div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Catalog enrichment over time" right={<span className="text-[11.5px] text-ink-3">{fmt(s?.donorProducts ?? 0)} products</span>} />
          <PanelBody>
            {series.length > 1 ? (
              <div className="flex h-32 items-end gap-[3px]">
                {series.map((p, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center justify-end" title={`${new Date(p.capturedAt).toLocaleString()}: ${fmt(p.donorProducts)} donor products`}>
                    <div className="w-full rounded-t bg-info" style={{ height: `${Math.max(2, (p.donorProducts / donorMax) * 112)}px` }} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-10 text-center text-[12.5px] text-ink-3">Graph builds up hourly — check back soon.</div>
            )}
            <div className="mt-2 text-[11.5px] text-ink-3">Reference/Donor products harvested (content for listings).</div>
          </PanelBody>
        </Panel>
      </div>

      {/* Quality split + method mix */}
      <Panel>
        <PanelHeader title="Cost quality" count={s?.costedTotal ?? 0} />
        <PanelBody>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <QualityStat label="Confident" value={good} hint="own-brand + clean 1P" tone="ok" icon={<CheckCircle2 size={14} />} />
            <QualityStat label="Estimate" value={estimate} hint="line-price + Google" tone="warn" icon={<AlertTriangle size={14} />} />
            <QualityStat label="Own-brand" value={s?.ownBrand ?? 0} hint="our products" tone="ok" />
            <QualityStat label="With breakdown" value={s?.withBom ?? 0} hint="bill-of-materials" tone="plain" />
          </div>
        </PanelBody>
      </Panel>

      {/* The two catalogs */}
      <div className="grid gap-3 md:grid-cols-2">
        <CatalogCard href="/cogs" title="SKU Cost Catalog" desc="True landed cost per listing — for economics &amp; pricing."
          lines={[`${fmt(s?.costedTotal ?? 0)} SKUs costed`, `${coverage}% of live listings`, `${fmt(s?.needsReview ?? 0)} need review`]} icon={<DollarSign size={16} />} />
        <CatalogCard href="/reference-catalog" title="Reference / Donor Catalog" desc="Product content — for creating &amp; improving listings."
          lines={[`${fmt(s?.donorProducts ?? 0)} products`, `${fmt(s?.donorOffers ?? 0)} retailer offers`, `${fmt(s?.withBom ?? 0)} SKUs mapped to components`]} icon={<Database size={16} />} />
      </div>
    </div>
  );
}

function QualityStat({ label, value, hint, tone, icon }: { label: string; value: number; hint: string; tone: "ok" | "warn" | "plain"; icon?: React.ReactNode }) {
  const toneCls = tone === "ok" ? "text-green-ink" : tone === "warn" ? "text-warn-strong" : "text-ink";
  return (
    <div className="rounded-lg border border-rule bg-surface px-3 py-2.5">
      <div className={cn("flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide", toneCls)}>{icon}{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular text-ink">{fmt(value)}</div>
      <div className="text-[11px] text-ink-4">{hint}</div>
    </div>
  );
}

function CatalogCard({ href, title, desc, lines, icon }: { href: string; title: string; desc: string; lines: string[]; icon: React.ReactNode }) {
  return (
    <a href={href} className="group block rounded-xl border border-rule bg-surface p-4 transition hover:border-green hover:bg-bg-elev/40">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-soft text-green-ink">{icon}</span>
          <div>
            <div className="text-[14px] font-semibold text-ink">{title}</div>
            <div className="text-[12px] text-ink-3">{desc}</div>
          </div>
        </div>
        <ChevronRight size={16} className="text-ink-4 transition group-hover:translate-x-0.5 group-hover:text-green" />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
        {lines.map((l, i) => <span key={i} className="tabular">{l}</span>)}
      </div>
    </a>
  );
}
