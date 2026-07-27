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
  getDaysInMonth,
} from "date-fns";

const TZ = "America/New_York";

/**
 * date-fns-tz's `toZonedTime` returns a Date whose `getTime()` is shifted
 * by the timezone offset so that the wall-clock readers (`getHours()`,
 * `startOfDay`, etc) report values in the target TZ. That's only useful
 * for *formatting* — its UTC representation is fictional and will yield
 * wrong answers when compared against real UTC timestamps in the DB.
 *
 * Every window boundary we feed into the Prisma query has to be a real
 * UTC instant. We compute boundaries by:
 *   1. converting `now` into the zoned (wall-clock) Date,
 *   2. applying date-fns calendar arithmetic on the zoned Date,
 *   3. converting back to a real UTC instant with `fromZonedTime`.
 *
 * The bug this fixes: Sales today permanently read $0 in the live
 * dashboard because the upper bound on the `purchaseDate` filter was the
 * zoned `nowEt` (epoch shifted -4h during EDT). Orders that landed in
 * the last 4 hours of real time had `purchaseDate > nowEt` and got
 * excluded.
 */
function asUtc(zoned: Date): Date {
  return fromZonedTime(zoned, TZ);
}

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
  /** Order count in this window (non-cancelled). Surfaced on the
   *  dashboard card so the operator sees both money + volume at a
   *  glance — important when avg basket value swings day to day. */
  count?: number;
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

    // Periods — compute wall-clock ET boundaries, then convert each back
    // to a real UTC instant for the DB query. See `asUtc` above for the
    // bug this avoids. Forecast math needs the wall-clock `nowEt` (so
    // `dayOfMonth` reflects ET, not UTC); the SQL bounds use the
    // converted UTC values.
    const realNow = new Date();
    const nowEt = toZonedTime(realNow, TZ);
    const todayStart = asUtc(startOfDay(nowEt));
    const yesterdayStart = asUtc(startOfDay(subDays(nowEt, 1)));
    const yesterdayEnd = asUtc(endOfDay(subDays(nowEt, 1)));
    const sameDayLastWeekStart = asUtc(startOfDay(subDays(nowEt, 7)));
    const sameDayLastWeekEnd = asUtc(endOfDay(subDays(nowEt, 7)));
    const monthStart = asUtc(startOfMonth(nowEt));
    const lastMonthStartZoned = startOfMonth(subMonths(nowEt, 1));
    const lastMonthStart = asUtc(lastMonthStartZoned);
    const lastMonthEnd = asUtc(endOfMonth(subMonths(nowEt, 1)));
    // MTD comparison: last month from the 1st up to the *same day-of-month*
    // we're at today. Capped to lastMonthEnd so the 31st of a 30-day month
    // doesn't overflow.
    const lastMonthSamePeriodEndZoned = new Date(lastMonthStartZoned);
    lastMonthSamePeriodEndZoned.setDate(
      Math.min(nowEt.getDate(), getDaysInMonth(lastMonthStartZoned))
    );
    const lastMonthSamePeriodEnd = asUtc(
      endOfDay(lastMonthSamePeriodEndZoned)
    );

    // Single sweep covers the widest needed window (start of last month).
    const earliestDate = lastMonthStart;

    const [amazonOrders, walmartOrders] = await Promise.all([
      amazonStoreIndexes.length > 0
        ? prisma.amazonOrder.findMany({
            where: {
              storeIndex: { in: amazonStoreIndexes },
              purchaseDate: { gte: earliestDate, lte: realNow },
              status: { notIn: CANCELLED_AMAZON },
            },
            select: { purchaseDate: true, orderTotal: true },
          })
        : Promise.resolve([]),
      walmartSelected
        ? prisma.walmartOrder.findMany({
            where: {
              orderDate: { gte: earliestDate, lte: realNow },
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

    const windows = {
      todayStart,
      realNow,
      nowEt,
      yesterdayStart,
      yesterdayEnd,
      sameDayLastWeekStart,
      sameDayLastWeekEnd,
      monthStart,
      lastMonthStart,
      lastMonthEnd,
      lastMonthSamePeriodEnd,
    };

    const periods = buildPeriods(allSeed, windows);
    const amazonBreakdown = amzSeed.length
      ? buildPeriods(amzSeed, windows)
      : null;
    const walmartBreakdown = wmtSeed.length
      ? buildPeriods(wmtSeed, windows)
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
    /** Real UTC `now` — used as the upper bound for any open-ended
     *  period (today, MTD). Must be the actual current instant, not
     *  the zoned wall-clock version. */
    realNow: Date;
    /** Wall-clock ET version of `now`. Used only for forecast math
     *  where we need the ET date components (day-of-month, hour-of-day). */
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
  const inRange = (from: Date, to: Date) =>
    seed.filter((o) => o.date >= from && o.date <= to);
  const sumInRange = (from: Date, to: Date) =>
    inRange(from, to).reduce((sum, o) => sum + (o.total || 0), 0);
  const countInRange = (from: Date, to: Date) => inRange(from, to).length;

  const today = sumInRange(windows.todayStart, windows.realNow);
  const todayCount = countInRange(windows.todayStart, windows.realNow);
  const yesterday = sumInRange(windows.yesterdayStart, windows.yesterdayEnd);
  const yesterdayCount = countInRange(windows.yesterdayStart, windows.yesterdayEnd);
  const sameDayLastWeek = sumInRange(
    windows.sameDayLastWeekStart,
    windows.sameDayLastWeekEnd
  );
  const mtd = sumInRange(windows.monthStart, windows.realNow);
  const mtdCount = countInRange(windows.monthStart, windows.realNow);
  const lastMonth = sumInRange(windows.lastMonthStart, windows.lastMonthEnd);
  const lastMonthCount = countInRange(windows.lastMonthStart, windows.lastMonthEnd);
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
      count: todayCount,
      comparison: {
        vs: "yesterday",
        baseline: yesterday,
        percent: pct(today, yesterday),
      },
    },
    yesterday: {
      value: yesterday,
      count: yesterdayCount,
      comparison: {
        vs: "sameDayLastWeek",
        baseline: sameDayLastWeek,
        percent: pct(yesterday, sameDayLastWeek),
      },
    },
    mtd: {
      value: mtd,
      count: mtdCount,
      comparison: {
        vs: "lastMonthSamePeriod",
        baseline: lastMonthSamePeriod,
        percent: pct(mtd, lastMonthSamePeriod),
      },
    },
    lastMonth: {
      value: lastMonth,
      count: lastMonthCount,
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
