/**
 * GET /api/walmart/growth/buybox
 *
 * Buy Box read surface for the Walmart Growth page:
 *   - report: latest report request status (so the UI shows "generating…")
 *   - rollup: total / winning / losing counts + total $ price-gap we'd need to
 *     close to win the losing ones
 *   - items: the losers, worst price-gap first (the actionable list)
 *
 * Query: storeIndex (1), filter = losing|winning|all (default losing),
 *        q (search), limit (default 50, max 200), offset
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const filter = sp.get("filter") ?? "losing";
  const q = (sp.get("q") ?? "").trim();
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);
  const offset = Number(sp.get("offset") ?? 0);

  const report = await prisma.walmartReport.findFirst({
    where: { storeIndex, reportType: "BUYBOX" },
    orderBy: { requestedAt: "desc" },
  });

  const base: Prisma.WalmartBuyBoxItemWhereInput = { storeIndex };
  const [total, winning, losing, gapAgg] = await Promise.all([
    prisma.walmartBuyBoxItem.count({ where: base }),
    prisma.walmartBuyBoxItem.count({ where: { ...base, isWinner: true } }),
    prisma.walmartBuyBoxItem.count({ where: { ...base, isWinner: false } }),
    // Sum of positive price gaps on losing items = $ we'd cut to match Buy Box.
    prisma.walmartBuyBoxItem.aggregate({
      where: { ...base, isWinner: false, priceGap: { gt: 0 } },
      _sum: { priceGap: true },
      _count: true,
    }),
  ]);

  const rollup = {
    total,
    winning,
    losing,
    winRate: total > 0 ? Math.round((winning / total) * 1000) / 10 : null,
    losingWithGap: gapAgg._count,
    totalGapToClose: gapAgg._sum.priceGap != null ? Math.round(gapAgg._sum.priceGap * 100) / 100 : 0,
    lastReportAt: report?.downloadedAt ?? null,
  };

  const where: Prisma.WalmartBuyBoxItemWhereInput = { storeIndex };
  const and: Prisma.WalmartBuyBoxItemWhereInput[] = [];
  if (filter === "losing") and.push({ isWinner: false });
  else if (filter === "winning") and.push({ isWinner: true });
  if (q) and.push({ OR: [{ productName: { contains: q } }, { sku: { contains: q } }] });
  if (and.length) where.AND = and;

  // Worst gap first for losers; winners by SKU.
  const orderBy: Prisma.WalmartBuyBoxItemOrderByWithRelationInput[] =
    filter === "winning" ? [{ priceGap: "asc" }] : [{ priceGap: "desc" }];

  const [matched, rows] = await Promise.all([
    prisma.walmartBuyBoxItem.count({ where }),
    prisma.walmartBuyBoxItem.findMany({ where, orderBy, take: limit, skip: offset }),
  ]);

  return NextResponse.json({
    storeIndex,
    report: report
      ? {
          status: report.status,
          requestedAt: report.requestedAt,
          downloadedAt: report.downloadedAt,
          rowCount: report.rowCount,
          error: report.error,
        }
      : null,
    rollup,
    worklist: {
      total: matched,
      limit,
      offset,
      items: rows.map((r) => ({
        sku: r.sku,
        itemId: r.itemId,
        productName: r.productName,
        productCategory: r.productCategory,
        sellerItemPrice: r.sellerItemPrice,
        sellerShipPrice: r.sellerShipPrice,
        sellerTotalPrice: r.sellerTotalPrice,
        isWinner: r.isWinner,
        buyBoxItemPrice: r.buyBoxItemPrice,
        buyBoxShipPrice: r.buyBoxShipPrice,
        buyBoxTotalPrice: r.buyBoxTotalPrice,
        priceGap: r.priceGap,
      })),
    },
  });
}
