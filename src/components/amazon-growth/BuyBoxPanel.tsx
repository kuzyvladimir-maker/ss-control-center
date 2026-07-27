"use client";

/**
 * Amazon Growth — Featured Offer (Buy Box) panel.
 *
 * Derived from the Sales & Traffic enrichment (buyBoxPercentage per ASIN).
 * Shows the win-rate summary + the listings losing the Featured Offer most,
 * ranked by traffic at risk. Populates once the report cron has ingested S&T.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard } from "@/components/kit";
import { cn } from "@/lib/utils";

interface BbItem {
  sku: string;
  asin: string | null;
  itemName: string | null;
  buyBoxPercentage: number | null;
  sessions30d: number | null;
  unitsOrdered30d: number | null;
  unitSessionPct: number | null;
}
interface BbResponse {
  summary: { totalWithSignal: number; losing: number; avgBuyBoxPct: number | null };
  items: BbItem[];
  worklist: { total: number };
}

export function BuyBoxPanel({ storeIndex }: { storeIndex: number }) {
  const [data, setData] = useState<BbResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/amazon/growth/buybox?storeIndex=${storeIndex}&limit=60`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [storeIndex]);
  useEffect(() => {
    load();
  }, [load]);

  const s = data?.summary;
  const hasData = Boolean(s && s.totalWithSignal > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] text-ink-3">
          Featured Offer share from Sales &amp; Traffic — who wins the buy box, ranked by traffic at risk
        </div>
        <Btn icon={<RefreshCw size={13} />} onClick={load} loading={loading}>
          Refresh
        </Btn>
      </div>

      {!hasData && !loading ? (
        <Panel>
          <div className="p-8 text-center text-[13px] text-ink-3">
            No Buy Box data yet. It populates once the report sync ingests Sales &amp; Traffic
            (cron <span className="font-mono text-[11px]">amazon-reports</span>).
          </div>
        </Panel>
      ) : (
        <>
          {s && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <KpiCard label="Listings with signal" value={s.totalWithSignal} />
              <KpiCard label="Losing featured offer" value={s.losing} iconVariant="warn" />
              <KpiCard label="Avg buy-box %" value={s.avgBuyBoxPct != null ? `${s.avgBuyBoxPct}%` : "—"} />
            </div>
          )}

          <Panel>
            <PanelHeader title="Losing the Featured Offer" count={data?.worklist.total} />
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-rule text-left text-[10.5px] font-mono uppercase tracking-wider text-ink-3">
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-2 py-2 text-right font-medium">Buy-box %</th>
                    <th className="px-2 py-2 text-right font-medium">30d sessions</th>
                    <th className="px-2 py-2 text-right font-medium">Units</th>
                    <th className="px-2 py-2 text-right font-medium">Conv.</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && !data ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-ink-3">Loading…</td>
                    </tr>
                  ) : data && data.items.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-ink-3">Winning the featured offer everywhere with traffic.</td>
                    </tr>
                  ) : (
                    data?.items.map((it) => (
                      <tr key={it.sku} className="border-b border-rule/60 hover:bg-bg-elev/40">
                        <td className="max-w-[360px] px-3 py-2">
                          <span className="block truncate text-ink">{it.itemName ?? it.sku}</span>
                          <span className="block text-[11px] text-ink-4">
                            {it.sku}
                            {it.asin ? ` · ${it.asin}` : ""}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular">
                          <span className={cn((it.buyBoxPercentage ?? 0) < 50 ? "text-danger" : "text-warn-strong")}>
                            {it.buyBoxPercentage != null ? `${it.buyBoxPercentage.toFixed(0)}%` : "—"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular text-ink-2">{it.sessions30d ?? 0}</td>
                        <td className="px-2 py-2 text-right tabular text-ink-2">{it.unitsOrdered30d ?? 0}</td>
                        <td className="px-2 py-2 text-right tabular text-ink-3">
                          {it.unitSessionPct != null ? `${(it.unitSessionPct * 100).toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
