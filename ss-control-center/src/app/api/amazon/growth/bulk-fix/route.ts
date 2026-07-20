/**
 * Bulk remediation read-only pool and queue status.
 *
 * Mirrors the Walmart Listing Optimizer's "filter → pool → fix" builder, but on
 * Amazon's own data (health/opportunity + the Sales & Traffic funnel we mirror).
 *
 * POST : RETIRED. Enqueueing fed a worker capable of live Amazon writes without
 *        a manifest-bound Product Truth snapshot and owner action permit.
 * GET  : pool count + the matching candidates (sortable, paginated) + queue
 *        progress + recent results. Query = the filter + sort/limit/offset.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";
import {
  buildHealthWhere as buildWhere,
  healthFilterFromParams as filterFromParams,
  HEALTH_SORTS as SORTS,
  bucketOf,
} from "@/lib/amazon/growth/health-filters";

export async function POST() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_BULK_FIX_ENQUEUE_RETIRED",
  );
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const filter = filterFromParams(sp);
  const where = buildWhere(storeIndex, filter);
  const sort = sp.get("sort") ?? "opportunity";
  const orderBy = SORTS[sort] ?? SORTS.opportunity;
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);
  const offset = Math.max(Number(sp.get("offset") ?? 0), 0);

  const [match, suppressedCount, errorCount, candidates, requested, running, done, skipped, errored, agg, recent] = await Promise.all([
    prisma.amazonListingHealthItem.count({ where }),
    prisma.amazonListingHealthItem.count({ where: { storeIndex, isSuppressed: true } }),
    prisma.amazonListingHealthItem.count({ where: { storeIndex, errorIssueCount: { gt: 0 } } }),
    prisma.amazonListingHealthItem.findMany({
      where,
      orderBy: [orderBy, { sku: "asc" }],
      take: limit,
      skip: offset,
      select: {
        sku: true, asin: true, itemName: true, productType: true,
        healthScore: true, opportunityScore: true,
        isBuyable: true, isSuppressed: true, errorIssueCount: true,
        sessions30d: true, unitsOrdered30d: true, unitSessionPct: true,
        buyBoxPercentage: true, revenue30d: true, returnRate: true,
      },
    }),
    prisma.amazonRemediationQueue.count({ where: { storeIndex, status: "REQUESTED" } }),
    prisma.amazonRemediationQueue.count({ where: { storeIndex, status: "RUNNING" } }),
    prisma.amazonRemediationQueue.count({ where: { storeIndex, status: "DONE" } }),
    prisma.amazonRemediationQueue.count({ where: { storeIndex, status: "SKIPPED" } }),
    prisma.amazonRemediationQueue.count({ where: { storeIndex, status: "ERROR" } }),
    prisma.amazonRemediationQueue.aggregate({ where: { storeIndex, status: "DONE" }, _sum: { changesApplied: true } }),
    prisma.amazonRemediationQueue.findMany({
      where: { storeIndex, processedAt: { not: null } },
      orderBy: { processedAt: "desc" },
      take: 25,
      select: { sku: true, itemName: true, status: true, changesApplied: true, result: true },
    }),
  ]);

  return NextResponse.json({
    storeIndex,
    match,
    counts: { match, suppressed: suppressedCount, hasErrors: errorCount },
    candidates: candidates.map((c) => ({
      sku: c.sku,
      asin: c.asin,
      itemName: c.itemName,
      productType: c.productType,
      healthScore: c.healthScore,
      opportunityScore: c.opportunityScore,
      isBuyable: c.isBuyable,
      isSuppressed: c.isSuppressed,
      errorIssueCount: c.errorIssueCount,
      sessions30d: c.sessions30d,
      unitsOrdered30d: c.unitsOrdered30d,
      unitSessionPct: c.unitSessionPct,
      buyBoxPercentage: c.buyBoxPercentage,
      revenue30d: c.revenue30d,
      returnRate: c.returnRate,
      health: bucketOf(c),
    })),
    page: { limit, offset, total: match },
    stats: { requested, running, done, skipped, errored, changesTotal: agg._sum.changesApplied ?? 0 },
    recent,
  });
}
