/**
 * GET /api/sales-overview/periods
 *
 * Returns 5 period summary blocks in one shot — used to power the
 * Sellerboard-style tile row at the top of the Sales Overview page.
 * Each tile is a separate (from, to) window:
 *   - today          (start of today ET → now)
 *   - yesterday      (full prior day)
 *   - mtd            (start of current month → now)
 *   - thisMonth      (full current month — same range as mtd, but with a
 *                     `forecast` extrapolated to month-end)
 *   - lastMonth      (full prior month)
 *
 * Each block carries the same shape as the `summary` field on the main
 * /api/sales-overview endpoint, plus a `prior` block (same-length
 * window immediately before) so the tile can render +/- deltas.
 *
 * All 10+ DB queries (5 windows × 2 channels × 2 timeframes) run in
 * parallel — total response time is dominated by the slowest single
 * query, not their sum. With our cached AmazonOrder + WalmartOrder
 * tables this comes back in well under a second.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  subDays,
  subMonths,
  differenceInDays,
} from "date-fns";

export const maxDuration = 30;

const TZ = "America/New_York";

function asUtc(zoned: Date): Date {
  return fromZonedTime(zoned, TZ);
}

interface Window {
  from: Date;
  to: Date;
  label: string;
}

function buildWindows(now: Date): {
  today: Window;
  yesterday: Window;
  mtd: Window;
  thisMonth: Window;
  lastMonth: Window;
} {
  const nowEt = toZonedTime(now, TZ);
  const yest = subDays(nowEt, 1);
  const lm = subMonths(nowEt, 1);
  return {
    today: { from: asUtc(startOfDay(nowEt)), to: now, label: "Today" },
    yesterday: {
      from: asUtc(startOfDay(yest)),
      to: asUtc(endOfDay(yest)),
      label: "Yesterday",
    },
    mtd: {
      from: asUtc(startOfMonth(nowEt)),
      to: now,
      label: "Month to date",
    },
    thisMonth: {
      from: asUtc(startOfMonth(nowEt)),
      to: now,
      label: "This month (Forecast)",
    },
    lastMonth: {
      from: asUtc(startOfMonth(lm)),
      to: asUtc(endOfMonth(lm)),
      label: "Last month",
    },
  };
}

// One unified shape — Amazon and Walmart loaders both map to this.
interface NormalizedOrder {
  total: number;
  itemsCount: number;
  status: string;
}

function normalizeStatus(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === "cancelled" || s === "canceled") return "Cancelled";
  if (s === "shipped" || s === "delivered") return "Shipped";
  if (s === "unshipped") return "Unshipped";
  if (s === "pending") return "Pending";
  if (s === "acknowledged") return "Acknowledged";
  if (s === "created") return "Created";
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

async function loadOrders(
  from: Date,
  to: Date,
  channel: "all" | "amazon" | "walmart",
  storeIndex: number | null,
): Promise<NormalizedOrder[]> {
  const tasks: Array<Promise<NormalizedOrder[]>> = [];
  if (channel !== "walmart") {
    tasks.push(
      prisma.amazonOrder
        .findMany({
          where: {
            purchaseDate: { gte: from, lte: to },
            ...(storeIndex ? { storeIndex } : {}),
          },
          select: { orderTotal: true, numberOfItems: true, status: true },
        })
        .then((rows) =>
          rows.map((r) => ({
            total: r.orderTotal,
            itemsCount: r.numberOfItems,
            status: normalizeStatus(r.status),
          })),
        ),
    );
  }
  if (channel !== "amazon") {
    tasks.push(
      prisma.walmartOrder
        .findMany({
          where: { orderDate: { gte: from, lte: to } },
          select: { orderTotal: true, numberOfItems: true, status: true },
        })
        .then((rows) =>
          rows.map((r) => ({
            total: r.orderTotal,
            itemsCount: r.numberOfItems,
            status: normalizeStatus(r.status),
          })),
        ),
    );
  }
  const chunks = await Promise.all(tasks);
  return chunks.flat();
}

interface Summary {
  revenue: number;
  orders: number;
  units: number;
  avgOrder: number;
  shipped: number;
  cancelled: number;
}

function summarize(orders: NormalizedOrder[]): Summary {
  const revenue = orders.reduce((s, o) => s + o.total, 0);
  const units = orders.reduce((s, o) => s + (o.itemsCount || 0), 0);
  const n = orders.length;
  const status = (s: string) =>
    orders.filter((o) => o.status === s).length;
  return {
    revenue: Math.round(revenue * 100) / 100,
    orders: n,
    units,
    avgOrder: n > 0 ? Math.round((revenue / n) * 100) / 100 : 0,
    shipped: status("Shipped"),
    cancelled: status("Cancelled"),
  };
}

async function summarizeWindow(
  win: Window,
  channel: "all" | "amazon" | "walmart",
  storeIndex: number | null,
): Promise<Summary> {
  return summarize(await loadOrders(win.from, win.to, channel, storeIndex));
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const channelParam = sp.get("channel") as
      | "amazon"
      | "walmart"
      | "all"
      | null;
    const channel = channelParam ?? "all";
    const storeIndexRaw = sp.get("storeIndex");
    const storeIndex = storeIndexRaw ? parseInt(storeIndexRaw, 10) : null;

    const now = new Date();
    const w = buildWindows(now);

    // Prior windows for delta arrows. "Today vs same-time-yesterday",
    // "Yesterday vs day-before", "MTD vs same days last month",
    // "Last month vs the month before".
    const nowEt = toZonedTime(now, TZ);
    const twoDaysAgo = subDays(nowEt, 2);
    const lmStart = subMonths(nowEt, 1);
    const monthBeforeLast = subMonths(nowEt, 2);
    const priorWindows = {
      today: {
        // Yesterday at this same hour-of-day, so we're comparing
        // apples-to-apples runrates rather than full-yesterday-vs-
        // partial-today which would always show today losing.
        from: asUtc(startOfDay(subDays(nowEt, 1))),
        to: new Date(now.getTime() - 86400_000),
        label: "Yesterday so far",
      },
      yesterday: {
        from: asUtc(startOfDay(twoDaysAgo)),
        to: asUtc(endOfDay(twoDaysAgo)),
        label: "Day before yesterday",
      },
      mtd: {
        // Same number of days at the start of last month.
        from: asUtc(startOfMonth(lmStart)),
        to: asUtc(
          endOfDay(
            new Date(
              lmStart.getFullYear(),
              lmStart.getMonth(),
              Math.min(
                nowEt.getDate(),
                endOfMonth(lmStart).getDate(),
              ),
            ),
          ),
        ),
        label: "Same MTD last month",
      },
      thisMonth: {
        from: asUtc(startOfMonth(lmStart)),
        to: asUtc(endOfMonth(lmStart)),
        label: "Last month (full)",
      },
      lastMonth: {
        from: asUtc(startOfMonth(monthBeforeLast)),
        to: asUtc(endOfMonth(monthBeforeLast)),
        label: "Month before last (full)",
      },
    };

    // Fire every window query in parallel — current + prior, all 5 periods.
    const [
      todayCur,
      todayPrior,
      yesterdayCur,
      yesterdayPrior,
      mtdCur,
      mtdPrior,
      thisMonthPrior,
      lastMonthCur,
      lastMonthPrior,
    ] = await Promise.all([
      summarizeWindow(w.today, channel, storeIndex),
      summarizeWindow(priorWindows.today, channel, storeIndex),
      summarizeWindow(w.yesterday, channel, storeIndex),
      summarizeWindow(priorWindows.yesterday, channel, storeIndex),
      summarizeWindow(w.mtd, channel, storeIndex),
      summarizeWindow(priorWindows.mtd, channel, storeIndex),
      // thisMonth current = mtd (they're the same set of orders); skip.
      summarizeWindow(priorWindows.thisMonth, channel, storeIndex),
      summarizeWindow(w.lastMonth, channel, storeIndex),
      summarizeWindow(priorWindows.lastMonth, channel, storeIndex),
    ]);

    // Forecast extrapolates current MTD pace through the rest of the
    // month. `daysElapsed` counts days INCLUDING today as fractional —
    // anchored on Eastern wall-clock to match the operator's day boundary.
    const monthStart = startOfMonth(nowEt);
    const monthEnd = endOfMonth(nowEt);
    const daysInMonth = differenceInDays(monthEnd, monthStart) + 1;
    const elapsedDays =
      differenceInDays(nowEt, monthStart) +
      (nowEt.getHours() * 60 + nowEt.getMinutes()) / (60 * 24);
    const scale = elapsedDays > 0 ? daysInMonth / Math.max(elapsedDays, 0.01) : 1;
    const thisMonthForecast: Summary = {
      revenue: Math.round(mtdCur.revenue * scale * 100) / 100,
      orders: Math.round(mtdCur.orders * scale),
      units: Math.round(mtdCur.units * scale),
      avgOrder: mtdCur.avgOrder,
      shipped: Math.round(mtdCur.shipped * scale),
      cancelled: Math.round(mtdCur.cancelled * scale),
    };

    return NextResponse.json({
      asOf: now.toISOString(),
      forecast: {
        daysInMonth,
        elapsedDays: Math.round(elapsedDays * 100) / 100,
        scale: Math.round(scale * 100) / 100,
      },
      tiles: {
        today: {
          label: w.today.label,
          summary: todayCur,
          prior: todayPrior,
          priorLabel: priorWindows.today.label,
        },
        yesterday: {
          label: w.yesterday.label,
          summary: yesterdayCur,
          prior: yesterdayPrior,
          priorLabel: priorWindows.yesterday.label,
        },
        mtd: {
          label: w.mtd.label,
          summary: mtdCur,
          prior: mtdPrior,
          priorLabel: priorWindows.mtd.label,
        },
        thisMonth: {
          label: w.thisMonth.label,
          summary: thisMonthForecast,
          prior: thisMonthPrior, // last full month
          priorLabel: priorWindows.thisMonth.label,
          isForecast: true,
        },
        lastMonth: {
          label: w.lastMonth.label,
          summary: lastMonthCur,
          prior: lastMonthPrior,
          priorLabel: priorWindows.lastMonth.label,
        },
      },
    });
  } catch (err) {
    console.error("[sales-overview/periods]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load periods" },
      { status: 500 },
    );
  }
}
