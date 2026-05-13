import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toZonedTime } from "date-fns-tz";
import {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  subDays,
  subMonths,
  getDaysInMonth,
} from "date-fns";

const TZ = "America/New_York";

// Status values that mean "doesn't count toward gross revenue". Amazon spells
// it "Canceled" (US), Walmart "Cancelled" (UK) — keep both.
const CANCELLED_AMAZON = ["Canceled", "Cancelled"];
const CANCELLED_WALMART = ["Cancelled", "Canceled"];

interface PeriodSeed {
  date: Date;
  total: number;
}

interface ComparisonResult {
  vs: string;
  baseline: number;
  percent: number | null;
}

interface PeriodResult {
  value: number;
  comparison: ComparisonResult | null;
}

interface ForecastResult extends PeriodResult {
  meta: {
    daysPassed: number;
    daysInMonth: number;
    method: "linear";
    reason?: string;
  };
}

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl;
    const storeIdsParam = url.searchParams.get("storeIds");
    const storeIds = storeIdsParam
      ? storeIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : null;

    // Explicit empty selection → zeroes, no DB hit.
    if (storeIds && storeIds.length === 0) {
      return NextResponse.json(emptyResponse([]));
    }

    const stores = storeIds
      ? await prisma.store.findMany({ where: { id: { in: storeIds } } })
      : await prisma.store.findMany({ where: { active: true } });

    const amazonStoreIndexes = stores
      .filter((s) => s.channel === "Amazon" && s.storeIndex != null)
      .map((s) => s.storeIndex as number);
    const walmartSelected = stores.some((s) => s.channel === "Walmart");
    // Walmart in this project is currently a single seller, so any Walmart
    // store in selection turns the Walmart query on. If/when a second Walmart
    // account is added, swap this for a storeIndex filter analogous to Amazon.

    // Periods (all in ET).
    const nowEt = toZonedTime(new Date(), TZ);
    const todayStart = startOfDay(nowEt);
    const yesterdayStart = startOfDay(subDays(nowEt, 1));
    const yesterdayEnd = endOfDay(subDays(nowEt, 1));
    const sameDayLastWeekStart = startOfDay(subDays(nowEt, 7));
    const sameDayLastWeekEnd = endOfDay(subDays(nowEt, 7));
    const monthStart = startOfMonth(nowEt);
    const lastMonthStart = startOfMonth(subMonths(nowEt, 1));
    const lastMonthEnd = endOfMonth(subMonths(nowEt, 1));
    // MTD comparison: last month from the 1st up to the *same day-of-month*
    // we're at today. Capped to lastMonthEnd so the 31st of a 30-day month
    // doesn't overflow.
    const lastMonthSamePeriodEndRaw = new Date(lastMonthStart);
    lastMonthSamePeriodEndRaw.setDate(
      Math.min(nowEt.getDate(), getDaysInMonth(lastMonthStart))
    );
    const lastMonthSamePeriodEnd = endOfDay(lastMonthSamePeriodEndRaw);

    // Single sweep covers the widest needed window (start of last month).
    const earliestDate = lastMonthStart;

    const [amazonOrders, walmartOrders] = await Promise.all([
      amazonStoreIndexes.length > 0
        ? prisma.amazonOrder.findMany({
            where: {
              storeIndex: { in: amazonStoreIndexes },
              purchaseDate: { gte: earliestDate, lte: nowEt },
              status: { notIn: CANCELLED_AMAZON },
            },
            select: { purchaseDate: true, orderTotal: true },
          })
        : Promise.resolve([]),
      walmartSelected
        ? prisma.walmartOrder.findMany({
            where: {
              orderDate: { gte: earliestDate, lte: nowEt },
              status: { notIn: CANCELLED_WALMART },
            },
            select: { orderDate: true, orderTotal: true },
          })
        : Promise.resolve([]),
    ]);

    const amzSeed: PeriodSeed[] = amazonOrders.map((o) => ({
      date: o.purchaseDate,
      total: o.orderTotal || 0,
    }));
    const wmtSeed: PeriodSeed[] = walmartOrders.map((o) => ({
      date: o.orderDate,
      total: o.orderTotal || 0,
    }));
    const allSeed = [...amzSeed, ...wmtSeed];

    const periods = buildPeriods(allSeed, {
      todayStart,
      nowEt,
      yesterdayStart,
      yesterdayEnd,
      sameDayLastWeekStart,
      sameDayLastWeekEnd,
      monthStart,
      lastMonthStart,
      lastMonthEnd,
      lastMonthSamePeriodEnd,
    });

    const amazonBreakdown = amzSeed.length
      ? buildPeriods(amzSeed, {
          todayStart,
          nowEt,
          yesterdayStart,
          yesterdayEnd,
          sameDayLastWeekStart,
          sameDayLastWeekEnd,
          monthStart,
          lastMonthStart,
          lastMonthEnd,
          lastMonthSamePeriodEnd,
        })
      : null;

    const walmartBreakdown = wmtSeed.length
      ? buildPeriods(wmtSeed, {
          todayStart,
          nowEt,
          yesterdayStart,
          yesterdayEnd,
          sameDayLastWeekStart,
          sameDayLastWeekEnd,
          monthStart,
          lastMonthStart,
          lastMonthEnd,
          lastMonthSamePeriodEnd,
        })
      : null;

    return NextResponse.json({
      ...periods,
      breakdown: {
        amazon: amazonBreakdown,
        walmart: walmartBreakdown,
      },
      meta: {
        tz: TZ,
        asOf: new Date().toISOString(),
        storeIdsApplied: stores.map((s) => s.id),
      },
    });
  } catch (err) {
    console.error("[/api/dashboard/sales]", err);
    return NextResponse.json(
      { error: "Failed to load sales summary" },
      { status: 500 }
    );
  }
}

