import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const now = new Date();

  // This month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // Last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [thisMonthAdjs, last30Adjs, allAdjs] = await Promise.all([
    prisma.shippingAdjustment.findMany({
      where: { createdAt: { gte: monthStart } },
    }),
    prisma.shippingAdjustment.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.shippingAdjustment.findMany(),
  ]);

  const thisMonthTotal = thisMonthAdjs.reduce(
    (s, a) => s + a.adjustmentAmount,
    0
  );
  const last30Total = last30Adjs.reduce(
    (s, a) => s + a.adjustmentAmount,
    0
  );

  // By channel
  const amazonTotal = allAdjs
    .filter((a) => a.channel === "Amazon")
    .reduce((s, a) => s + a.adjustmentAmount, 0);
  const walmartTotal = allAdjs
    .filter((a) => a.channel === "Walmart")
    .reduce((s, a) => s + a.adjustmentAmount, 0);

  // Problematic SKUs (3+ adjustments in 30 days)
  const skuCounts: Record<string, number> = {};
  for (const a of last30Adjs) {
    if (a.sku) {
      skuCounts[a.sku] = (skuCounts[a.sku] || 0) + 1;
    }
  }
  const problematicSkus = Object.entries(skuCounts)
    .filter(([, count]) => count >= 3)
    .length;

  return NextResponse.json({
    thisMonth: Math.round(thisMonthTotal * 100) / 100,
    thisMonthCount: thisMonthAdjs.length,
    last30Days: Math.round(last30Total * 100) / 100,
    last30Count: last30Adjs.length,
    amazonTotal: Math.round(amazonTotal * 100) / 100,
    walmartTotal: Math.round(walmartTotal * 100) / 100,
    problematicSkus,
    totalAll: allAdjs.length,
  });
}
