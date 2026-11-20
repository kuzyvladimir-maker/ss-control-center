"use client";

/**
 * Dashboard charts (2026-11-20, owner request): daily sales with the
 * previous period for comparison (7/30/90 toggle) and cumulative orders by
 * hour, today vs yesterday. Plain SVG in the kit's palette — brand green
 * for the current period, muted grey dashed for the comparison (dash =
 * second encoding, so identity is never colour alone). Data comes from
 * /api/dashboard/charts; no rows → an empty state with the reason, never
 * a chart of zeros.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Panel, PanelBody, PanelHeader } from "@/components/kit";
import { cn } from "@/lib/utils";

export interface ChartsData {
  today: string;
  nowHour: number;
  daily: Array<{ date: string; sales: number; orders: number }>;
  hourly: {
    today: Array<{ orders: number; sales: number }>;
    yesterday: Array<{ orders: number; sales: number }>;
  };
  weekly: {
    frozen: Array<{ week: string; total: number; elevated: number }>;
    adjustments: Array<{ week: string; amount: number; count: number }>;
  };
  feed: { orderRows: number; frozenRows: number; adjustmentRows: number; storeIndexes: number[] };
  asOf: string;
}

const CURRENT = "var(--green)";
const PREVIOUS = "var(--ink-4)";

export function money(v: number): string {
  if (v >= 10_000) return `$${(v / 1000).toFixed(1)}k`;
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toFixed(0)}`;
}

function dayLabel(ymd: string, withWeekday = false): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", {
    ...(withWeekday ? { weekday: "short" } : {}),
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function hourLabel(h: number): string {
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${h < 12 ? "AM" : "PM"}`;
}

// "Nice" axis max + 3 ticks.
function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return [0, step, step * 2, step * 3];
}

// Callback ref: the measured box only mounts after data arrives (skeleton
// first), so a mount-time effect would observe nothing.
function useWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    roRef.current = ro;
  }, []);
  return [ref, width] as const;
}

function Legend({ items }: { items: Array<{ label: string; dashed?: boolean; color: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <svg width="16" height="8" aria-hidden>
            {it.dashed ? (
              <line x1="0" y1="4" x2="16" y2="4" stroke={it.color} strokeWidth="2" strokeDasharray="4 3" />
            ) : (
              <rect x="0" y="0" width="16" height="8" rx="2" fill={it.color} />
            )}
          </svg>
          {it.label}
        </span>
      ))}
    </div>
  );
}

function EmptyState({ reason }: { reason: string }) {
  return (
    <div className="flex h-[200px] items-center justify-center px-6 text-center text-[12px] text-ink-3">
      {reason}
    </div>
  );
}

function Tooltip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  // Flip to the left of the cursor in the right half so it never overflows.
  const left = x > width / 2;
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-md border border-rule bg-surface px-2.5 py-1.5 text-[11px] shadow-sm"
      style={left ? { right: width - x + 10 } : { left: x + 10 }}
    >
      {children}
    </div>
  );
}

const RANGES = [7, 30, 90] as const;

export function SalesByDayChart({ data, error }: { data: ChartsData | null; error: string | null }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const series = useMemo(() => {
    if (!data) return null;
    const d = data.daily;
    const cur = d.slice(-range);
    const prev = d.slice(-range * 2, -range);
    return {
      cur,
      prev: prev.length === cur.length ? prev : null,
      curTotal: cur.reduce((n, r) => n + r.sales, 0),
      prevTotal: prev.reduce((n, r) => n + r.sales, 0),
      curOrders: cur.reduce((n, r) => n + r.orders, 0),
    };
  }, [data, range]);

  const H = 200;
  const pad = { l: 44, r: 8, t: 12, b: 22 };
  const innerW = Math.max(0, width - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;

  const header = (
    <PanelHeader
      title="Sales by day"
      right={
        <div className="flex rounded-md border border-rule p-0.5" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={range === r}
              onClick={() => setRange(r)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium tabular transition-colors",
                range === r ? "bg-green-soft text-green-ink" : "text-ink-3 hover:text-ink"
              )}
            >
              {r}d
            </button>
          ))}
        </div>
      }
    />
  );

  if (error || !data || !series) {
    return (
      <Panel>
        {header}
        <PanelBody>
          {error ? <EmptyState reason={`Chart data unavailable: ${error}`} /> : <div className="h-[200px] animate-pulse rounded bg-surface-tint" />}
        </PanelBody>
      </Panel>
    );
  }
  if (data.feed.orderRows === 0) {
    return (
      <Panel>
        {header}
        <PanelBody>
          <EmptyState reason="No orders in the database for the selected stores in the last 6 months — check the Amazon orders sync." />
        </PanelBody>
      </Panel>
    );
  }

  const { cur, prev } = series;
  const max = Math.max(...cur.map((r) => r.sales), ...(prev ?? []).map((r) => r.sales), 1);
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1] || 1;
  const y = (v: number) => pad.t + innerH - (v / yMax) * innerH;
  const slot = innerW / cur.length;
  const barW = Math.max(2, Math.min(28, slot - 2)); // 2px gap between bars
  const xc = (i: number) => pad.l + slot * i + slot / 2;
  const prevPath = prev?.map((r, i) => `${i ? "L" : "M"}${xc(i)},${y(r.sales)}`).join(" ");
  const labelEvery = Math.ceil(cur.length / Math.max(1, Math.floor(innerW / 64)));
  const delta = series.prevTotal > 0 ? ((series.curTotal - series.prevTotal) / series.prevTotal) * 100 : null;

  return (
    <Panel>
      {header}
      <PanelBody>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-semibold leading-none tabular text-ink">{money(series.curTotal)}</span>
            <span className="text-[11.5px] tabular text-ink-3">
              {series.curOrders} orders · last {range} days
              {delta !== null && (
                <>
                  {" · "}
                  <span className={delta >= 0 ? "text-green" : "text-warn-strong"}>
                    {delta >= 0 ? "+" : ""}
                    {delta.toFixed(1)}%
                  </span>{" "}
                  vs previous {range} days
                </>
              )}
            </span>
          </div>
          <Legend
            items={[
              { label: `Last ${range} days`, color: CURRENT },
              ...(prev ? [{ label: `Previous ${range} days`, color: PREVIOUS, dashed: true }] : []),
            ]}
          />
        </div>
        <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
          {width > 0 && (
            <svg width={width} height={H} role="img" aria-label={`Daily sales, last ${range} days, with the previous ${range} days for comparison`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--rule)" />
                  <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 text-[10px] tabular">
                    {money(t)}
                  </text>
                </g>
              ))}
              {cur.map((r, i) => {
                const isToday = r.date === data.today;
                const top = y(r.sales);
                const h = pad.t + innerH - top;
                return (
                  <g key={r.date}>
                    {h > 0 && (
                      <path
                        // Rounded data-end (top), square at the baseline.
                        d={`M${xc(i) - barW / 2},${pad.t + innerH} V${top + Math.min(4, h)} Q${xc(i) - barW / 2},${top} ${xc(i) - barW / 2 + Math.min(4, barW / 2)},${top} H${xc(i) + barW / 2 - Math.min(4, barW / 2)} Q${xc(i) + barW / 2},${top} ${xc(i) + barW / 2},${top + Math.min(4, h)} V${pad.t + innerH} Z`}
                        fill={CURRENT}
                        opacity={isToday ? 0.45 : hover === null || hover === i ? 1 : 0.7}
                      />
                    )}
                    {i % labelEvery === 0 && (
                      <text x={xc(i)} y={H - 6} textAnchor="middle" className="fill-ink-3 text-[10px]">
                        {dayLabel(r.date)}
                      </text>
                    )}
                    <rect
                      x={pad.l + slot * i}
                      y={pad.t}
                      width={slot}
                      height={innerH}
                      fill="transparent"
                      onMouseEnter={() => setHover(i)}
                    />
                  </g>
                );
              })}
              {prevPath && (
                <path d={prevPath} fill="none" stroke={PREVIOUS} strokeWidth="2" strokeDasharray="4 3" strokeLinejoin="round" pointerEvents="none" />
              )}
              {hover !== null && prev && (
                <circle cx={xc(hover)} cy={y(prev[hover].sales)} r="4" fill={PREVIOUS} stroke="var(--surface)" strokeWidth="2" pointerEvents="none" />
              )}
            </svg>
          )}
          {hover !== null && cur[hover] && (
            <Tooltip x={xc(hover)} width={width}>
              <div className="font-medium text-ink">
                {dayLabel(cur[hover].date, true)}
                {cur[hover].date === data.today && <span className="ml-1 text-ink-3">(day not finished)</span>}
              </div>
              <div className="tabular text-ink-2">
                {money(cur[hover].sales)} · {cur[hover].orders} orders
              </div>
              {prev && (
                <div className="tabular text-ink-3">
                  {dayLabel(prev[hover].date, true)}: {money(prev[hover].sales)} · {prev[hover].orders} orders
                </div>
              )}
            </Tooltip>
          )}
        </div>
        <div className="mt-1 text-[10.5px] text-ink-3">Today&apos;s bar is lighter: the day is not finished.</div>
      </PanelBody>
    </Panel>
  );
}

export function OrdersByHourChart({ data, error }: { data: ChartsData | null; error: string | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const header = <PanelHeader title="Orders by hour" />;

  if (error || !data) {
    return (
      <Panel>
        {header}
        <PanelBody>
          {error ? <EmptyState reason={`Chart data unavailable: ${error}`} /> : <div className="h-[200px] animate-pulse rounded bg-surface-tint" />}
        </PanelBody>
      </Panel>
    );
  }
  const today = data.hourly.today.slice(0, data.nowHour + 1);
  const yest = data.hourly.yesterday;
  if (yest[23].orders === 0 && today[today.length - 1].orders === 0) {
    return (
      <Panel>
        {header}
        <PanelBody>
          <EmptyState reason="No orders recorded yesterday or today for the selected stores yet." />
        </PanelBody>
      </Panel>
    );
  }

  const H = 200;
  const pad = { l: 32, r: 10, t: 12, b: 22 };
  const innerW = Math.max(0, width - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;
  const ticks = niceTicks(Math.max(yest[23].orders, today[today.length - 1].orders, 1));
  const yMax = ticks[ticks.length - 1] || 1;
  const x = (h: number) => pad.l + (innerW * h) / 23;
  const y = (v: number) => pad.t + innerH - (v / yMax) * innerH;
  const path = (rows: { orders: number }[]) => rows.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r.orders)}`).join(" ");
  const nowT = today[today.length - 1].orders;
  const nowY = yest[data.nowHour].orders;

  return (
    <Panel>
      {header}
      <PanelBody>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[11.5px] tabular text-ink-3">
            Today so far <span className="font-semibold text-ink">{nowT}</span> · yesterday by{" "}
            {hourLabel((data.nowHour + 1) % 24)} <span className="font-semibold text-ink">{nowY}</span> ({yest[23].orders} all day)
          </div>
          <Legend
            items={[
              { label: "Today", color: CURRENT },
              { label: "Yesterday", color: PREVIOUS, dashed: true },
            ]}
          />
        </div>
        <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
          {width > 0 && (
            <svg
              width={width}
              height={H}
              role="img"
              aria-label="Cumulative orders by hour, today versus yesterday"
              onMouseMove={(e) => {
                const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                const h = Math.round(((e.clientX - rect.left - pad.l) / Math.max(1, innerW)) * 23);
                setHover(Math.max(0, Math.min(23, h)));
              }}
            >
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--rule)" />
                  <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 text-[10px] tabular">
                    {t}
                  </text>
                </g>
              ))}
              {[0, 6, 12, 18, 23].map((h) => (
                <text key={h} x={x(h)} y={H - 6} textAnchor={h === 0 ? "start" : h === 23 ? "end" : "middle"} className="fill-ink-3 text-[10px]">
                  {hourLabel(h)}
                </text>
              ))}
              <path d={path(yest)} fill="none" stroke={PREVIOUS} strokeWidth="2" strokeDasharray="4 3" strokeLinejoin="round" />
              <path d={path(today)} fill="none" stroke={CURRENT} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(data.nowHour)} cy={y(nowT)} r="4" fill={CURRENT} stroke="var(--surface)" strokeWidth="2" />
              {hover !== null && (
                <>
                  <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="var(--rule-strong)" />
                  <circle cx={x(hover)} cy={y(yest[hover].orders)} r="4" fill={PREVIOUS} stroke="var(--surface)" strokeWidth="2" />
                  {hover <= data.nowHour && (
                    <circle cx={x(hover)} cy={y(today[hover].orders)} r="4" fill={CURRENT} stroke="var(--surface)" strokeWidth="2" />
                  )}
                </>
              )}
            </svg>
          )}
          {hover !== null && (
            <Tooltip x={x(hover)} width={width}>
              <div className="font-medium text-ink">By {hourLabel((hover + 1) % 24)}</div>
              <div className="tabular text-ink-2">
                Today: {hover <= data.nowHour ? `${today[hover].orders} orders · ${money(today[hover].sales)}` : "—"}
              </div>
              <div className="tabular text-ink-3">
                Yesterday: {yest[hover].orders} orders · {money(yest[hover].sales)}
              </div>
            </Tooltip>
          )}
        </div>
        <div className="mt-1 text-[10.5px] text-ink-3">Running total since midnight ET.</div>
      </PanelBody>
    </Panel>
  );
}

/** Sparkline series for the sales cards, derived from the daily series. */
export function salesSparks(data: ChartsData | null) {
  if (!data || data.feed.orderRows === 0) return null;
  const d = data.daily;
  const month = data.today.slice(0, 7);
  let run = 0;
  const mtd = d.filter((r) => r.date.startsWith(month)).map((r) => (run += r.sales));
  // Monthly totals for the last 5 full months, oldest first.
  const byMonth = new Map<string, number>();
  for (const r of d) byMonth.set(r.date.slice(0, 7), (byMonth.get(r.date.slice(0, 7)) ?? 0) + r.sales);
  const months = [...byMonth.entries()].filter(([m]) => m < month).slice(-5).map(([, v]) => v);
  return {
    // Last 14 full days (yesterday back) — today is partial.
    daily14: d.slice(-15, -1).map((r) => r.sales),
    mtd,
    months,
  };
}
