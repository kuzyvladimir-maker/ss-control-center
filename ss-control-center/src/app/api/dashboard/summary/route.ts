import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const [
      totalOrders,
      awaitingShipment,
      shippedToday,
      openCsCases,
      activeClaims,
      healthSnapshots,
      adjustmentsSum,
      ordersStore1,
      ordersStore2,
      // Walmart
      walmartOrdersTotal30d,
      walmartOrdersToday,
      walmartReturnsRecent,
      walmartRefundsSum7d,
      walmartPerfLatest,
    ] = await Promise.all([
      prisma.amazonOrder.count({
        where: { purchaseDate: { gte: thirtyDaysAgo } },
      }),
      prisma.amazonOrder.count({ where: { status: "Unshipped" } }),
      prisma.amazonOrder.count({
        where: {
          status: "Shipped",
          lastUpdateDate: { gte: todayStart },
        },
      }),
      prisma.csCase.count({ where: { status: "open" } }),
      prisma.atozzClaim.count({
        where: {
          status: {
            in: ["NEW", "EVIDENCE_GATHERED", "RESPONSE_READY", "SUBMITTED"],
          },
        },
      }),
      prisma.accountHealthSnapshot.findMany({
        where: { syncStatus: "done" },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      prisma.shippingAdjustment.aggregate({
        _sum: { adjustmentAmount: true },
        where: { createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.amazonOrder.count({ where: { storeIndex: 1 } }),
      prisma.amazonOrder.count({ where: { storeIndex: 2 } }),
      prisma.walmartOrder.count({
        where: { orderDate: { gte: thirtyDaysAgo } },
      }),
      prisma.walmartOrder.count({
        where: { orderDate: { gte: todayStart } },
      }),
      prisma.buyerMessage.count({
        where: {
          channel: "Walmart",
          walmartReturnId: { not: null },
          status: { in: ["NEW", "ANALYZED"] },
        },
      }),
      prisma.walmartReconTransaction.aggregate({
        _sum: { amount: true },
        where: {
          transactionType: "Refunds",
          transactionPostedTimestamp: { gte: sevenDaysAgo },
        },
      }),
      prisma.walmartPerformanceSnapshot.findMany({
        orderBy: { capturedAt: "desc" },
        take: 50,
      }),
    ]);

    // Health issues from latest Amazon snapshots (dedup by storeId)
    const latestByStore = new Map<string, (typeof healthSnapshots)[0]>();
    for (const snap of healthSnapshots) {
      if (!latestByStore.has(snap.storeId)) latestByStore.set(snap.storeId, snap);
    }
    const healthIssues = Array.from(latestByStore.values()).filter(
      (s) => s.status === "critical" || s.status === "warning"
    ).length;

    // Walmart Performance: latest snapshot per (windowDays, metric); count
    // those flagged unhealthy.
    const latestPerf = new Map<string, (typeof walmartPerfLatest)[number]>();
    for (const s of walmartPerfLatest) {
      const key = `${s.windowDays}|${s.metric}`;
      if (!latestPerf.has(key)) latestPerf.set(key, s);
    }
    const walmartHealthIssues = Array.from(latestPerf.values()).filter(
      (s) => !s.isHealthy
    ).length;

    return NextResponse.json({
      orders: {
        total30d: totalOrders,
        awaitingShipment,
        shippedToday,
        store1: ordersStore1,
        store2: ordersStore2,
      },
      customerService: { openCases: openCsCases },
      claims: { active: activeClaims },
      health: { issues: healthIssues },
      adjustments: {
        monthlyTotal: adjustmentsSum._sum.adjustmentAmount || 0,
      },
      walmart: {
        ordersTotal30d: walmartOrdersTotal30d,
        ordersToday: walmartOrdersToday,
        returnsPending: walmartReturnsRecent,
        refundsLast7d: Math.abs(walmartRefundsSum7d._sum.amount || 0),
        healthIssues: walmartHealthIssues,
        healthStatus:
          walmartPerfLatest.length === 0
            ? "no-data"
            : walmartHealthIssues === 0
              ? "healthy"
              : walmartHealthIssues < 3
                ? "warning"
                : "critical",
      },
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[dashboard/summary] GET failed:", error);
    return NextResponse.json(
      {
        error: "Failed to load dashboard summary",
      },
      { status: 500 }
    );
  }
}
