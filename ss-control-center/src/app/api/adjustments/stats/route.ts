import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/adjustments/stats
 *
 * Returns the KPI numbers + carrier breakdown that drive the page header
 * cards and the carrier-filter chips. Honours the same filters the
 * table uses (channel, carrier, days) so the dashboard reacts to the
 * active filter.
 *
 * Query params:
 *   channel — Amazon | Walmart | "" (all)
 *   carrier — exact carrier match (e.g. FEDEX). "__none__" matches rows
 *             without a carrier on file. "" = all.
 *   days    — window for "thisMonth"/"last30Days" math + carrier dist
 *             (default 90, max 180)
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const channel = sp.get("channel") || "";
  const carrier = sp.get("carrier") || "";
  const days = Math.min(180, Math.max(7, parseInt(sp.get("days") || "90")));

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - days);

  const where: Record<string, unknown> = {
    createdAt: { gte: windowStart },
  };
  if (channel) where.channel = channel;
  if (carrier === "__none__") where.carrier = null;
  else if (carrier) where.carrier = carrier;

  const adjustments = await prisma.shippingAdjustment.findMany({ where });

  const thisMonthAdjs = adjustments.filter(
    (a) => a.createdAt >= monthStart,
  );
  const last30Adjs = adjustments.filter((a) => a.createdAt >= thirtyDaysAgo);

  const thisMonthTotal = thisMonthAdjs.reduce(
    (s, a) => s + a.adjustmentAmount,
    0,
  );
  const last30Total = last30Adjs.reduce(
    (s, a) => s + a.adjustmentAmount,
    0,
  );

  const amazonTotal = adjustments
    .filter((a) => a.channel === "Amazon")
    .reduce((s, a) => s + a.adjustmentAmount, 0);
  const walmartTotal = adjustments
    .filter((a) => a.channel === "Walmart")
    .reduce((s, a) => s + a.adjustmentAmount, 0);

  // Carrier breakdown — drives the filter chips. Unknown bucket = rows
  // with no carrier on file (Amazon's adjustment events don't expose
  // carrier; we backfill via the ShippingPlanItem join, which covers
  // ~40% of orders).
  const carrierAgg: Record<string, { count: number; total: number }> = {};
  for (const a of last30Adjs) {
    const key = a.carrier ?? "__none__";
    if (!carrierAgg[key]) carrierAgg[key] = { count: 0, total: 0 };
    carrierAgg[key].count++;
    carrierAgg[key].total += a.adjustmentAmount;
  }
  const carriers = Object.entries(carrierAgg)
    .map(([k, v]) => ({
      carrier: k,
      count: v.count,
      total: Math.round(v.total * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count);

  // Problematic SKUs — same logic as before but bound to current filter.
  const skuCounts: Record<string, number> = {};
  for (const a of last30Adjs) {
    if (a.sku) skuCounts[a.sku] = (skuCounts[a.sku] || 0) + 1;
  }
  const problematicSkus = Object.entries(skuCounts).filter(
    ([, c]) => c >= 3,
  ).length;

  return NextResponse.json({
    thisMonth: Math.round(thisMonthTotal * 100) / 100,
    thisMonthCount: thisMonthAdjs.length,
    last30Days: Math.round(last30Total * 100) / 100,
    last30Count: last30Adjs.length,
    amazonTotal: Math.round(amazonTotal * 100) / 100,
    walmartTotal: Math.round(walmartTotal * 100) / 100,
    problematicSkus,
    totalAll: adjustments.length,
    carriers,
    filtersApplied: { channel, carrier, days },
  });
}
