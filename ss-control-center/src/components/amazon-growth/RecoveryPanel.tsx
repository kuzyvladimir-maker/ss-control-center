"use client";

/**
 * Amazon Growth — Recovery & history (experiment engine, Phase 0).
 *
 * Shows the daily-funnel data coverage we've accumulated, snapshot count, and the
 * lost-winner candidates: listings that used to sell and now don't (gone /
 * suppressed / sharply declined). Operator controls: ingest the latest day,
 * snapshot own-brand content, and backfill the trailing 90 days.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { RefreshCw, Download, Camera, History as HistoryIcon, ChevronRight, ChevronDown, Undo2 } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard } from "@/components/kit";
import { cn } from "@/lib/utils";

interface RebuildKit {
  asin: string;
  inMirror: boolean;
  sku: string | null;
  snapshot: { id: string; title: string | null; bullets: string[]; mainImageUrl: string | null; imageCount: number | null; capturedAt: string } | null;
  catalog: { title: string | null; brand: string | null; mainImageUrl: string | null; imageCount: number; bullets: string[] } | null;
  bestSource: "snapshot" | "catalog" | "none";
}

interface LostWinner {
  asin: string; itemName: string | null;
  historicalUnitsPerDay: number; historicalRevenue: number;
  recentUnitsPerDay: number; recentRevenue: number; dropPct: number;
  inMirror: boolean; isBuyable: boolean; isSuppressed: boolean; ownBrand: boolean; needsBrandCheck: boolean;
}
interface HistoryResp {
  coverage: { rows: number; days: number; asins: number; firstDate: string | null; lastDate: string | null };
  snapshots: { count: number; lastAt: string | null };
  lostWinners: LostWinner[];
}

function d(s: string | null) { return s ? new Date(s).toLocaleDateString() : "—"; }

export function RecoveryPanel({ storeIndex }: { storeIndex: number }) {
  const [data, setData] = useState<HistoryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [kit, setKit] = useState<RebuildKit | null>(null);
  const [kitLoading, setKitLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/amazon/growth/history?storeIndex=${storeIndex}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [storeIndex]);
  useEffect(() => { load(); }, [load]);

  async function post(action: string) {
    const res = await fetch("/api/amazon/growth/history", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeIndex, action }),
    });
    return res.json();
  }

  async function ingestLatest() {
    setBusy("ingest"); setMsg(null);
    try { const j = await post("ingestLatest"); setMsg(j.ok ? `Ingested latest day — ${j.written} rows` : `Error: ${j.error}`); await load(); }
    finally { setBusy(null); }
  }
  async function snapshot() {
    setBusy("snapshot"); setMsg(null);
    try { const j = await post("snapshot"); setMsg(j.ok ? `Snapshots: ${j.written} new, ${j.unchanged} unchanged` : `Error: ${j.error}`); await load(); }
    finally { setBusy(null); }
  }
  // Backfill is bounded server-side (6 days/call) — loop until the 90d window is covered.
  async function backfill() {
    setBusy("backfill"); setMsg(null);
    try {
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const j = await post("backfill");
        if (!j.ok) { setMsg(`Error: ${j.error}`); break; }
        total += j.ingested;
        setMsg(`Backfilling… ${total} days so far`);
        await load();
        if (j.ingested === 0) break; // nothing new ingested → window covered
      }
      setMsg(`Backfill done — ${total} days ingested`);
    } finally { setBusy(null); }
  }

  async function toggleRow(asin: string) {
    if (expanded === asin) { setExpanded(null); return; }
    setExpanded(asin);
    setKit(null);
    setKitLoading(true);
    try {
      const res = await fetch(`/api/amazon/growth/history?storeIndex=${storeIndex}&asin=${encodeURIComponent(asin)}&view=rebuild`);
      if (res.ok) setKit(await res.json());
    } finally {
      setKitLoading(false);
    }
  }

  async function restore(sku: string) {
    if (!confirm("Restore this listing's content (title/bullets/description) to the saved snapshot?")) return;
    setRestoring(true); setMsg(null);
    try {
      const res = await fetch("/api/amazon/growth/history", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeIndex, action: "restoreSnapshot", sku }),
      });
      const j = await res.json();
      setMsg(j.ok ? `Restored ${j.restoredFields} content field(s) from snapshot ✓` : `Restore failed: ${j.error}`);
    } finally {
      setRestoring(false);
    }
  }

  const c = data?.coverage;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-ink-3">Daily sales history + lost-winner recovery — the data backbone for honest lift measurement</div>
        <div className="flex items-center gap-2">
          <Btn size="sm" icon={<Download size={13} />} loading={busy === "ingest"} onClick={ingestLatest}>Ingest latest day</Btn>
          <Btn size="sm" icon={<Camera size={13} />} loading={busy === "snapshot"} onClick={snapshot}>Snapshot now</Btn>
          <Btn size="sm" icon={<HistoryIcon size={13} />} loading={busy === "backfill"} onClick={backfill}>Backfill 90d</Btn>
          <Btn size="sm" variant="outline" icon={<RefreshCw size={13} />} onClick={load} loading={loading}>Refresh</Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Days of history" value={c?.days ?? "—"} />
        <KpiCard label="ASINs tracked" value={c?.asins ?? "—"} />
        <KpiCard label="Snapshots" value={data?.snapshots.count ?? "—"} />
        <KpiCard label="Lost winners" value={data?.lostWinners.length ?? "—"} iconVariant={(data?.lostWinners.length ?? 0) > 0 ? "warn" : "default"} />
      </div>
      {c && (
        <div className="text-[11px] text-ink-3">
          Coverage: {d(c.firstDate)} → {d(c.lastDate)} · {c.rows.toLocaleString()} daily rows
          {data?.snapshots.lastAt && <> · last snapshot {new Date(data.snapshots.lastAt).toLocaleString()}</>}
        </div>
      )}
      {msg && <div className="rounded-lg border border-rule bg-green-soft px-3 py-2 text-[12px] text-green-ink">{msg}</div>}

      <Panel>
        <PanelHeader
          title="Lost winners — recovery candidates"
          count={data?.lostWinners.length}
          right={<span className="text-[11px] text-ink-3">sold well historically, now gone / suppressed / down</span>}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left text-[10px] font-mono uppercase tracking-wider text-ink-3">
                <th className="px-3 py-2">Product / ASIN</th>
                <th className="px-2 py-2">Then ($/units·day)</th>
                <th className="px-2 py-2">Now</th>
                <th className="px-2 py-2">Drop</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={5} className="px-3 py-8 text-center text-ink-3">Loading…</td></tr>
              ) : !data?.lostWinners.length ? (
                <tr><td colSpan={5} className="px-3 py-8 text-center text-ink-3">No lost winners yet — backfill history first (Backfill 90d), and the ~12-month comparison window fills as data accrues.</td></tr>
              ) : (
                data.lostWinners.map((w) => (
                  <Fragment key={w.asin}>
                  <tr className="cursor-pointer border-b border-rule/60 hover:bg-bg-elev/40" onClick={() => toggleRow(w.asin)}>
                    <td className="max-w-[260px] px-3 py-2">
                      <span className="flex items-center gap-1 text-ink">
                        {expanded === w.asin ? <ChevronDown size={13} className="shrink-0 text-ink-3" /> : <ChevronRight size={13} className="shrink-0 text-ink-3" />}
                        <span className="truncate">{w.itemName ?? w.asin}</span>
                      </span>
                      <span className="block pl-4 font-mono text-[10px] text-ink-4">{w.asin}</span>
                    </td>
                    <td className="px-2 py-2 tabular">${w.historicalRevenue.toLocaleString()} · {w.historicalUnitsPerDay}/d</td>
                    <td className="px-2 py-2 tabular">${w.recentRevenue.toLocaleString()} · {w.recentUnitsPerDay}/d</td>
                    <td className="px-2 py-2 tabular"><span className={cn(w.dropPct >= 90 ? "text-danger" : "text-warn-strong")}>−{w.dropPct}%</span></td>
                    <td className="px-2 py-2">
                      {!w.inMirror ? (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--danger-tint)", color: "var(--danger)" }}>gone from catalog</span>
                      ) : w.isSuppressed ? (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--danger-tint)", color: "var(--danger)" }}>suppressed</span>
                      ) : !w.isBuyable ? (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--warn-tint)", color: "var(--warn-strong)" }}>not buyable</span>
                      ) : (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--warn-tint)", color: "var(--warn-strong)" }}>declined</span>
                      )}
                      {w.needsBrandCheck && <span className="ml-1 text-[10px] text-ink-4" title="Not in our mirror — confirm it was our brand via catalog">· verify brand</span>}
                    </td>
                  </tr>
                  {expanded === w.asin && (
                    <tr className="border-b border-rule/60 bg-bg-elev/30">
                      <td colSpan={5} className="px-3 py-3">
                        {kitLoading ? (
                          <span className="text-[12px] text-ink-3">Loading rebuild kit…</span>
                        ) : !kit ? (
                          <span className="text-[12px] text-ink-3">No content source found.</span>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2 text-[11px]">
                              <span className="font-mono uppercase tracking-wider text-ink-3">Rebuild kit</span>
                              <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--bg-elev)", color: "var(--ink-2)" }}>
                                source: {kit.bestSource}
                              </span>
                              {kit.inMirror && kit.snapshot && kit.sku ? (
                                <Btn size="sm" variant="primary" icon={<Undo2 size={12} />} loading={restoring} onClick={() => restore(kit.sku!)}>
                                  Restore content from snapshot
                                </Btn>
                              ) : kit.inMirror ? (
                                <span className="text-[11px] text-ink-4">no snapshot yet — content shown from catalog; restore needs a saved snapshot</span>
                              ) : (
                                <span className="text-[11px] text-ink-4">offer gone — recreating the listing needs price/SKU (next phase); use this content to rebuild</span>
                              )}
                            </div>
                            {(() => {
                              const src = kit.snapshot ?? kit.catalog;
                              if (!src) return <span className="text-[12px] text-ink-3">No content available.</span>;
                              const bullets = src.bullets ?? [];
                              return (
                                <div className="grid gap-3 sm:grid-cols-[80px_1fr]">
                                  {src.mainImageUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={src.mainImageUrl} alt="" className="h-20 w-20 rounded border border-rule object-contain" />
                                  ) : <div className="h-20 w-20 rounded border border-rule bg-bg-elev" />}
                                  <div className="min-w-0 space-y-1">
                                    <div className="text-[12px] text-ink">{src.title ?? "—"}</div>
                                    {bullets.length > 0 && (
                                      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-ink-2">
                                        {bullets.slice(0, 5).map((b, i) => <li key={i} className="truncate">{b}</li>)}
                                      </ul>
                                    )}
                                    {kit.snapshot && <div className="text-[10px] text-ink-4">snapshot from {new Date(kit.snapshot.capturedAt).toLocaleString()}</div>}
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
