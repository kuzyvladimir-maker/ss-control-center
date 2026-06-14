/**
 * GET /api/amazon/growth/listing-health
 *
 * The Amazon "Grow Sales" read surface. Served from the DB mirror
 * (AmazonListingHealthItem) populated by /api/cron/amazon-listing-health.
 * Returns:
 *   - seller: latest computed health snapshot + delta vs the previous one
 *   - sweepState: when the listings feed last fully refreshed / is mid-sweep
 *   - rollup: catalog-wide counts (suppressed, has-errors, by top-fix, avg)
 *   - worklist: the per-SKU worklist, filtered + sorted + paginated
 *
 * Query params:
 *   storeIndex (default 1; selling accounts are 1 and 3)
 *   sort   = score | issues | recent          (default score, worst-first)
 *   filter = all | suppressed | hasErrors | lowScore | notBuyable
 *   q      = substring match on itemName / sku / asin
 *   limit  (default 50, max 200), offset
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const sort = sp.get("sort") ?? "score";
  const filter = sp.get("filter") ?? "all";
  const q = (sp.get("q") ?? "").trim();
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);
  const offset = Number(sp.get("offset") ?? 0);

  // ── Seller snapshot (latest + previous for delta) ──
  const snaps = await prisma.amazonListingHealthSnapshot.findMany({
    where: { storeIndex },
    orderBy: { capturedAt: "desc" },
    take: 2,
  });
  const latest = snaps[0] ?? null;
  const prev = snaps[1] ?? null;
  const seller = latest
    ? {
        healthScore: latest.healthScore,
        buyabilityScore: latest.buyabilityScore,
        issuesScore: latest.issuesScore,
        contentScore: latest.contentScore,
        complianceScore: latest.complianceScore,
        buyBoxScore: latest.buyBoxScore,
        conversionScore: latest.conversionScore,
        totalListings: latest.totalListings,
        suppressedCount: latest.suppressedCount,
        errorIssueCount: latest.errorIssueCount,
        warningIssueCount: latest.warningIssueCount,
        capturedAt: latest.capturedAt,
        delta: prev ? round2(latest.healthScore - prev.healthScore) : null,
      }
    : null;

  // ── Sweep state ──
  const state = await prisma.amazonHealthSyncState.findUnique({ where: { storeIndex } });
  const sweepState = {
    inProgress: Boolean(state?.cursor),
    pagesThisSweep: state?.pagesThisSweep ?? 0,
    itemsThisSweep: state?.itemsThisSweep ?? 0,
    lastFullSweepAt: state?.lastFullSweepAt ?? null,
  };

  // ── Catalog-wide rollup (the levers) ──
  const base: Prisma.AmazonListingHealthItemWhereInput = { storeIndex };
  const [
    totalItems,
    suppressed,
    hasErrors,
    notBuyable,
    lowScore,
    fixBuyability,
    fixIssues,
    fixCompliance,
    agg,
  ] = await Promise.all([
    prisma.amazonListingHealthItem.count({ where: base }),
    prisma.amazonListingHealthItem.count({ where: { ...base, isSuppressed: true } }),
    prisma.amazonListingHealthItem.count({ where: { ...base, errorIssueCount: { gt: 0 } } }),
    prisma.amazonListingHealthItem.count({ where: { ...base, isBuyable: false } }),
    prisma.amazonListingHealthItem.count({ where: { ...base, healthScore: { lt: 70 } } }),
    prisma.amazonListingHealthItem.count({ where: { ...base, topFixComponent: "buyability" } }),
    prisma.amazonListingHealthItem.count({ where: { ...base, topFixComponent: "issues" } }),
    prisma.amazonListingHealthItem.count({ where: { ...base, topFixComponent: "compliance" } }),
    prisma.amazonListingHealthItem.aggregate({ where: base, _avg: { healthScore: true } }),
  ]);

  const rollup = {
    totalItems,
    suppressed,
    hasErrors,
    notBuyable,
    lowScore,
    byTopFix: { buyability: fixBuyability, issues: fixIssues, compliance: fixCompliance },
    avgScore: agg._avg.healthScore != null ? round2(agg._avg.healthScore) : null,
  };

  // ── Worklist ──
  const where = buildWhere(storeIndex, filter, q);
  const orderBy = buildOrderBy(sort);
  const [matched, rows] = await Promise.all([
    prisma.amazonListingHealthItem.count({ where }),
    prisma.amazonListingHealthItem.findMany({ where, orderBy, take: limit, skip: offset }),
  ]);

  const items = rows.map((r) => ({
    sku: r.sku,
    asin: r.asin,
    itemName: r.itemName,
    productType: r.productType,
    mainImageUrl: r.mainImageUrl,
    healthScore: r.healthScore,
    topFixComponent: r.topFixComponent,
    components: {
      buyability: r.buyabilityScore,
      issues: r.issuesScore,
      content: r.contentScore,
      compliance: r.complianceScore,
      buyBox: r.buyBoxScore,
      conversion: r.conversionScore,
    },
    isBuyable: r.isBuyable,
    isDiscoverable: r.isDiscoverable,
    isSuppressed: r.isSuppressed,
    errorIssueCount: r.errorIssueCount,
    warningIssueCount: r.warningIssueCount,
    issues: safeParse(r.issuesSummary),
    suppressionReason: r.suppressionReason,
    sessions30d: r.sessions30d,
    unitsOrdered30d: r.unitsOrdered30d,
    unitSessionPct: r.unitSessionPct,
    lastUpdatedAt: r.lastUpdatedAt,
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
  q: string,
): Prisma.AmazonListingHealthItemWhereInput {
  const where: Prisma.AmazonListingHealthItemWhereInput = { storeIndex };
  const and: Prisma.AmazonListingHealthItemWhereInput[] = [];

  switch (filter) {
    case "suppressed":
      and.push({ isSuppressed: true });
      break;
    case "hasErrors":
      and.push({ errorIssueCount: { gt: 0 } });
      break;
    case "lowScore":
      and.push({ healthScore: { lt: 70 } });
      break;
    case "notBuyable":
      and.push({ isBuyable: false });
      break;
  }

  if (q) {
    and.push({
      OR: [
        { itemName: { contains: q } },
        { sku: { contains: q } },
        { asin: { contains: q } },
      ],
    });
  }

  if (and.length) where.AND = and;
  return where;
}

function buildOrderBy(
  sort: string,
): Prisma.AmazonListingHealthItemOrderByWithRelationInput[] {
  switch (sort) {
    case "issues":
      return [{ errorIssueCount: "desc" }, { healthScore: "asc" }];
    case "recent":
      return [{ lastUpdatedAt: "desc" }];
    case "score":
    default:
      return [{ healthScore: "asc" }, { errorIssueCount: "desc" }];
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
