"use client";

/**
 * Amazon Growth — Listing Health dashboard.
 *
 * Reads the DB mirror via /api/amazon/growth/listing-health:
 *   - the COMPUTED seller-level health score + component gauges (the headline)
 *   - lever rollup cards (suppressed, has-errors, not-buyable, low-score)
 *   - a per-SKU worklist with the exact Amazon issues to fix
 *
 * Amazon has no native quality score — this score is ours (see
 * docs/wiki/amazon-growth-roadmap.md). "Sync now" advances the resumable sweep.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink, Sparkles, Wrench, Hand, Lock } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard, RiskPill } from "@/components/kit";
import { cn } from "@/lib/utils";

// ── Types mirroring the GET route payload ──
interface HealthIssue {
  code: string;
  message: string;
  severity: string;
  attributeNames: string[];
  categories: string[];
}
interface HealthItemDto {
  sku: string;
  asin: string | null;
  itemName: string | null;
  productType: string | null;
  mainImageUrl: string | null;
  healthScore: number | null;
  topFixComponent: string | null;
  components: Record<string, number | null>;
  isBuyable: boolean;
  isDiscoverable: boolean;
  isSuppressed: boolean;
  errorIssueCount: number;
  warningIssueCount: number;
  issues: HealthIssue[];
  suppressionReason: string | null;
  opportunityScore: number | null;
  impressions30d: number | null;
  clicks30d: number | null;
  ctr: number | null;
  sessions30d: number | null;
  pageViews30d: number | null;
  cartAddRate: number | null;
  unitsOrdered30d: number | null;
  unitSessionPct: number | null;
  purchaseRate: number | null;
  buyBoxPercentage: number | null;
  revenue30d: number | null;
  returns30d: number | null;
  returnRate: number | null;
  lastUpdatedAt: string | null;
}
interface HealthResponse {
  seller: {
    healthScore: number;
    buyabilityScore: number | null;
    issuesScore: number | null;
    contentScore: number | null;
    complianceScore: number | null;
    buyBoxScore: number | null;
    conversionScore: number | null;
    totalListings: number;
    suppressedCount: number;
    errorIssueCount: number;
    warningIssueCount: number;
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
    suppressed: number;
    hasErrors: number;
    notBuyable: number;
    lowScore: number;
    byTopFix: { buyability: number; issues: number; compliance: number };
    avgScore: number | null;
  };
  worklist: { total: number; limit: number; offset: number; items: HealthItemDto[] };
}

type FilterId = "all" | "suppressed" | "hasErrors" | "lowScore" | "notBuyable";
type SortId = "opportunity" | "revenue" | "score" | "issues" | "recent";

// Component gauges — Phase A fills buyability/issues/compliance; the others
// light up once the report cron (Phase B) enriches them.
const COMPONENTS: Array<{ key: string; label: string }> = [
  { key: "buyabilityScore", label: "Buyability" },
  { key: "issuesScore", label: "Issues" },
  { key: "complianceScore", label: "Compliance" },
  { key: "contentScore", label: "Content" },
  { key: "buyBoxScore", label: "Buy Box" },
  { key: "conversionScore", label: "Conversion" },
];

function scoreTone(s: number | null | undefined): { color: string; bg: string } {
  if (s == null) return { color: "var(--ink-3)", bg: "var(--bg-elev)" };
  if (s >= 70) return { color: "var(--green-ink)", bg: "var(--green-soft)" };
  if (s >= 40) return { color: "var(--warn-strong)", bg: "var(--warn-tint)" };
  return { color: "var(--danger)", bg: "var(--danger-tint)" };
}

function ScoreGauge({ label, score }: { label: string; score: number | null }) {
  const tone = scoreTone(score);
  const p = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className="rounded-lg border border-rule bg-surface p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-ink-3">{label}</span>
        <span className="text-[15px] font-semibold tabular" style={{ color: tone.color }}>
          {score == null ? "—" : score.toFixed(0)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-elev">
        <div className="h-full rounded-full" style={{ width: `${p}%`, background: tone.color }} />
      </div>
    </div>
  );
}

export function ListingHealthDashboard({
  storeIndex,
  filter: filterProp,
  onFilterChange,
}: {
  storeIndex: number;
  /** When provided, the filter is controlled by the parent (Action Center jumps). */
  filter?: FilterId;
  onFilterChange?: (f: FilterId) => void;
}) {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  // Default to the backlog that has real Phase-A signal. Authoritative
  // suppression comes from the FYP report (Phase B); status-derived
  // `isSuppressed` undercounts, so "Has errors" is the better landing filter.
  const [internalFilter, setInternalFilter] = useState<FilterId>("hasErrors");
  const filter = filterProp ?? internalFilter;
  const setFilter = (f: FilterId) => (onFilterChange ? onFilterChange(f) : setInternalFilter(f));
  const [sort, setSort] = useState<SortId>("opportunity");
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort, filter, limit: "60", storeIndex: String(storeIndex) });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/amazon/growth/listing-health?${params}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [filter, sort, q, storeIndex]);

  useEffect(() => {
    load();
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    setSyncMsg("Pulling listings from Amazon…");
    try {
      const res = await fetch("/api/amazon/growth/listing-health/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeIndex }),
      });
      const j = await res.json();
      if (j.ok) {
        setSyncMsg(
          j.sweepComplete
            ? `Full sweep done · ${j.itemsThisSweep} listings`
            : `Synced ${j.itemsThisSweep} so far (sweep continues)`,
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
    { id: "suppressed", label: "Suppressed", count: rollup?.suppressed },
    { id: "hasErrors", label: "Has errors", count: rollup?.hasErrors },
    { id: "notBuyable", label: "Not buyable", count: rollup?.notBuyable },
    { id: "lowScore", label: "Low score", count: rollup?.lowScore },
    { id: "all", label: "All listings", count: rollup?.totalItems },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
          <span>Computed health — Amazon has no native quality score</span>
          {sweep?.lastFullSweepAt && (
            <span className="text-ink-4">· last full sweep {new Date(sweep.lastFullSweepAt).toLocaleString()}</span>
          )}
          {sweep?.inProgress && (
            <span className="text-warn-strong">· sweep in progress ({sweep.itemsThisSweep} listings)</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {syncMsg && <span className="text-[11px] text-ink-3">{syncMsg}</span>}
          <Btn icon={<RefreshCw size={13} />} onClick={syncNow} loading={syncing}>
            {syncing ? "Syncing…" : "Sync now"}
          </Btn>
        </div>
      </div>

      {!hasData && !loading ? (
        <Panel>
          <div className="p-8 text-center text-[13px] text-ink-3">
            No Listing Health data yet. Click <strong>Sync now</strong> to pull listings from Amazon.
            <div className="mt-1 text-[11.5px] text-ink-4">
              The score is computed from listing status, issues and brand-voice; conversion &amp; Buy
              Box arrive once the report sync runs.
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
                  Listing Health
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-[40px] font-semibold leading-none text-green-ink tabular">
                    {seller ? seller.healthScore.toFixed(0) : "—"}
                  </span>
                  <span className="text-[15px] text-green-ink/60">/100</span>
                </div>
                {seller?.delta != null && seller.delta !== 0 && (
                  <div className={cn("mt-1.5 text-[12px] font-medium tabular", seller.delta > 0 ? "text-green" : "text-warn")}>
                    {seller.delta > 0 ? "↑" : "↓"} {Math.abs(seller.delta).toFixed(1)} since last sweep
                  </div>
                )}
                {seller && (
                  <div className="mt-1 text-[11.5px] text-green-ink/60 tabular">
                    {seller.totalListings} listings · {seller.suppressedCount} suppressed
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
                label="Suppressed"
                value={rollup.suppressed}
                iconVariant="danger"
                active={filter === "suppressed"}
                onClick={() => setFilter("suppressed")}
              />
              <KpiCard
                label="Has errors"
                value={rollup.hasErrors}
                iconVariant="warn"
                active={filter === "hasErrors"}
                onClick={() => setFilter("hasErrors")}
              />
              <KpiCard
                label="Not buyable"
                value={rollup.notBuyable}
                iconVariant="warn"
                active={filter === "notBuyable"}
                onClick={() => setFilter("notBuyable")}
              />
              <KpiCard
                label="Low score (<70)"
                value={rollup.lowScore}
                iconVariant="warn"
                active={filter === "lowScore"}
                onClick={() => setFilter("lowScore")}
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
                    placeholder="Search product / SKU / ASIN…"
                    className="h-7 w-44 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink placeholder:text-ink-4 focus:border-green-mid focus:outline-none"
                  />
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortId)}
                    className="h-7 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink-2 focus:outline-none"
                  >
                    <option value="opportunity">Sort: opportunity</option>
                    <option value="revenue">Sort: revenue</option>
                    <option value="score">Sort: lowest score</option>
                    <option value="issues">Sort: most errors</option>
                    <option value="recent">Sort: recently changed</option>
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
                    filter === t.id ? "bg-green-soft text-green-ink" : "text-ink-2 hover:bg-bg-elev hover:text-ink",
                  )}
                >
                  {t.label}
                  {t.count !== undefined && (
                    <span
                      className={cn(
                        "inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular",
                        filter === t.id ? "bg-green text-green-cream" : "bg-bg-elev text-ink-3",
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
                    <th className="px-2 py-2 text-right font-medium">Opp.</th>
                    <th className="px-2 py-2 text-right font-medium">Conv.</th>
                    <th className="px-2 py-2 font-medium">Health</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 text-right font-medium">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && !data ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-ink-3">Loading…</td>
                    </tr>
                  ) : data && data.worklist.items.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-ink-3">No listings match this filter.</td>
                    </tr>
                  ) : (
                    data?.worklist.items.map((it) => (
                      <HealthRow key={it.sku} it={it} storeIndex={storeIndex} isOpen={expanded.has(it.sku)} onToggle={() => toggle(it.sku)} />
                    ))
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

interface AdviceAction {
  title: string;
  lever: string;
  rationale: string;
  impact: "high" | "medium" | "low";
  effort: "low" | "medium" | "high";
  kind: "auto" | "semi" | "manual";
  execution: { mode: "optimizer" | "set-attribute" | "manual"; attribute?: string; suggestedValue?: string };
}
interface AdvicePlan {
  diagnosis: string;
  rootCause: string;
  actions: AdviceAction[];
  expectedOutcome: string;
  confidence: string;
}

function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}
function num(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}
function oppTone(s: number | null): { color: string; bg: string } {
  if (s == null) return { color: "var(--ink-3)", bg: "var(--bg-elev)" };
  if (s >= 60) return { color: "var(--danger)", bg: "var(--danger-tint)" };
  if (s >= 30) return { color: "var(--warn-strong)", bg: "var(--warn-tint)" };
  return { color: "var(--ink-3)", bg: "var(--bg-elev)" };
}
const KIND_ICON = { auto: Wrench, semi: Wrench, manual: Hand } as const;

function HealthRow({
  it,
  storeIndex,
  isOpen,
  onToggle,
}: {
  it: HealthItemDto;
  storeIndex: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const tone = scoreTone(it.healthScore);
  const opp = oppTone(it.opportunityScore);
  const asinUrl = it.asin ? `https://www.amazon.com/dp/${it.asin}` : null;
  const [advice, setAdvice] = useState<AdvicePlan | null>(null);
  const [advising, setAdvising] = useState(false);
  const [adviceErr, setAdviceErr] = useState<string | null>(null);
  const [applyBusy, setApplyBusy] = useState<number | null>(null);
  const [applyMsg, setApplyMsg] = useState<Record<number, string>>({});

  // optimizer-mode actions (deterministic dedupe + brand-voice scrub).
  async function applyOptimizer(idx: number) {
    setApplyBusy(idx);
    setApplyMsg((m) => ({ ...m, [idx]: "" }));
    try {
      const res = await fetch("/api/amazon/growth/advisor/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeIndex, sku: it.sku, mode: "optimizer" }),
      });
      const j = await res.json();
      let msg: string;
      if (!j.ok) msg = `Error: ${j.error}`;
      else {
        const r = j.result;
        if (r.applied) msg = "Applied to Amazon ✓";
        else if (r.skipped) msg = `Nothing to change (${r.skipped})`;
        else if (r.status === "INVALID") msg = `Amazon rejected: ${r.issues?.[0]?.message ?? "invalid"}`;
        else msg = `Status: ${r.status ?? r.error ?? "?"}`;
      }
      setApplyMsg((m) => ({ ...m, [idx]: msg }));
    } catch (e) {
      setApplyMsg((m) => ({ ...m, [idx]: `Failed: ${(e as Error).message}` }));
    } finally {
      setApplyBusy(null);
    }
  }

  async function advise() {
    setAdvising(true);
    setAdviceErr(null);
    try {
      const res = await fetch("/api/amazon/growth/advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeIndex, sku: it.sku }),
      });
      const j = await res.json();
      if (j.ok) setAdvice(j.plan);
      else setAdviceErr(j.error ?? "advisor failed");
    } catch (e) {
      setAdviceErr((e as Error).message);
    } finally {
      setAdvising(false);
    }
  }

  return (
    <>
      <tr className="border-b border-rule/60 hover:bg-bg-elev/40">
        <td className="max-w-[340px] px-3 py-2">
          <button type="button" onClick={onToggle} className="flex items-start gap-1.5 text-left">
            {isOpen ? (
              <ChevronDown size={13} className="mt-0.5 shrink-0 text-ink-3" />
            ) : (
              <ChevronRight size={13} className="mt-0.5 shrink-0 text-ink-3" />
            )}
            <span>
              <span className="block truncate text-ink">{it.itemName ?? it.sku}</span>
              <span className="block text-[11px] text-ink-4">
                {it.sku}
                {it.asin ? ` · ${it.asin}` : ""}
                {it.revenue30d != null && it.revenue30d > 0 ? ` · $${it.revenue30d.toFixed(0)}/30d` : ""}
              </span>
            </span>
          </button>
        </td>
        <td className="px-2 py-2 text-right">
          <span
            className="inline-flex h-5 min-w-[28px] items-center justify-center rounded px-1.5 text-[11px] font-semibold tabular"
            style={{ background: opp.bg, color: opp.color }}
          >
            {it.opportunityScore == null ? "—" : it.opportunityScore.toFixed(0)}
          </span>
        </td>
        <td className="px-2 py-2 text-right tabular">
          <span className={cn(it.sessions30d && !it.unitsOrdered30d ? "text-danger" : "text-ink-2")}>
            {pct(it.unitSessionPct)}
          </span>
        </td>
        <td className="px-2 py-2">
          <span
            className="inline-flex h-5 min-w-[28px] items-center justify-center rounded px-1.5 text-[11px] font-semibold tabular"
            style={{ background: tone.bg, color: tone.color }}
          >
            {it.healthScore == null ? "—" : it.healthScore.toFixed(0)}
          </span>
        </td>
        <td className="px-2 py-2">
          {it.isSuppressed ? (
            <RiskPill level="high" uppercase>Suppressed</RiskPill>
          ) : it.isBuyable ? (
            <span className="text-[11px] text-green-ink">Live</span>
          ) : (
            <span className="text-[11px] text-warn-strong">Inactive</span>
          )}
        </td>
        <td className="px-2 py-2 text-right tabular">
          <span className={cn(it.errorIssueCount > 0 ? "text-danger" : "text-ink-3")}>{it.errorIssueCount}</span>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-rule/60 bg-bg-elev/30">
          <td colSpan={6} className="px-3 py-3">
            {/* Productivity funnel */}
            <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-ink-3 sm:grid-cols-4 lg:grid-cols-7">
              <Metric label="Impressions" value={num(it.impressions30d)} />
              <Metric label="CTR" value={pct(it.ctr)} />
              <Metric label="Sessions" value={num(it.sessions30d)} />
              <Metric label="Cart-add" value={pct(it.cartAddRate)} />
              <Metric label="Conversion" value={pct(it.unitSessionPct)} flag={Boolean(it.sessions30d && !it.unitsOrdered30d)} />
              <Metric label="Buy-box" value={it.buyBoxPercentage == null ? "—" : `${it.buyBoxPercentage.toFixed(0)}%`} />
              <Metric label="Return rate" value={pct(it.returnRate)} flag={Boolean(it.returnRate && it.returnRate > 0.1)} />
            </div>
            <div className="flex flex-wrap items-center gap-3 pb-2 text-[11.5px] text-ink-3">
              {asinUrl && (
                <a href={asinUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-green hover:text-green-deep">
                  View on Amazon <ExternalLink size={11} />
                </a>
              )}
              {it.suppressionReason && <span className="text-warn-strong">Suppressed: {it.suppressionReason}</span>}
              <Btn size="sm" variant="primary" icon={<Sparkles size={13} />} onClick={advise} loading={advising}>
                {advice ? "Re-advise" : "AI Advise"}
              </Btn>
              {adviceErr && <span className="text-danger">{adviceErr}</span>}
            </div>

            {/* AI plan */}
            {advice && (
              <div className="mb-2 rounded-lg border border-green-mid/40 bg-green-soft/40 p-3 text-[12px]">
                <p className="text-ink-2"><span className="font-medium text-green-ink">Diagnosis: </span>{advice.diagnosis}</p>
                <p className="mt-1 text-ink-2"><span className="font-medium text-green-ink">Root cause: </span>{advice.rootCause}</p>
                <div className="mt-2 space-y-2">
                  {advice.actions.map((a, i) => {
                    const Icon = KIND_ICON[a.kind] ?? Lock;
                    const mode = a.execution?.mode ?? "manual";
                    return (
                      <div key={i} className="flex items-start gap-2">
                        <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-2 border border-rule">
                          <Icon size={10} />{a.impact}
                        </span>
                        <span className="min-w-0 flex-1 text-ink-2">
                          <span className="font-medium text-ink">{a.title}</span>
                          <span className="ml-1 font-mono text-[10px] text-ink-4">{a.lever} · {a.kind} · effort {a.effort}</span>
                          <span className="block text-ink-3">{a.rationale}</span>
                          {/* Execute */}
                          <span className="mt-1 flex flex-wrap items-center gap-2">
                            {mode === "optimizer" && (
                              <>
                                <Btn size="sm" variant="primary" icon={<Wrench size={12} />} onClick={() => applyOptimizer(i)} loading={applyBusy === i}>
                                  Apply fix
                                </Btn>
                                {applyMsg[i] && (
                                  <span className={cn("text-[11px]", applyMsg[i].startsWith("Applied") ? "text-green-ink" : applyMsg[i].includes("Nothing") ? "text-ink-3" : "text-danger")}>
                                    {applyMsg[i]}
                                  </span>
                                )}
                              </>
                            )}
                            {mode === "set-attribute" && a.execution.attribute && (
                              <SetAttributeControl storeIndex={storeIndex} sku={it.sku} attribute={a.execution.attribute} suggestedValue={a.execution.suggestedValue ?? ""} />
                            )}
                            {mode === "manual" && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-ink-4"><Hand size={10} /> manual / decision</span>
                            )}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11.5px] text-ink-3"><span className="font-medium text-ink-2">Expected: </span>{advice.expectedOutcome} <span className="text-ink-4">· confidence {advice.confidence}</span></p>
              </div>
            )}

            {/* Amazon issues */}
            <div className="space-y-1">
              {it.issues.length === 0 ? (
                <div className="text-[12px] text-ink-3">No issues recorded by Amazon.</div>
              ) : (
                it.issues.map((iss, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px]">
                    <RiskPill level={iss.severity === "ERROR" ? "high" : iss.severity === "WARNING" ? "medium" : "low"} uppercase>
                      {iss.severity}
                    </RiskPill>
                    <span className="text-ink-2">
                      {iss.code && <span className="font-mono text-[11px] text-ink-3">{iss.code} </span>}
                      {iss.message}
                      {iss.attributeNames.length > 0 && (
                        <span className="text-ink-4"> [{iss.attributeNames.join(", ")}]</span>
                      )}
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

interface AttrForm {
  valueField: string | null;
  valueType: "number" | "string" | null;
  enumFields: Array<{ name: string; nested: boolean; allowed: string[] }>;
}

/** Set-attribute control: value input + a dropdown of Amazon's allowed values
 *  per enum sub-field (from Product Type Definitions). Writes a schema-valid PATCH. */
function SetAttributeControl({
  storeIndex,
  sku,
  attribute,
  suggestedValue,
}: {
  storeIndex: number;
  sku: string;
  attribute: string;
  suggestedValue: string;
}) {
  const [form, setForm] = useState<AttrForm | null>(null);
  const [value, setValue] = useState(suggestedValue);
  const [sub, setSub] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/amazon/growth/advisor/attribute-form?storeIndex=${storeIndex}&sku=${encodeURIComponent(sku)}&attribute=${encodeURIComponent(attribute)}`,
        );
        const j = await res.json();
        if (!alive) return;
        if (j.ok) {
          setForm(j.form);
          if (j.current?.value != null) setValue(String(j.current.value));
          const s: Record<string, string> = {};
          for (const ef of j.form.enumFields as AttrForm["enumFields"]) {
            const curr = j.current?.sub?.[ef.name];
            s[ef.name] = curr && ef.allowed.includes(curr) ? curr : ef.allowed.includes("Count") ? "Count" : ef.allowed[0];
          }
          setSub(s);
        } else {
          setMsg(j.error ?? "schema unavailable");
        }
      } catch (e) {
        if (alive) setMsg((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [storeIndex, sku, attribute]);

  async function write() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/amazon/growth/advisor/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeIndex, sku, mode: "set-attribute", attribute, value, subValues: sub }),
      });
      const j = await res.json();
      if (!j.ok) setMsg(`Error: ${j.error}`);
      else {
        const r = j.result;
        setMsg(
          r.applied
            ? "Applied to Amazon ✓"
            : r.status === "INVALID"
              ? `Amazon rejected: ${r.issues?.[0]?.message ?? "invalid"}`
              : `Status: ${r.status ?? "?"}`,
        );
      }
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <span className="text-[11px] text-ink-4">loading {attribute} options…</span>;

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[10px] text-ink-4">{attribute} =</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-6 w-16 rounded border border-rule bg-surface px-1.5 text-[11px] text-ink focus:border-green-mid focus:outline-none"
      />
      {form?.enumFields.map((ef) => (
        <select
          key={ef.name}
          value={sub[ef.name] ?? ""}
          onChange={(e) => setSub((s) => ({ ...s, [ef.name]: e.target.value }))}
          className="h-6 rounded border border-rule bg-surface px-1 text-[11px] text-ink-2 focus:outline-none"
          title={ef.name}
        >
          {ef.allowed.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ))}
      <Btn size="sm" variant="primary" icon={<Wrench size={12} />} onClick={write} loading={busy}>
        Write to Amazon
      </Btn>
      {msg && (
        <span className={cn("text-[11px]", msg.startsWith("Applied") ? "text-green-ink" : "text-danger")}>{msg}</span>
      )}
    </span>
  );
}

function Metric({ label, value, flag }: { label: string; value: string; flag?: boolean }) {
  return (
    <div>
      <div className="text-[9px] font-mono uppercase tracking-wider text-ink-4">{label}</div>
      <div className={cn("tabular text-[12px]", flag ? "text-danger" : "text-ink-2")}>{value}</div>
    </div>
  );
}
