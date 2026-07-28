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
} from "date-fns";

const TZ = "America/New_York";

/** date-fns-tz wall-clock Date → real UTC instant. See the longer note in
 *  /api/dashboard/sales/route.ts for why this conversion is required. */
function asUtc(zoned: Date): Date {
  return fromZonedTime(zoned, TZ);
}

type Period = "today" | "yesterday" | "mtd" | "lastMonth" | "forecast";

/** Map a dashboard sales-card period to a (from, to) UTC window plus a
 *  human-readable label the analytics page can show. */
function periodWindow(
  period: Period,
  now: Date
): { from: Date; to: Date; label: string } {
  const nowEt = toZonedTime(now, TZ);
  switch (period) {
    case "today":
      return {
        from: asUtc(startOfDay(nowEt)),
        to: now,
        label: "Today",
      };
    case "yesterday": {
      const yesterday = subDays(nowEt, 1);
      return {
        from: asUtc(startOfDay(yesterday)),
        to: asUtc(endOfDay(yesterday)),
        label: "Yesterday",
      };
    }
    case "mtd":
      return {
        from: asUtc(startOfMonth(nowEt)),
        to: now,
        label: "Month to date",
      };
    case "lastMonth": {
      const lastMonthAnchor = subMonths(nowEt, 1);
      return {
        from: asUtc(startOfMonth(lastMonthAnchor)),
        to: asUtc(endOfMonth(lastMonthAnchor)),
        label: "Last month",
      };
    }
    case "forecast":
      // Forecast isn't an order-window itself — surface MTD orders so
      // the page is still useful when the user lands here from the
      // Forecast card.
      return {
        from: asUtc(startOfMonth(nowEt)),
        to: now,
        label: "Forecast (MTD basis)",
      };
  }
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const storeIndex = sp.get("store") ? parseInt(sp.get("store")!) : null;
    const periodParam = sp.get("period") as Period | null;
    const days = parseInt(sp.get("days") || "30");

    const now = new Date();
    let from: Date;
    let to: Date;
    let label: string;
    if (periodParam) {
      const win = periodWindow(periodParam, now);
      from = win.from;
      to = win.to;
      label = win.label;
    } else {
      from = new Date(Date.now() - days * 86400000);
      to = now;
      label = `Last ${days} days`;
    }

    const where = {
      purchaseDate: { gte: from, lte: to },
      ...(storeIndex ? { storeIndex } : {}),
    };

    // All orders in window
    const orders = await prisma.amazonOrder.findMany({
      where,
      orderBy: { purchaseDate: "asc" },
    });

    // === Revenue by day ===
    const revenueByDay: Record<string, { revenue: number; count: number }> = {};
    for (const o of orders) {
      const day = o.purchaseDate.toISOString().split("T")[0];
      if (!revenueByDay[day]) revenueByDay[day] = { revenue: 0, count: 0 };
      revenueByDay[day].revenue += o.orderTotal;
      revenueByDay[day].count++;
    }

    // Fill missing days with 0 — bounded by [from, to] so a single-day
    // period (today / yesterday) doesn't render 30 empty rows.
    const dailyRevenue: { date: string; revenue: number; orders: number }[] = [];
    const cursor = new Date(from);
    while (cursor <= to) {
      const key = cursor.toISOString().split("T")[0];
      const entry = revenueByDay[key] || { revenue: 0, count: 0 };
      dailyRevenue.push({
        date: key,
        revenue: Math.round(entry.revenue * 100) / 100,
        orders: entry.count,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    // === Orders by status ===
    const statusCounts: Record<string, number> = {};
    for (const o of orders) {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    }
    const byStatus = Object.entries(statusCounts)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    // === Summary ===
    const totalRevenue = orders.reduce((s, o) => s + o.orderTotal, 0);
    const totalOrders = orders.length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const shipped = orders.filter((o) => o.status === "Shipped").length;
    const cancelled = orders.filter((o) => o.status === "Canceled").length;

    return NextResponse.json({
      summary: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalOrders,
        avgOrderValue: Math.round(avgOrderValue * 100) / 100,
        shipped,
        cancelled,
      },
      dailyRevenue,
      byStatus,
      period: {
        // Legacy `days` for back-compat with older callers that read it.
        days: Math.max(
          1,
          Math.round((to.getTime() - from.getTime()) / 86400000)
        ),
        from: from.toISOString(),
        to: to.toISOString(),
        label,
        kind: periodParam ?? "days",
      },
    });
  } catch (error) {
    console.error("Sales analytics error:", error);
    return NextResponse.json({
      summary: {
        totalRevenue: 0,
        totalOrders: 0,
        avgOrderValue: 0,
        shipped: 0,
        cancelled: 0,
      },
      dailyRevenue: [],
      byStatus: [],
      period: { days: 30, label: "Last 30 days", kind: "days" },
    });
  }
}
