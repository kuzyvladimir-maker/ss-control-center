"use client";

/**
 * Economics / Profit — per-SKU unit economics for one store + marketplace.
 *
 *   profit  = (item price + shipping charged) − COGS − packaging − referral − own shipping
 *   margin% = profit / (item price + shipping charged)
 *
 * Read-only planning view: assembled from cached sources (SkuCost, listing
 * snapshots, Buy Box cache, shipment label costs). Fees are ESTIMATED from the
 * published referral schedules — they are not the actual settlement fees.
 * Rows are sorted worst-margin first, so the top of the table is the worklist.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, AlertCircle, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Marketplace = "amazon" | "walmart";

interface EconomicsRow {
  sku: string;
  title: string | null;
  marketplace: Marketplace;
  economicsStatus: "CALCULATED" | "BLOCKED";
  blockers: string[];
  profit: number | null;
  marginPct: number | null;
  referralFee: number | null;
  revenue: number;
  cooler: string | null;
  cogsSource: string | null;
  breakdown: {
    itemPrice: number;
    shippingCharged: number;
    cogs: number | null;
    packaging: number;
    referralFee: number | null;
    ownShipping: number;
  };
  flags: string[];
}

interface Summary {
  truthMode: "LEGACY_UNSCOPED_TRANSITIONAL";
  authoritative: false;
  storeIndex: number;
  marketplace: Marketplace;
  total: number;
  cogsMissing: number;
  belowTargetMargin: number;
  rows: EconomicsRow[];
}

const usd = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const FLAG_LABEL: Record<string, string> = {
  cogs_missing: "COGS missing",
  cogs_unsourceable: "COGS unsourceable",
  cogs_stale: "COGS stale",
  packaging_estimated: "Packaging est.",
  own_shipping_missing: "Own ship missing",
  own_shipping_estimated: "Own ship est.",
  shipping_charged_estimated: "Ship charge est.",
  below_target_margin: "Below 20%",
};

export default function EconomicsPage() {
  const [store, setStore] = useState(1);
  const [marketplace, setMarketplace] = useState<Marketplace>("amazon");
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/economics/skus?store=${store}&marketplace=${marketplace}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Request failed");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [store, marketplace]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Economics / Profit</h1>
          <p className="text-sm text-muted-foreground">
            Per-SKU profit = price + shipping − COGS − packaging − referral − own shipping.
            Fees are estimated from the published referral schedules, not settlement actuals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border">
            {(["amazon", "walmart"] as Marketplace[]).map((m) => (
              <button
                key={m}
                onClick={() => setMarketplace(m)}
                className={cn(
                  "px-3 py-1.5 text-sm capitalize",
                  marketplace === m ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <Input
            type="number"
            min={1}
            value={store}
            onChange={(e) => setStore(Number(e.target.value) || 1)}
            className="w-20"
            aria-label="Store index"
          />
          <Button onClick={load} disabled={loading} variant="outline" size="sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-4 text-destructive">
            <AlertCircle className="h-4 w-4" /> {error}
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {!data.authoritative && (
            <Card className="border-amber-500/60 bg-amber-50/60 dark:bg-amber-950/20">
              <CardContent className="flex items-start gap-2 py-4 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <span>
                  Transitional legacy view: COGS is still resolved by raw SKU and is not
                  authoritative Product Truth. Missing or unsourceable COGS blocks profit;
                  do not use this page for repricing until the manifest-bound cutover.
                </span>
              </CardContent>
            </Card>
          )}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Kpi label="Live SKUs" value={data.total.toString()} />
            <Kpi
              label="COGS unavailable"
              value={data.cogsMissing.toString()}
              warn={data.cogsMissing > 0}
            />
            <Kpi
              label="Below 20% margin"
              value={data.belowTargetMargin.toString()}
              warn={data.belowTargetMargin > 0}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {data.rows.length} SKUs — blocked first, then worst margin
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">SKU</th>
                    <th className="px-3 py-2">Price</th>
                    <th className="px-3 py-2">+Ship</th>
                    <th className="px-3 py-2">COGS</th>
                    <th className="px-3 py-2">Pkg</th>
                    <th className="px-3 py-2">Referral</th>
                    <th className="px-3 py-2">Own ship</th>
                    <th className="px-3 py-2 text-right">Profit</th>
                    <th className="px-3 py-2 text-right">Margin</th>
                    <th className="px-3 py-2">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.sku} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="max-w-[260px] px-3 py-2">
                        <div className="font-mono text-xs">{r.sku}</div>
                        {r.title && (
                          <div className="truncate text-xs text-muted-foreground">{r.title}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">{usd(r.breakdown.itemPrice)}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {usd(r.breakdown.shippingCharged)}
                      </td>
                      <td className="px-3 py-2">
                        {r.breakdown.cogs == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          r.breakdown.cogs == null ? "—" : usd(r.breakdown.cogs)
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{usd(r.breakdown.packaging)}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {r.breakdown.referralFee == null ? "—" : usd(r.breakdown.referralFee)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{usd(r.breakdown.ownShipping)}</td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-medium",
                          r.profit == null
                            ? "text-muted-foreground"
                            : r.profit < 0 ? "text-destructive" : "text-emerald-600",
                        )}
                      >
                        {r.profit == null ? "BLOCKED" : usd(r.profit)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-medium",
                          r.marginPct == null
                            ? "text-muted-foreground"
                            : r.marginPct < 0.2 ? "text-destructive" : "text-emerald-600",
                        )}
                      >
                        {r.marginPct == null ? "—" : pct(r.marginPct)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {r.flags.map((f) => (
                            <span
                              key={f}
                              className={cn(
                                "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]",
                                f === "cogs_missing" || f === "cogs_unsourceable" || f === "below_target_margin"
                                  ? "bg-destructive/10 text-destructive"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {(f === "cogs_missing" || f === "cogs_unsourceable" || f === "below_target_margin") && (
                                <AlertTriangle className="h-2.5 w-2.5" />
                              )}
                              {FLAG_LABEL[f] ?? f}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                        No SKUs found for this store + marketplace. Check that listing
                        prices are synced.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className={cn("text-2xl font-semibold", warn && "text-destructive")}>{value}</div>
      </CardContent>
    </Card>
  );
}
