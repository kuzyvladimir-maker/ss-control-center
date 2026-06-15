"use client";

/**
 * Amazon Growth — Optimizer results (what the fixes achieved).
 *
 * Sits UNDER the Bulk fix builder. The builder does the work (filter → pool →
 * fix); this panel is read-only proof of impact: before/after health lift on the
 * listings we changed, plus a catalog-wide map of the most common errors so you
 * know what to target next. No candidate table here — that lives in the builder.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ArrowUpRight, ArrowDownRight, ListChecks } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard } from "@/components/kit";

interface Summary {
  applied: number;
  measured: number;
  pendingMeasure: number;
  avgHealthDelta: number | null;
}
interface HistoryRow {
  sku: string;
  itemName: string | null;
  runAt: string;
  fixKinds: string[];
  changeCount: number;
  measured: boolean;
  beforeHealth: number | null;
  afterHealth: number | null;
  healthDelta: number | null;
  beforeErrors: number | null;
  afterErrors: number | null;
}
interface HeatItem {
  code: string;
  message: string;
  count: number;
}

export function OptimizerResults({ storeIndex }: { storeIndex: number }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [heatmap, setHeatmap] = useState<HeatItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // limit=1 — we only want the rollups (summary/history/heatmap), not the worklist.
      const res = await fetch(`/api/amazon/growth/optimizer?storeIndex=${storeIndex}&limit=1`);
      if (res.ok) {
        const j = await res.json();
        setSummary(j.summary ?? null);
        setHistory(j.history ?? []);
        setHeatmap(j.issueHeatmap ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [storeIndex]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-ink-3">
          What the fixes achieved — before/after health on the listings we changed, and the catalog&apos;s most common errors to target next.
        </div>
        <Btn icon={<RefreshCw size={13} />} onClick={load} loading={loading}>Refresh</Btn>
      </div>

      {/* Impact KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Listings improved" value={summary ? summary.applied : "—"} icon={<ListChecks size={15} />} />
        <KpiCard
          label="Avg health lift"
          value={summary?.avgHealthDelta != null ? `${summary.avgHealthDelta > 0 ? "+" : ""}${summary.avgHealthDelta}` : "—"}
          icon={<ArrowUpRight size={15} />}
          iconVariant={summary?.avgHealthDelta != null && summary.avgHealthDelta > 0 ? "default" : "warn"}
        />
        <KpiCard label="Measured" value={summary ? summary.measured : "—"} />
        <KpiCard label="Awaiting measurement" value={summary ? summary.pendingMeasure : "—"} iconVariant="warn" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Impact history */}
        <Panel>
          <PanelHeader title="Impact — before / after" count={history.length} />
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-rule text-left text-[10.5px] font-mono uppercase tracking-wider text-ink-3">
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-2 py-2 font-medium">Fixed</th>
                  <th className="px-2 py-2 font-medium">Health</th>
                  <th className="px-2 py-2 text-right font-medium">Errors</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-ink-3">No fixes applied yet — run one in the builder above.</td>
                  </tr>
                ) : (
                  history.map((h, i) => (
                    <tr key={h.sku + i} className="border-b border-rule/60 hover:bg-bg-elev/40">
                      <td className="max-w-[260px] px-3 py-2">
                        <span className="block truncate text-ink">{h.itemName ?? h.sku}</span>
                        <span className="block text-[10px] text-ink-4">
                          {h.sku} · {new Date(h.runAt).toLocaleDateString()}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-[11px] text-ink-2">{h.fixKinds.join(", ") || "—"}</td>
                      <td className="px-2 py-2">
                        {!h.measured ? (
                          <span className="text-[11px] text-ink-3">{h.beforeHealth?.toFixed(0) ?? "—"} · pending</span>
                        ) : (
                          <Delta before={h.beforeHealth} after={h.afterHealth} d={h.healthDelta} />
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular text-ink-3">
                        {h.measured && h.afterErrors != null ? `${h.beforeErrors ?? "—"}→${h.afterErrors}` : (h.beforeErrors ?? "—")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Most-common-issues heatmap */}
        <Panel>
          <PanelHeader title="Most common errors" />
          <div className="space-y-1.5 p-3">
            {heatmap.length === 0 ? (
              <div className="text-[12px] text-ink-3">No errors found.</div>
            ) : (
              heatmap.map((g) => {
                const max = heatmap[0].count || 1;
                return (
                  <div key={g.code + g.message}>
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="truncate text-ink-2" title={g.message}>
                        {g.code && <span className="font-mono text-ink-3">{g.code} </span>}
                        {g.message}
                      </span>
                      <span className="tabular text-ink-3">{g.count}</span>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-bg-elev">
                      <div className="h-full rounded-full" style={{ width: `${(g.count / max) * 100}%`, background: "var(--warn)" }} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Delta({ before, after, d }: { before: number | null; after: number | null; d: number | null }) {
  const up = (d ?? 0) > 0;
  const down = (d ?? 0) < 0;
  const color = up ? "var(--green-ink)" : down ? "var(--danger)" : "var(--ink-3)";
  return (
    <span className="tabular text-[11.5px]">
      {before?.toFixed(0) ?? "—"} → <span style={{ color, fontWeight: 600 }}>{after?.toFixed(0) ?? "—"}</span>
      {d != null && d !== 0 && (
        <span className="ml-1 inline-flex items-center text-[10px]" style={{ color }}>
          {up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
          {Math.abs(d).toFixed(1)}
        </span>
      )}
    </span>
  );
}
