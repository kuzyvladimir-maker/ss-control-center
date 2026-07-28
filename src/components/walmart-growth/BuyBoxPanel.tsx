"use client";

/**
 * Walmart Growth — Buy Box panel.
 *
 * Answers "traffic but no sale": shows which SKUs lose the Buy Box and the $
 * gap to the winning offer. Data comes from the async Buy Box report
 * (/api/walmart/growth/buybox); the report regenerates ~daily via cron.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Btn, Panel, PanelHeader, KpiCard } from "@/components/kit";
import { cn } from "@/lib/utils";

interface BuyBoxItemDto {
  sku: string;
  itemId: string | null;
  productName: string | null;
  productCategory: string | null;
  sellerItemPrice: number | null;
  sellerShipPrice: number | null;
  sellerTotalPrice: number | null;
  isWinner: boolean;
  buyBoxItemPrice: number | null;
  buyBoxShipPrice: number | null;
  buyBoxTotalPrice: number | null;
  priceGap: number | null;
}
interface BuyBoxResponse {
  report: {
    status: string;
    requestedAt: string;
    downloadedAt: string | null;
    rowCount: number | null;
    error: string | null;
  } | null;
  rollup: {
    total: number;
    winning: number;
    losing: number;
    winRate: number | null;
    losingWithGap: number;
    totalGapToClose: number;
    lastReportAt: string | null;
  };
  worklist: { total: number; limit: number; offset: number; items: BuyBoxItemDto[] };
}

type Filter = "losing" | "winning" | "all";

function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

export function BuyBoxPanel() {
  const [data, setData] = useState<BuyBoxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("losing");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ filter, limit: "80" });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/walmart/growth/buybox?${params}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [filter, q]);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setSyncing(true);
    setSyncMsg("Advancing Buy Box report…");
    try {
      const res = await fetch("/api/walmart/growth/buybox/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = await res.json();
      if (j.ok) {
        const map: Record<string, string> = {
          requested: "Report requested — generation takes 15-45 min. Check back soon.",
          polled: `Still generating (${j.status})…`,
          downloaded: `Updated · ${j.upserted} items, ${j.losing} losing the Buy Box`,
          rateLimited: "Walmart rate-limited the report endpoint — will retry automatically.",
          idle: "Buy Box data is up to date.",
          errored: `Report error: ${j.message ?? j.status}`,
        };
        setSyncMsg(map[j.action] ?? j.action);
      } else {
        setSyncMsg(`Error: ${j.error ?? "unknown"}`);
      }
      await load();
    } catch (e) {
      setSyncMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 8000);
    }
  }

  const r = data?.rollup;
  const report = data?.report;
  const generating =
    report && ["REQUESTED", "INPROGRESS", "RECEIVED", "SUBMITTED"].includes(report.status);
  const hasData = (r?.total ?? 0) > 0;

  return (
    <div className="space-y-4">
      {/* Status banner + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-ink-3">
          {report?.downloadedAt
            ? `Last Buy Box report: ${new Date(report.downloadedAt).toLocaleString()}`
            : generating
              ? "Buy Box report generating… (Walmart takes 15-45 min)"
              : "No Buy Box report yet."}
        </div>
        <div className="flex items-center gap-2">
          {syncMsg && <span className="text-[11px] text-ink-3">{syncMsg}</span>}
          <Btn icon={<RefreshCw size={13} />} onClick={refresh} loading={syncing}>
            {syncing ? "Working…" : "Refresh Buy Box"}
          </Btn>
        </div>
      </div>

      {!hasData ? (
        <Panel>
          <div className="p-8 text-center text-[13px] text-ink-3">
            {generating ? (
              <>
                Buy Box report is generating on Walmart&apos;s side.
                <div className="mt-1 text-[11.5px] text-ink-4">
                  It takes 15-45 min. The cron picks it up automatically, or click
                  &nbsp;<strong>Refresh Buy Box</strong>&nbsp;again in a bit.
                </div>
              </>
            ) : (
              <>
                No Buy Box data yet. Click <strong>Refresh Buy Box</strong> to request the report.
                <div className="mt-1 text-[11.5px] text-ink-4">
                  Shows which SKUs lose the Buy Box and the $ gap to the winning offer.
                </div>
              </>
            )}
          </div>
        </Panel>
      ) : (
        <>
          {/* Rollup */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Buy Box win rate" value={r?.winRate != null ? `${r.winRate}%` : "—"} />
            <KpiCard
              label="Losing Buy Box"
              value={r?.losing ?? 0}
              iconVariant="danger"
              active={filter === "losing"}
              onClick={() => setFilter("losing")}
            />
            <KpiCard label="Priced above Buy Box" value={r?.losingWithGap ?? 0} iconVariant="warn" />
            <KpiCard label="Total $ gap to close" value={usd(r?.totalGapToClose)} iconVariant="warn" />
          </div>

          {/* Table */}
          <Panel>
            <PanelHeader
              title="Buy Box"
              count={data?.worklist.total}
              right={
                <div className="flex items-center gap-2">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search product / SKU…"
                    className="h-7 w-44 rounded-md border border-rule bg-surface px-2 text-[12px] text-ink placeholder:text-ink-4 focus:border-green-mid focus:outline-none"
                  />
                  {(["losing", "winning", "all"] as Filter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors",
                        filter === f
                          ? "bg-green-soft text-green-ink"
                          : "text-ink-2 hover:bg-bg-elev hover:text-ink"
                      )}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-rule text-left text-[10.5px] font-mono uppercase tracking-wider text-ink-3">
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-2 py-2 font-medium">Buy Box</th>
                    <th className="px-2 py-2 text-right font-medium">Our price</th>
                    <th className="px-2 py-2 text-right font-medium">Buy Box price</th>
                    <th className="px-2 py-2 text-right font-medium">Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && !data ? (
                    <tr><td colSpan={5} className="px-3 py-8 text-center text-ink-3">Loading…</td></tr>
                  ) : data && data.worklist.items.length === 0 ? (
                    <tr><td colSpan={5} className="px-3 py-8 text-center text-ink-3">No items match this filter.</td></tr>
                  ) : (
                    data?.worklist.items.map((it) => (
                      <tr key={it.sku} className="border-b border-rule/60 hover:bg-bg-elev/40">
                        <td className="max-w-[340px] px-3 py-2">
                          <span className="block truncate text-ink">{it.productName ?? it.sku}</span>
                          <span className="block text-[11px] text-ink-4">{it.sku}{it.productCategory ? ` · ${it.productCategory}` : ""}</span>
                        </td>
                        <td className="px-2 py-2">
                          {it.isWinner ? (
                            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium text-green-ink" style={{ background: "var(--green-soft)" }}>Winning</span>
                          ) : (
                            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: "var(--danger-tint)", color: "var(--danger)" }}>Losing</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right tabular text-ink-2">{usd(it.sellerTotalPrice)}</td>
                        <td className="px-2 py-2 text-right tabular text-ink-2">{usd(it.buyBoxTotalPrice)}</td>
                        <td className="px-2 py-2 text-right tabular">
                          <span className={cn(it.priceGap != null && it.priceGap > 0 ? "text-danger" : "text-green")}>
                            {it.priceGap == null ? "—" : `${it.priceGap > 0 ? "+" : ""}${it.priceGap.toFixed(2)}`}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {data && data.worklist.total > data.worklist.items.length && (
              <div className="border-t border-rule px-3 py-2 text-center text-[11.5px] text-ink-3">
                Showing {data.worklist.items.length} of {data.worklist.total} — refine with search.
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
