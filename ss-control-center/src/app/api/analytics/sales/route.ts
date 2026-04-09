import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const storeIndex = sp.get("store") ? parseInt(sp.get("store")!) : null;
    const days = parseInt(sp.get("days") || "30");

    const since = new Date(Date.now() - days * 86400000);

    const where = {
      purchaseDate: { gte: since },
      ...(storeIndex ? { storeIndex } : {}),
    };

    // All orders in period
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

    // Fill missing days with 0
    const dailyRevenue: { date: string; revenue: number; orders: number }[] = [];
    const cursor = new Date(since);
    const now = new Date();
    while (cursor <= now) {
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
      period: { days, from: since.toISOString(), to: now.toISOString() },
    });
  } catch (error) {
    console.error("Sales analytics error:", error);
    return NextResponse.json({
      summary: { totalRevenue: 0, totalOrders: 0, avgOrderValue: 0, shipped: 0, cancelled: 0 },
      dailyRevenue: [],
      byStatus: [],
      period: { days: 30 },
    });
  }
}
