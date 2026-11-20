/**
 * GET /api/dashboard/charts?storeIds=…
 *
 * Series behind the Dashboard charts (2026-11-20, owner request):
 *   - daily    — sales $ and order count per ET day, ~6 months back, so the
 *                client can switch 7/30/90 days (+ the previous period of
 *                the same length) and derive monthly sparkline totals
 *                without another round trip;
 *   - hourly   — cumulative orders/sales by ET hour, today vs yesterday —
 *                explains a "Sales today" number taken mid-morning;
 *   - weekly   — frozen orders flagged at risk and Adjustments charged per
 *                week (Mon-start, ET), last 12 weeks.
 *
 * Only real rows: same store selection and cancelled-order rule as
 * /api/dashboard/sales, so a chart total always matches its sales card.
 * Days without orders are real zeros (the feed is checked via `feed`);
 * the client shows an empty state with the reason when a series has no rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { prismaReports as prisma } from "@/lib/prisma";
import { BOARD_STORE_IDS } from "@/lib/adjustments/dispute-board";

const TZ = "America/New_York";
const CANCELLED = ["Canceled", "Cancelled"];
const DAY_MS = 86400000;

const ymdFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const hourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "numeric",
  hourCycle: "h23",
});
const ymdET = (d: Date) => ymdFmt.format(d);
const hourET = (d: Date) => Number(hourFmt.format(d)) % 24;

// Calendar arithmetic on plain YYYY-MM-DD strings (noon UTC avoids DST edges).
function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
function mondayOf(ymd: string): string {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 = Sun
  return addDays(ymd, -((dow + 6) % 7));
}

export async function GET(request: NextRequest) {
  try {
    const raw = request.nextUrl.searchParams.get("storeIds");
    const storeIds = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const stores = storeIds
      ? await prisma.store.findMany({ where: { id: { in: storeIds } } })
      : await prisma.store.findMany({ where: { active: true } });
    const amazonIdx = stores
      .filter((s) => s.channel === "Amazon" && s.storeIndex != null)
      .map((s) => s.storeIndex as number);
    const walmartSelected = stores.some((s) => s.channel === "Walmart");

    const now = new Date();
    const today = ymdET(now);
    const yesterday = addDays(today, -1);
    // 180 days covers 90d + the previous 90d; start of the month five
    // months back covers the Forecast card's monthly sparkline.
    const monthsBack = (() => {
      const [y, m] = today.split("-").map(Number);
      const d = new Date(Date.UTC(y, m - 1 - 5, 1, 12));
      return d.toISOString().slice(0, 10);
    })();
    const firstDay = [addDays(today, -179), monthsBack].sort()[0];
    // A day earlier in UTC so the first ET day is complete.
    const since = new Date(Date.parse(`${firstDay}T00:00:00Z`) - DAY_MS);
    const firstWeek = addDays(mondayOf(today), -7 * 11);

    const [amazon, walmart, frozen, adjustments] = await Promise.all([
      amazonIdx.length
        ? prisma.amazonOrder.findMany({
            where: {
              storeIndex: { in: amazonIdx },
              purchaseDate: { gte: since, lte: now },
              status: { notIn: CANCELLED },
            },
            select: { purchaseDate: true, orderTotal: true },
          })
        : Promise.resolve([]),
      walmartSelected
        ? prisma.walmartOrder.findMany({
            where: { orderDate: { gte: since, lte: now }, status: { notIn: CANCELLED } },
            select: { orderDate: true, orderTotal: true },
          })
        : Promise.resolve([]),
      prisma.frozenRiskAlert.findMany({
        where: {
          shipDate: { gte: firstWeek, lte: today },
          ...(amazonIdx.length ? { OR: [{ storeIndex: { in: amazonIdx } }, { storeIndex: null }] } : {}),
        },
        select: { shipDate: true, riskLevel: true },
      }),
      prisma.shippingAdjustment.findMany({
        where: {
          channel: "Amazon",
          storeId: { in: BOARD_STORE_IDS },
          adjustmentAmount: { lt: 0 },
          adjustmentDate: { gte: firstWeek },
        },
        select: { adjustmentDate: true, adjustmentAmount: true },
      }),
    ]);

    const orders = [
      ...amazon.map((o) => ({ at: o.purchaseDate, total: o.orderTotal || 0 })),
      ...walmart.map((o) => ({ at: o.orderDate, total: o.orderTotal || 0 })),
    ];

    // Daily buckets, every day present (a day with no orders is a real 0).
    const daily = new Map<string, { sales: number; orders: number }>();
    for (let d = firstDay; d <= today; d = addDays(d, 1)) daily.set(d, { sales: 0, orders: 0 });
    // Hourly, cumulative later.
    const hourly = {
      today: Array.from({ length: 24 }, () => ({ orders: 0, sales: 0 })),
      yesterday: Array.from({ length: 24 }, () => ({ orders: 0, sales: 0 })),
    };
    for (const o of orders) {
      const day = ymdET(o.at);
      const b = daily.get(day);
      if (b) {
        b.sales += o.total;
        b.orders += 1;
      }
      if (day === today || day === yesterday) {
        const h = hourly[day === today ? "today" : "yesterday"][hourET(o.at)];
        h.orders += 1;
        h.sales += o.total;
      }
    }
    const cumulative = (rows: { orders: number; sales: number }[]) => {
      let o = 0;
      let s = 0;
      return rows.map((r) => ({ orders: (o += r.orders), sales: Math.round((s += r.sales) * 100) / 100 }));
    };

    // Weekly buckets (Mon-start), oldest first.
    const weeks: string[] = [];
    for (let w = firstWeek; w <= today; w = addDays(w, 7)) weeks.push(w);
    const frozenWeekly = new Map(weeks.map((w) => [w, { total: 0, elevated: 0 }]));
    for (const a of frozen) {
      const b = frozenWeekly.get(mondayOf(a.shipDate));
      if (!b) continue;
      b.total += 1;
      if (["medium", "high", "critical"].includes(a.riskLevel)) b.elevated += 1;
    }
    const adjWeekly = new Map(weeks.map((w) => [w, { amount: 0, count: 0 }]));
    for (const a of adjustments) {
      const b = adjWeekly.get(mondayOf(String(a.adjustmentDate).slice(0, 10)));
      if (!b) continue;
      b.amount += Math.abs(a.adjustmentAmount ?? 0);
      b.count += 1;
    }

    return NextResponse.json({
      today,
      nowHour: hourET(now),
      daily: [...daily.entries()].map(([date, v]) => ({
        date,
        sales: Math.round(v.sales * 100) / 100,
        orders: v.orders,
      })),
      hourly: {
        today: cumulative(hourly.today),
        yesterday: cumulative(hourly.yesterday),
      },
      weekly: {
        frozen: weeks.map((w) => ({ week: w, ...frozenWeekly.get(w)! })),
        adjustments: weeks.map((w) => ({
          week: w,
          amount: Math.round(adjWeekly.get(w)!.amount * 100) / 100,
          count: adjWeekly.get(w)!.count,
        })),
      },
      feed: {
        orderRows: orders.length,
        frozenRows: frozen.length,
        adjustmentRows: adjustments.length,
        storeIndexes: amazonIdx,
      },
      asOf: now.toISOString(),
    });
  } catch (err) {
    console.error("[/api/dashboard/charts]", err);
    return NextResponse.json({ error: "Failed to load chart data" }, { status: 500 });
  }
}
