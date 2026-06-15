/**
 * Bulk remediation — filter the catalog → see the pool → enqueue for fixing.
 *
 * Mirrors the Walmart Listing Optimizer's "filter → pool → fix" builder, but on
 * Amazon's own data (health/opportunity + the Sales & Traffic funnel we mirror).
 *
 * POST : enqueue the chosen listings for the chosen fixes.
 *        Body: { storeIndex?, filter?, scope:{dedupe,brandVoice,suppression},
 *                skus?:string[], allMatching?:boolean }
 *        - skus[]        → enqueue exactly those rows
 *        - allMatching   → enqueue the whole filtered pool (server-side)
 * GET  : pool count + the matching candidates (sortable, paginated) + queue
 *        progress + recent results. Query = the filter + sort/limit/offset.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  type HealthFilter as BulkFilter,
  buildHealthWhere as buildWhere,
  healthFilterFromParams as filterFromParams,
  HEALTH_SORTS as SORTS,
  bucketOf,
} from "@/lib/amazon/growth/health-filters";

export async function POST(request: NextRequest) {
  let storeIndex = 1;
  let filter: BulkFilter = {};
  let scope = { dedupe: true, brandVoice: true, suppression: true };
  let skus: string[] | undefined;
  let allMatching = false;
  try {
    const body = await request.json();
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
    if (body?.filter) filter = body.filter;
    if (body?.scope) scope = { ...scope, ...body.scope };
    if (Array.isArray(body?.skus)) skus = body.skus.map(String);
    if (body?.allMatching) allMatching = true;
  } catch {
    /* defaults */
  }
  if (!scope.dedupe && !scope.brandVoice && !scope.suppression) {
    return NextResponse.json({ ok: false, error: "select at least one fix" }, { status: 400 });
  }

  // Either an explicit list of checked rows, or the whole filtered pool.
  let rows: { sku: string; asin: string | null; itemName: string | null }[];
  if (skus && skus.length && !allMatching) {
    rows = await prisma.amazonListingHealthItem.findMany({
      where: { storeIndex, sku: { in: skus } },
      select: { sku: true, asin: true, itemName: true },
    });
  } else {
    rows = await prisma.amazonListingHealthItem.findMany({
      where: buildWhere(storeIndex, filter),
      select: { sku: true, asin: true, itemName: true },
      take: 3000,
    });
  }

  const scopeJson = JSON.stringify(scope);
  let queued = 0;
  for (const r of rows) {
    await prisma.amazonRemediationQueue.upsert({
      where: { amazon_remediation_queue_dedup: { storeIndex, sku: r.sku } },
      create: { storeIndex, sku: r.sku, asin: r.asin, itemName: r.itemName, scope: scopeJson, status: "REQUESTED" },
      update: { scope: scopeJson, status: "REQUESTED", changesApplied: 0, result: null, error: null, processedAt: null, queuedAt: new Date() },
    });
    queued++;
  }

  return NextResponse.json({ ok: true, storeIndex, queued, matched: rows.length });
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
