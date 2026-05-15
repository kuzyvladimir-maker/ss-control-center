"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { cn } from "@/lib/utils";

interface Comparison {
  vs: string;
  baseline: number;
  percent: number | null;
}

interface Period {
  value: number;
  comparison: Comparison | null;
}

interface ForecastPeriod extends Period {
  meta?: {
    daysPassed: number;
    daysInMonth: number;
    method: string;
    reason?: string;
  };
}

interface SalesResponse {
  today: Period;
  yesterday: Period;
  mtd: Period;
  lastMonth: Period;
  forecast: ForecastPeriod;
  meta: { tz: string; asOf: string; storeIdsApplied: string[] };
}

/**
 * Five-period sales summary row on the Dashboard. Subscribes to the global
 * store filter so toggles in the sidebar refetch live. Hidden entirely when
 * the user has unselected every store (the parent shows an EmptyState then).
 */
export function SalesCardsRow() {
  const {
    selectedStoreIds,
    isLoading: storeLoading,
    isAllSelected,
    allStores,
  } = useStoreFilter();
  const [data, setData] = useState<SalesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stable key so toggling stores re-runs the effect, but reordering selection
  // (which can't happen in our UI but defensively) doesn't.
  const filterKey = [...selectedStoreIds].sort().join(",");

  useEffect(() => {
    if (storeLoading) return;
    if (selectedStoreIds.length === 0) {
      setData(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const qs = isAllSelected ? "" : `?storeIds=${selectedStoreIds.join(",")}`;
    fetch(`/api/dashboard/sales${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((j: SalesResponse) => {
        if (cancelled) return;
        setData(j);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, storeLoading, isAllSelected]);

  // Hide entirely when the user has unselected everything — Dashboard
  // already shows an empty-state panel in that branch.
  if (
    !storeLoading &&
    allStores.length > 0 &&
    selectedStoreIds.length === 0
  ) {
    return null;
  }

  if (loading || !data) return <SalesCardsSkeleton />;

  if (error) {
    return (
      <div className="rounded-md border border-rule bg-surface-tint px-4 py-3 text-[12px] text-ink-3">
        Failed to load sales summary: {error}
      </div>
    );
  }

  // Each sales card is a Link to /analytics scoped to that period. The
  // analytics page reads `?period=` to scope its tables and charts to
  // the same window the dashboard card summarised — letting the operator
  // drill from a headline number into the underlying orders.
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <SalesCard
        title="Sales today"
        href="/analytics?period=today"
        value={data.today.value}
        comparison={data.today.comparison}
        comparisonLabel="vs yesterday"
      />
      <SalesCard
        title="Sales yesterday"
        href="/analytics?period=yesterday"
        value={data.yesterday.value}
        comparison={data.yesterday.comparison}
        comparisonLabel="vs last week"
      />
      <SalesCard
        title="Month to date"
        href="/analytics?period=mtd"
        value={data.mtd.value}
        comparison={data.mtd.comparison}
        comparisonLabel="vs last mo. same period"
      />
      <SalesCard
        title="Last month"
        href="/analytics?period=lastMonth"
        value={data.lastMonth.value}
        comparison={null}
      />
      <SalesCard
        title="Forecast"
        href="/analytics?period=forecast"
        value={data.forecast.value}
        comparison={data.forecast.comparison}
        comparisonLabel="vs last month"
        forecastReason={data.forecast.meta?.reason}
        isForecast
      />
    </div>
  );
}

function SalesCard({
  title,
  value,
  comparison,
  comparisonLabel,
  forecastReason,
  isForecast,
  href,
}: {
  title: string;
  value: number | null;
  comparison: Comparison | null;
  comparisonLabel?: string;
  forecastReason?: string;
  isForecast?: boolean;
  /** Drilldown destination — clicking the card navigates here. Without
   *  it the card renders as a plain div. */
  href?: string;
}) {
  const formatted = value === null ? "—" : formatMoney(value);
  const percent = comparison?.percent ?? null;

  // Salutem rule: down → amber, never red. Up → green. None → neutral grey.
  const direction =
    percent === null ? "neutral" : percent >= 0 ? "up" : "down";
  const TrendIcon =
    direction === "up"
      ? TrendingUp
      : direction === "down"
        ? TrendingDown
        : Minus;

  const Wrapper = href ? Link : "div";
  const wrapperProps: Record<string, unknown> = href ? { href } : {};

  return (
    <Wrapper
      {...(wrapperProps as { href: string })}
      className={cn(
        "block rounded-lg border border-rule bg-surface p-4 transition-colors",
        isForecast && "bg-surface-tint",
        href &&
          "cursor-pointer hover:border-green-mid/40 hover:bg-bg-elev/40"
      )}
    >
      <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ink-3">
        {title}
      </div>
      <div className="mt-2 text-[24px] font-semibold leading-none text-ink tabular">
        {formatted}
      </div>
      {comparison && percent !== null && (
        <div className="mt-2 flex items-baseline gap-1 text-[11.5px]">
          <TrendIcon
            size={12}
            className={cn(
              "self-center",
              direction === "up" && "text-green",
              direction === "down" && "text-warn-strong",
              direction === "neutral" && "text-ink-3"
            )}
          />
          <span
            className={cn(
              "tabular font-medium",
              direction === "up" && "text-green",
              direction === "down" && "text-warn-strong",
              direction === "neutral" && "text-ink-3"
            )}
          >
            {percent >= 0 ? "+" : ""}
            {percent.toFixed(1)}%
          </span>
          <span className="text-ink-3">{comparisonLabel}</span>
        </div>
      )}
      {comparison && percent === null && comparisonLabel && (
        <div className="mt-2 text-[11.5px] text-ink-3">
          {comparisonLabel} <span className="text-ink-3">(no data)</span>
        </div>
      )}
      {!comparison && forecastReason && (
        <div className="mt-2 text-[11.5px] text-ink-3">{forecastReason}</div>
      )}
    </Wrapper>
  );
}

function formatMoney(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 10_000) {
    return `$${Math.round(value).toLocaleString("en-US")}`;
  }
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function SalesCardsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-[96px] animate-pulse rounded-lg border border-rule bg-surface-tint"
        />
      ))}
    </div>
  );
}
