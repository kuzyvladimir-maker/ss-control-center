import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";

export async function GET() {
  try {
    const storeCount = [1, 2, 3, 4, 5].filter((i) =>
      getStoreCredentials(i)
    ).length;

    const [ordersCount, adjustCount, feedbackCount, claimsCount, lastSync] =
      await Promise.all([
        prisma.amazonOrder.count(),
        prisma.shippingAdjustment.count(),
        prisma.sellerFeedback.count(),
        prisma.atozzClaim.count(),
        prisma.syncLog.findFirst({
          where: { status: "done" },
          orderBy: { completedAt: "desc" },
        }),
      ]);

    // Per-store order counts
    const storeOrders: Record<number, number> = {};
    for (let i = 1; i <= 5; i++) {
      if (getStoreCredentials(i)) {
        storeOrders[i] = await prisma.amazonOrder.count({
          where: { storeIndex: i },
        });
      }
    }

    return NextResponse.json({
      stores: { configured: storeCount, total: 5 },
      data: {
        orders: { count: ordersCount, perStore: storeOrders },
        adjustments: { count: adjustCount },
        feedback: { count: feedbackCount },
        claims: { count: claimsCount },
      },
      lastSync: lastSync?.completedAt,
    });
  } catch (error) {
    console.error("[sync/status] GET failed:", error);
    return NextResponse.json(
      { error: "Failed to load sync status" },
      { status: 500 }
    );
  }
}
