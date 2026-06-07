"use client";

/**
 * Walmart Growth — Listing Quality dashboard.
 *
 * Reads the nightly Insights mirror via /api/walmart/growth/listing-quality:
 *   - the seller-level score + 6 component gauges (the "Grow Sales" headline)
 *   - lever rollup cards (traffic-no-conversion, out of stock, no reviews, …)
 *   - a per-SKU worklist with the exact issues Walmart wants fixed.
 *
 * "Sync now" advances the resumable sweep (POST .../sync) and re-fetches.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { PageHead, Btn, Panel, PanelHeader, KpiCard, RiskPill } from "@/components/kit";
import { cn } from "@/lib/utils";

// ── Types mirroring the GET route payload ──
interface LqIssue {
  component: string;
  componentLabel: string;
  impact: "HIGH" | "MEDIUM" | "LOW" | "ZERO";
  title: string;
  detail?: string;
}
interface LqItemDto {
  sku: string;
  itemId: string | null;
  productName: string | null;
  productType: string | null;
  categoryName: string | null;
  lqScore: number | null;
  priority: string | null;
  components: Record<string, number | null>;
  isInStock: boolean;
  isFastAndFreeShipping: boolean;
  wfsEnabled: boolean;
  ratingCount: number | null;
  pageViews30d: number | null;
  conversionRate30d: number | null;
  gmv30d: number | null;
  orders30d: number | null;
  units30d: number | null;
  topFixComponent: string | null;
  issueCount: number;
  issues: LqIssue[];
  scoredAt: string | null;
}
interface LqResponse {
  seller: {
    listingQuality: number;
    offerScore: number | null;
    ratingReviewScore: number | null;
    contentScore: number | null;
    priceScore: number | null;
    shippingScore: number | null;
    transactibilityScore: number | null;
    capturedAt: string;
    delta: number | null;
  } | null;
  sweepState: {
    inProgress: boolean;
    pagesThisSweep: number;
    itemsThisSweep: number;
    lastFullSweepAt: string | null;
  };
  rollup: {
    totalItems: number;
    outOfStock: number;
    noFastShip: number;
    noReviews: number;
    withTraffic: number;
    trafficNoConversion: number;
    byPriority: { high: number; medium: number; low: number };
    avgScore: number | null;
  };
  worklist: { total: number; limit: number; offset: number; items: LqItemDto[] };
}

type FilterId =
  | "all"
  | "trafficNoConversion"
  | "outOfStock"
  | "noReviews"
  | "noFastShip"
  | "inStockHasTraffic";
type SortId = "traffic" | "score" | "priority" | "gmv";

const COMPONENTS: Array<{ key: string; label: string }> = [
  { key: "contentScore", label: "Content" },
  { key: "transactibilityScore", label: "Published & in stock" },
  { key: "priceScore", label: "Price" },
  { key: "offerScore", label: "Offer" },
  { key: "ratingReviewScore", label: "Ratings & reviews" },
  { key: "shippingScore", label: "Shipping speed" },
];

function scoreTone(s: number | null | undefined): { color: string; bg: string } {
  if (s == null) return { color: "var(--ink-3)", bg: "var(--bg-elev)" };
  if (s >= 70) return { color: "var(--green-ink)", bg: "var(--green-soft)" };
  if (s >= 40) return { color: "var(--warn-strong)", bg: "var(--warn-tint)" };
  return { color: "var(--danger)", bg: "var(--danger-tint)" };
}

function ScoreGauge({ label, score }: { label: string; score: number | null }) {
  const tone = scoreTone(score);
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className="rounded-lg border border-rule bg-surface p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-ink-3">
          {label}
        </span>
        <span className="text-[15px] font-semibold tabular" style={{ color: tone.color }}>
          {score == null ? "—" : score.toFixed(0)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-elev">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone.color }} />
      </div>
    </div>
  );
}

function pct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}

export function ListingQualityDashboard() {
  const [data, setData] = useState<LqResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>("trafficNoConversion");
  const [sort, setSort] = useState<SortId>("traffic");
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ filter, sort, limit: "60" });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/walmart/growth/listing-quality?${params}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [filter, sort, q]);

  useEffect(() => {
    load();
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    setSyncMsg("Pulling Listing Quality from Walmart…");
    try {
      const res = await fetch("/api/walmart/growth/listing-quality/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxPages: 6, budgetMs: 90_000 }),
      });
      const j = await res.json();
      if (j.ok) {
        setSyncMsg(
          j.sweepComplete
            ? `Full sweep done · ${j.itemsThisSweep} items`
            : `Synced ${j.itemsThisSweep} items so far (sweep continues in background)`
        );
      } else {
        setSyncMsg(`Sync error: ${j.error ?? "unknown"}`);
      }
      await load();
    } catch (e) {
      setSyncMsg(`Sync failed: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 6000);
    }
  }

  function toggle(sku: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  const seller = data?.seller;
  const rollup = data?.rollup;
  const sweep = data?.sweepState;
  const hasData = Boolean(seller || (rollup && rollup.totalItems > 0));

  const filterTabs: Array<{ id: FilterId; label: string; count?: number }> = [
    { id: "trafficNoConversion", label: "Traffic · no sale", count: rollup?.trafficNoConversion },
    { id: "outOfStock", label: "Out of stock", count: rollup?.outOfStock },
    { id: "noReviews", label: "No reviews", count: rollup?.noReviews },
    { id: "noFastShip", label: "No fast shipping", count: rollup?.noFastShip },
    { id: "inStockHasTraffic", label: "In stock + traffic", count: rollup?.withTraffic },
    { id: "all", label: "All items", count: rollup?.totalItems },
  ];

  return (
    <div className="space-y-5">
      <PageHead
        title="Walmart Growth"
        subtitle={
          <>
            <span>Listing Quality · the levers that move search rank, Buy Box &amp; Pro Seller</span>
            {sweep?.lastFullSweepAt && (
              <span className="text-ink-4">
                · last full sweep {new Date(sweep.lastFullSweepAt).toLocaleString()}
              </span>
            )}
            {sweep?.inProgress && (
              <span className="text-warn-strong">· sweep in progress ({sweep.itemsThisSweep} items)</span>
            )}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {syncMsg && <span className="text-[11px] text-ink-3">{syncMsg}</span>}
            <Btn icon={<RefreshCw size={13} />} onClick={syncNow} loading={syncing}>
              {syncing ? "Syncing…" : "Sync now"}
            </Btn>
          </div>
        }
      />

      {!hasData && !loading ? (
        <Panel>
          <div className="p-8 text-center text-[13px] text-ink-3">
            No Listing Quality data yet. Click <strong>Sync now</strong> to pull it from Walmart.
            <div className="mt-1 text-[11.5px] text-ink-4">
              The full catalog (~4,000 items) syncs across a few passes due to Walmart&apos;s rate limits.
            </div>
          </div>
        </Panel>
      ) : (
        <>
          {/* ── Score hero ── */}
          <Panel>
            <div className="grid gap-4 p-4 md:grid-cols-[220px_1fr]">
              <div className="flex flex-col justify-center rounded-lg border border-rule bg-green-soft p-4">
                <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-green-ink/70">
                  Listing Quality
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-[40px] font-semibold leading-none text-green-ink tabular">
                    {seller ? seller.listingQuality.toFixed(0) : "—"}
                  </span>
                  <span className="text-[15px] text-green-ink/60">/100</span>
                </div>
                {seller?.delta != null && seller.delta !== 0 && (
                  <div className={cn("mt-1.5 text-[12px] font-medium tabular", seller.delta > 0 ? "text-green" : "text-warn")}>
                    {seller.delta > 0 ? "↑" : "↓"} {Math.abs(seller.delta).toFixed(1)} since last sync
                  </div>
                )}
                {rollup?.avgScore != null && (
                  <div className="mt-1 text-[11.5px] text-green-ink/60 tabular">
                    avg item score {rollup.avgScore.toFixed(0)}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {COMPONENTS.map((c) => (
                  <ScoreGauge
                    key={c.key}
                    label={c.label}
                    score={seller ? (seller[c.key as keyof typeof seller] as number | null) : null}
                  />
                ))}
              </div>
            </div>
          </Panel>

          {/* ── Lever rollup ── */}
          {rollup && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard
                label="Traffic · no sale"
                value={rollup.trafficNoConversion}
                iconVariant="danger"
                active={filter === "trafficNoConversion"}
                onClick={() => setFilter("trafficNoConversion")}
              />
              <KpiCard
                label="Out of stock"
                value={rollup.outOfStock}
                iconVariant="warn"
                active={filter === "outOfStock"}
                onClick={() => setFilter("outOfStock")}
              />
              <KpiCard
                label="No reviews"
                value={rollup.noReviews}
                iconVariant="warn"
                active={filter === "noReviews"}
                onClick={() => setFilter("noReviews")}
              />
              <KpiCard
                label="No fast shipping"
                value={rollup.noFastShip}
                iconVariant="warn"
                active={filter === "noFastShip"}
                onClick={() => setFilter("noFastShip")}
              />
            </div>
          )}

          {/* ── Worklist ── */}
          <Panel>
            <PanelHeader
              title="Worklist"
              count={data?.worklist.total}
              right={
                <div className="flex items-center gap-2">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search product / SKU…"
                    className="h-7 w-44 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink placeholder:text-ink-4 focus:border-green-mid focus:outline-none"
                  />
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortId)}
                    className="h-7 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink-2 focus:outline-none"
                  >
                    <option value="traffic">Sort: traffic</option>
                    <option value="score">Sort: lowest score</option>
                    <option value="gmv">Sort: GMV</option>
                    <option value="priority">Sort: priority</option>
                  </select>
                </div>
              }
            />
            {/* Filter chips */}
            <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-3 py-2">
              {filterTabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setFilter(t.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                    filter === t.id
                      ? "bg-green-soft text-green-ink"
                      : "text-ink-2 hover:bg-bg-elev hover:text-ink"
                  )}
                >
                  {t.label}
                  {t.count !== undefined && (
                    <span
                      className={cn(
                        "inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular",
                        filter === t.id ? "bg-green text-green-cream" : "bg-bg-elev text-ink-3"
                      )}
                    >
                      {t.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-rule text-left text-[10.5px] font-mono uppercase tracking-wider text-ink-3">
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-2 py-2 font-medium">LQ</th>
                    <th className="px-2 py-2 font-medium">Priority</th>
                    <th className="px-2 py-2 text-right font-medium">30d views</th>
                    <th className="px-2 py-2 text-right font-medium">Conv.</th>
                    <th className="px-2 py-2 font-medium">Stock</th>
                    <th className="px-2 py-2 font-medium">Top fix</th>
                    <th className="px-2 py-2 text-right font-medium">Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && !data ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-ink-3">
                        Loading…
                      </td>
                    </tr>
                  ) : data && data.worklist.items.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-ink-3">
                        No items match this filter.
                      </td>
                    </tr>
                  ) : (
                    data?.worklist.items.map((it) => {
                      const isOpen = expanded.has(it.sku);
                      const tone = scoreTone(it.lqScore);
                      return (
                        <FragmentRow
                          key={it.sku}
                          it={it}
                          isOpen={isOpen}
                          tone={tone}
                          onToggle={() => toggle(it.sku)}
                        />
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            {data && data.worklist.total > data.worklist.items.length && (
              <div className="border-t border-rule px-3 py-2 text-center text-[11.5px] text-ink-3">
                Showing {data.worklist.items.length} of {data.worklist.total} — refine with filters/search.
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function FragmentRow({
  it,
  isOpen,
  tone,
  onToggle,
}: {
  it: LqItemDto;
  isOpen: boolean;
  tone: { color: string; bg: string };
  onToggle: () => void;
}) {
  const itemUrl = it.itemId ? `https://www.walmart.com/ip/${it.itemId}` : null;
  return (
    <>
      <tr className="border-b border-rule/60 hover:bg-bg-elev/40">
        <td className="max-w-[320px] px-3 py-2">
          <button type="button" onClick={onToggle} className="flex items-start gap-1.5 text-left">
            {isOpen ? <ChevronDown size={13} className="mt-0.5 shrink-0 text-ink-3" /> : <ChevronRight size={13} className="mt-0.5 shrink-0 text-ink-3" />}
            <span>
              <span className="block truncate text-ink">{it.productName ?? it.sku}</span>
              <span className="block text-[11px] text-ink-4">
                {it.sku}
                {it.productType ? ` · ${it.productType}` : ""}
              </span>
            </span>
          </button>
        </td>
        <td className="px-2 py-2">
          <span className="inline-flex h-5 min-w-[28px] items-center justify-center rounded px-1.5 text-[11px] font-semibold tabular" style={{ background: tone.bg, color: tone.color }}>
            {it.lqScore == null ? "—" : it.lqScore.toFixed(0)}
          </span>
        </td>
        <td className="px-2 py-2">
          {it.priority ? <RiskPill level={it.priority === "MEDIUM" ? "medium" : it.priority === "HIGH" ? "high" : "low"}>{it.priority}</RiskPill> : <span className="text-ink-4">—</span>}
        </td>
        <td className="px-2 py-2 text-right tabular text-ink-2">{it.pageViews30d ?? 0}</td>
        <td className="px-2 py-2 text-right tabular">
          <span className={cn(it.pageViews30d && !it.conversionRate30d ? "text-danger" : "text-ink-2")}>
            {pct(it.conversionRate30d)}
          </span>
        </td>
        <td className="px-2 py-2">
          {it.isInStock ? (
            <span className="text-[11px] text-green-ink">In stock</span>
          ) : (
            <span className="text-[11px] text-warn-strong">Out</span>
          )}
        </td>
        <td className="px-2 py-2 text-ink-2">{it.topFixComponent ?? "—"}</td>
        <td className="px-2 py-2 text-right tabular text-ink-3">{it.issueCount}</td>
      </tr>
      {isOpen && (
        <tr className="border-b border-rule/60 bg-bg-elev/30">
          <td colSpan={8} className="px-3 py-3">
            <div className="flex flex-wrap items-center gap-3 pb-2 text-[11.5px] text-ink-3">
              {itemUrl && (
                <a href={itemUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-green hover:text-green-deep">
                  View on Walmart <ExternalLink size={11} />
                </a>
              )}
              <span>Reviews: {it.ratingCount ?? 0}</span>
              <span>Fast&amp;free ship: {it.isFastAndFreeShipping ? "yes" : "no"}</span>
              <span>WFS: {it.wfsEnabled ? "yes" : "no"}</span>
              <span>30d GMV: ${it.gmv30d ?? 0}</span>
              <span>30d orders: {it.orders30d ?? 0}</span>
            </div>
            <div className="space-y-1">
              {it.issues.length === 0 ? (
                <div className="text-[12px] text-ink-3">No specific issues recorded.</div>
              ) : (
                it.issues.map((iss, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px]">
                    <RiskPill level={iss.impact === "HIGH" ? "high" : iss.impact === "MEDIUM" ? "medium" : "low"} uppercase>
                      {iss.impact}
                    </RiskPill>
                    <span className="text-ink-2">
                      <span className="font-medium text-ink">{iss.componentLabel}:</span> {iss.title}
                      {iss.detail && <span className="text-ink-3"> — {iss.detail}</span>}
                    </span>
                  </div>
                ))
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
