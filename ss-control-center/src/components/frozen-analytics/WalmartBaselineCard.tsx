"use client";

/**
 * Small inline card that shows Walmart non-frozen complaint baseline on the
 * Frozen Analytics page. Walmart doesn't sell frozen products — this
 * counter exists purely to contextualize the Amazon frozen numbers:
 * "for the same 30-day window, we got N non-frozen Walmart complaints."
 *
 * No UI actions, no drill-down. Data comes from the dashboard summary
 * endpoint we already compute on /api/dashboard/summary.
 */

import { useEffect, useState } from "react";
import { Info, ShoppingBag, PackageMinus } from "lucide-react";

interface SummaryShape {
  walmart?: {
    ordersTotal30d: number;
    returnsPending: number;
    refundsLast7d: number;
  };
}

export default function WalmartBaselineCard() {
  const [summary, setSummary] = useState<SummaryShape | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/summary")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (!cancelled) setSummary(j);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed || !summary?.walmart) return null;

  const { ordersTotal30d, returnsPending, refundsLast7d } = summary.walmart;

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-md border border-rule bg-surface-tint px-4 py-2 text-xs text-ink-2">
      <span className="inline-flex items-center gap-1 font-medium text-ink">
        <Info size={13} /> Walmart baseline (non-frozen)
      </span>
      <span className="inline-flex items-center gap-1">
        <ShoppingBag size={13} className="text-ink-3" />
        {ordersTotal30d} orders / 30d
      </span>
      <span className="inline-flex items-center gap-1">
        <PackageMinus size={13} className="text-ink-3" />
        {returnsPending} returns pending
      </span>
      <span>${refundsLast7d.toFixed(2)} refunds / 7d</span>
    </div>
  );
}
