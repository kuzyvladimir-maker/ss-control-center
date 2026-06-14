/**
 * GET /api/amazon/growth/buybox
 *
 * Featured Offer (Buy Box) view, derived from the Sales & Traffic enrichment
 * (buyBoxPercentage per ASIN). Returns a win-rate summary + the listings that
 * lose the Featured Offer most, ranked by traffic at risk (sessions).
 *
 * Query: storeIndex (default 1), limit (default 50, max 200), offset.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);
  const offset = Number(sp.get("offset") ?? 0);

  const withSignal = { storeIndex, buyBoxPercentage: { not: null } };
  const [total, losing, agg, rows, matched] = await Promise.all([
    prisma.amazonListingHealthItem.count({ where: withSignal }),
    prisma.amazonListingHealthItem.count({ where: { ...withSignal, buyBoxPercentage: { lt: 90 } } }),
    prisma.amazonListingHealthItem.aggregate({ where: withSignal, _avg: { buyBoxPercentage: true } }),
    prisma.amazonListingHealthItem.findMany({
      where: { ...withSignal, buyBoxPercentage: { lt: 90 } },
      orderBy: [{ sessions30d: "desc" }, { buyBoxPercentage: "asc" }],
      take: limit,
      skip: offset,
    }),
    prisma.amazonListingHealthItem.count({ where: { ...withSignal, buyBoxPercentage: { lt: 90 } } }),
  ]);

  return NextResponse.json({
    storeIndex,
    summary: {
      totalWithSignal: total,
      losing,
      avgBuyBoxPct: agg._avg.buyBoxPercentage != null ? Math.round(agg._avg.buyBoxPercentage * 10) / 10 : null,
    },
    items: rows.map((r) => ({
      sku: r.sku,
      asin: r.asin,
      itemName: r.itemName,
      buyBoxPercentage: r.buyBoxPercentage,
      sessions30d: r.sessions30d,
      unitsOrdered30d: r.unitsOrdered30d,
      unitSessionPct: r.unitSessionPct,
    })),
    worklist: { total: matched, limit, offset },
  });
}
