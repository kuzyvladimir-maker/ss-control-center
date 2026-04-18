import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
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
    ]);

    // Health issues from latest snapshots (dedup by storeId)
    const latestByStore = new Map<string, (typeof healthSnapshots)[0]>();
    for (const snap of healthSnapshots) {
      if (!latestByStore.has(snap.storeId)) latestByStore.set(snap.storeId, snap);
    }
    const healthIssues = Array.from(latestByStore.values()).filter(
      (s) => s.status === "critical" || s.status === "warning"
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