function buildPeriods(
  seed: PeriodSeed[],
  windows: {
    todayStart: Date;
    nowEt: Date;
    yesterdayStart: Date;
    yesterdayEnd: Date;
    sameDayLastWeekStart: Date;
    sameDayLastWeekEnd: Date;
    monthStart: Date;
    lastMonthStart: Date;
    lastMonthEnd: Date;
    lastMonthSamePeriodEnd: Date;
  }
): {
  today: PeriodResult;
  yesterday: PeriodResult;
  mtd: PeriodResult;
  lastMonth: PeriodResult;
  forecast: ForecastResult;
} {
  const sumInRange = (from: Date, to: Date) =>
    seed
      .filter((o) => o.date >= from && o.date <= to)
      .reduce((sum, o) => sum + (o.total || 0), 0);

  const today = sumInRange(windows.todayStart, windows.nowEt);
  const yesterday = sumInRange(windows.yesterdayStart, windows.yesterdayEnd);
  const sameDayLastWeek = sumInRange(
    windows.sameDayLastWeekStart,
    windows.sameDayLastWeekEnd
  );
  const mtd = sumInRange(windows.monthStart, windows.nowEt);
  const lastMonth = sumInRange(windows.lastMonthStart, windows.lastMonthEnd);
  const lastMonthSamePeriod = sumInRange(
    windows.lastMonthStart,
    windows.lastMonthSamePeriodEnd
  );

  // Forecast: simple linear projection of MTD onto the full month.
  // Requires at least 1 full day of data.
  const dayOfMonth = windows.nowEt.getDate();
  const hourFraction =
    (windows.nowEt.getHours() + windows.nowEt.getMinutes() / 60) / 24;
  const daysPassed = dayOfMonth - 1 + hourFraction;
  const daysInMonth = getDaysInMonth(windows.nowEt);

  let forecast: ForecastResult;
  if (daysPassed >= 1) {
    const value = (mtd / daysPassed) * daysInMonth;
    forecast = {
      value,
      comparison: {
        vs: "lastMonth",
        baseline: lastMonth,
        percent: pct(value, lastMonth),
      },
      meta: {
        daysPassed: Number(daysPassed.toFixed(2)),
        daysInMonth,
        method: "linear",
      },
    };
  } else {
    forecast = {
      value: 0,
      comparison: null,
      meta: {
        daysPassed: Number(daysPassed.toFixed(2)),
        daysInMonth,
        method: "linear",
        reason: "Need at least 1 full day of MTD data",
      },
    };
  }

  return {
    today: {
      value: today,
      comparison: {
        vs: "yesterday",
        baseline: yesterday,
        percent: pct(today, yesterday),
      },
    },
    yesterday: {
      value: yesterday,
      comparison: {
        vs: "sameDayLastWeek",
        baseline: sameDayLastWeek,
        percent: pct(yesterday, sameDayLastWeek),
      },
    },
    mtd: {
      value: mtd,
      comparison: {
        vs: "lastMonthSamePeriod",
        baseline: lastMonthSamePeriod,
        percent: pct(mtd, lastMonthSamePeriod),
      },
    },
    lastMonth: {
      value: lastMonth,
      comparison: null,
    },
    forecast,
  };
}

function pct(current: number, baseline: number): number | null {
  if (!baseline || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

function emptyResponse(storeIdsApplied: string[]) {
  return {
    today: { value: 0, comparison: null },
    yesterday: { value: 0, comparison: null },
    mtd: { value: 0, comparison: null },
    lastMonth: { value: 0, comparison: null },
    forecast: {
      value: 0,
      comparison: null,
      meta: {
        daysPassed: 0,
        daysInMonth: 30,
        method: "linear" as const,
        reason: "No stores selected",
      },
    },
    breakdown: { amazon: null, walmart: null },
    meta: {
      tz: TZ,
      asOf: new Date().toISOString(),
      storeIdsApplied,
    },
  };
}
