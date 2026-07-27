/**
 * GET /api/walmart/growth/listing-quality
 *
 * The "Grow Sales" read surface. Returns:
 *   - seller: latest Listing Quality snapshot + delta vs the previous one
 *   - sweepState: when the item feed last fully refreshed / is mid-sweep
 *   - rollup: catalog-wide counts (the levers — out of stock, no fast ship,
 *     no reviews, traffic-but-no-conversion, by Walmart priority)
 *   - items: the per-SKU worklist, filtered + sorted + paginated
 *
 * Served from the nightly DB mirror (WalmartListingQualityItem) because the
 * Insights feed is rate-bucket-throttled and Walmart only recomputes it daily
 * — a 4 000-item live page-through on every request is neither possible nor
 * useful. (The "Walmart API first" rule targets live-critical data like orders
 * + inventory, which still go straight to the API.)
 *
 * Query params:
 *   storeIndex  (default 1)
 *   sort   = traffic | score | priority | gmv      (default traffic)
 *   filter = all | trafficNoConversion | outOfStock | noReviews | noFastShip
 *            | inStockHasTraffic
 *   component = shipping | ratingReview | publish | content | price | offer
 *   q      = substring match on productName / sku
 *   limit  (default 50, max 200), offset
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const sort = sp.get("sort") ?? "traffic";
  const filter = sp.get("filter") ?? "all";
  const component = sp.get("component");
  const q = (sp.get("q") ?? "").trim();
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);
  const offset = Number(sp.get("offset") ?? 0);

  // ── Seller snapshot (latest + previous for delta) ──
  const snaps = await prisma.walmartListingQualitySnapshot.findMany({
    where: { storeIndex },
    orderBy: { capturedAt: "desc" },
    take: 2,
  });
  const latest = snaps[0] ?? null;
  const prev = snaps[1] ?? null;
  const seller = latest
    ? {
        listingQuality: latest.listingQuality,
        offerScore: latest.offerScore,
        ratingReviewScore: latest.ratingReviewScore,
        contentScore: latest.contentScore,
        priceScore: latest.priceScore,
        shippingScore: latest.shippingScore,
        transactibilityScore: latest.transactibilityScore,
        itemDefectCnt: latest.itemDefectCnt,
        defectRatio: latest.defectRatio,
        capturedAt: latest.capturedAt,
        delta: prev ? round2(latest.listingQuality - prev.listingQuality) : null,
      }
    : null;

  // ── Sweep state ──
  const state = await prisma.walmartLqSyncState.findUnique({ where: { storeIndex } });
  const sweepState = {
    inProgress: Boolean(state?.cursor),
    pagesThisSweep: state?.pagesThisSweep ?? 0,
    itemsThisSweep: state?.itemsThisSweep ?? 0,
    lastFullSweepAt: state?.lastFullSweepAt ?? null,
  };

  // ── Catalog-wide rollup (the levers) ──
  const base: Prisma.WalmartListingQualityItemWhereInput = { storeIndex };
  const [
    totalItems,
    outOfStock,
    noFastShip,
    noReviews,
    withTraffic,
    trafficNoConversion,
    high,
    medium,
    low,
    agg,
  ] = await Promise.all([
    prisma.walmartListingQualityItem.count({ where: base }),
    prisma.walmartListingQualityItem.count({ where: { ...base, isInStock: false } }),
    prisma.walmartListingQualityItem.count({ where: { ...base, isFastAndFreeShipping: false } }),
    prisma.walmartListingQualityItem.count({ where: { ...base, ratingCount: 0 } }),
    prisma.walmartListingQualityItem.count({ where: { ...base, pageViews30d: { gt: 0 } } }),
    prisma.walmartListingQualityItem.count({
      where: { ...base, pageViews30d: { gt: 0 }, OR: [{ conversionRate30d: 0 }, { conversionRate30d: null }] },
    }),
    prisma.walmartListingQualityItem.count({ where: { ...base, priority: "HIGH" } }),
    prisma.walmartListingQualityItem.count({ where: { ...base, priority: "MEDIUM" } }),
    prisma.walmartListingQualityItem.count({ where: { ...base, priority: "LOW" } }),
    prisma.walmartListingQualityItem.aggregate({ where: base, _avg: { lqScore: true } }),
  ]);

  const rollup = {
    totalItems,
    outOfStock,
    noFastShip,
    noReviews,
    withTraffic,
    trafficNoConversion,
    byPriority: { high, medium, low },
    avgScore: agg._avg.lqScore != null ? round2(agg._avg.lqScore) : null,
  };

  // ── Worklist query ──
  const where = buildWhere(storeIndex, filter, component, q);
  const orderBy = buildOrderBy(sort);
  const [matched, rows] = await Promise.all([
    prisma.walmartListingQualityItem.count({ where }),
    prisma.walmartListingQualityItem.findMany({ where, orderBy, take: limit, skip: offset }),
  ]);

  const items = rows.map((r) => ({
    sku: r.sku,
    itemId: r.itemId,
    productName: r.productName,
    productType: r.productType,
    categoryName: r.categoryName,
    lqScore: r.lqScore,
    priority: r.priority,
    components: {
      ratingReview: r.ratingReviewScore,
      shipping: r.shippingScore,
      publish: r.publishScore,
      content: r.contentScore,
      price: r.priceScore,
      offer: r.offerScore,
    },
    isInStock: r.isInStock,
    isFastAndFreeShipping: r.isFastAndFreeShipping,
    wfsEnabled: r.wfsEnabled,
    ratingCount: r.ratingCount,
    pageViews30d: r.pageViews30d,
    conversionRate30d: r.conversionRate30d,
    gmv30d: r.gmv30d,
    orders30d: r.orders30d,
    units30d: r.units30d,
    topFixComponent: r.topFixComponent,
    issueCount: r.issueCount,
    issues: safeParse(r.issuesSummary),
    scoredAt: r.scoredAt,
  }));

  return NextResponse.json({
    storeIndex,
    seller,
    sweepState,
    rollup,
    worklist: { total: matched, limit, offset, items },
  });
}

function buildWhere(
  storeIndex: number,
  filter: string,
  component: string | null,
  q: string
): Prisma.WalmartListingQualityItemWhereInput {
  const where: Prisma.WalmartListingQualityItemWhereInput = { storeIndex };
  const and: Prisma.WalmartListingQualityItemWhereInput[] = [];

  switch (filter) {
    case "trafficNoConversion":
      and.push({ pageViews30d: { gt: 0 } });
      and.push({ OR: [{ conversionRate30d: 0 }, { conversionRate30d: null }] });
      break;
    case "outOfStock":
      and.push({ isInStock: false });
      break;
    case "noReviews":
      and.push({ ratingCount: 0 });
      break;
    case "noFastShip":
      and.push({ isFastAndFreeShipping: false });
      break;
    case "inStockHasTraffic":
      and.push({ isInStock: true, pageViews30d: { gt: 0 } });
      break;
  }

  // Component lens — items where that component is the weak spot.
  switch (component) {
    case "shipping":
      and.push({ isFastAndFreeShipping: false });
      break;
    case "ratingReview":
      and.push({ ratingCount: 0 });
      break;
    case "publish":
      and.push({ isInStock: false });
      break;
    case "content":
      and.push({ contentScore: { lt: 80 } });
      break;
    case "price":
      and.push({ topFixComponent: "price" });
      break;
    case "offer":
      and.push({ topFixComponent: "offer" });
      break;
  }

  if (q) {
    and.push({
      OR: [
        { productName: { contains: q } },
        { sku: { contains: q } },
      ],
    });
  }

  if (and.length) where.AND = and;
  return where;
}

function buildOrderBy(
  sort: string
): Prisma.WalmartListingQualityItemOrderByWithRelationInput[] {
  switch (sort) {
    case "score":
      return [{ lqScore: "asc" }];
    case "gmv":
      return [{ gmv30d: "desc" }];
    case "priority":
      // HIGH < LOW alphabetically would mis-sort; use traffic as tiebreak and
      // rely on the UI to group. Prisma can't custom-order an enum string, so
      // approximate: priority asc puts HIGH before LOW before MEDIUM — instead
      // sort by pageViews within, and let callers filter by priority chips.
      return [{ priority: "asc" }, { pageViews30d: "desc" }];
    case "traffic":
    default:
      return [{ pageViews30d: "desc" }, { lqScore: "asc" }];
  }
}

function safeParse(s: string | null): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
