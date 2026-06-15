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
import type { Prisma } from "@/generated/prisma/client";

interface BulkFilter {
  q?: string;
  suppressed?: boolean;
  hasErrors?: boolean;
  notBuyable?: boolean;
  noBuyBox?: boolean;
  oppMin?: number; // opportunity ≥
  healthMax?: number; // health ≤
  sessMin?: number; // sessions (traffic) ≥
  errMin?: number; // error issues ≥
  convMin?: number; // conversion % range
  convMax?: number;
  bbMin?: number; // buy-box % range
  bbMax?: number;
  retMin?: number; // return % range
  retMax?: number;
  revMin?: number; // revenue $ range
  revMax?: number;
  health?: string; // bucket chip: winner|leaky|high-return|dead|suppressed
  status?: string; // chip: buyable|notBuyable|error
}

// Range slider maxima — keep in sync with the UI so "at max" means "no cap".
const REV_MAX = 2000; // $ revenue range ceiling

// Health bucket → the WHERE that defines it (used by the Health chips).
function bucketWhere(b: string): Prisma.AmazonListingHealthItemWhereInput | null {
  switch (b) {
    case "suppressed":
      return { isSuppressed: true };
    case "winner":
      return { isSuppressed: false, sessions30d: { gte: 10 }, unitSessionPct: { gte: 0.1 } };
    case "leaky":
      return {
        isSuppressed: false,
        sessions30d: { gte: 10 },
        OR: [{ unitSessionPct: null }, { unitSessionPct: { lt: 0.1 } }],
      };
    case "high-return":
      return { returnRate: { gte: 0.15 }, unitsOrdered30d: { gte: 3 } };
    case "dead":
      return { isSuppressed: false, sessions30d: { lt: 10 } };
    default:
      return null;
  }
}

function buildWhere(storeIndex: number, f: BulkFilter): Prisma.AmazonListingHealthItemWhereInput {
  const and: Prisma.AmazonListingHealthItemWhereInput[] = [];
  if (f.suppressed) and.push({ isSuppressed: true });
  if (f.hasErrors) and.push({ errorIssueCount: { gt: 0 } });
  if (f.notBuyable) and.push({ isBuyable: false });
  if (f.noBuyBox) and.push({ buyBoxPercentage: { lt: 90 } });
  if (typeof f.oppMin === "number" && f.oppMin > 0) and.push({ opportunityScore: { gte: f.oppMin } });
  if (typeof f.healthMax === "number" && f.healthMax < 100) and.push({ healthScore: { lte: f.healthMax } });
  if (typeof f.sessMin === "number" && f.sessMin > 0) and.push({ sessions30d: { gte: f.sessMin } });
  if (typeof f.errMin === "number" && f.errMin > 0) and.push({ errorIssueCount: { gte: f.errMin } });
  // Conversion % range (stored 0-1).
  if (typeof f.convMin === "number" && f.convMin > 0) and.push({ unitSessionPct: { gte: f.convMin / 100 } });
  if (typeof f.convMax === "number" && f.convMax < 100) and.push({ unitSessionPct: { lte: f.convMax / 100 } });
  // Buy-box % range (stored 0-100).
  if (typeof f.bbMin === "number" && f.bbMin > 0) and.push({ buyBoxPercentage: { gte: f.bbMin } });
  if (typeof f.bbMax === "number" && f.bbMax < 100) and.push({ buyBoxPercentage: { lte: f.bbMax } });
  // Return % range (stored 0-1).
  if (typeof f.retMin === "number" && f.retMin > 0) and.push({ returnRate: { gte: f.retMin / 100 } });
  if (typeof f.retMax === "number" && f.retMax < 100) and.push({ returnRate: { lte: f.retMax / 100 } });
  // Revenue $ range.
  if (typeof f.revMin === "number" && f.revMin > 0) and.push({ revenue30d: { gte: f.revMin } });
  if (typeof f.revMax === "number" && f.revMax < REV_MAX) and.push({ revenue30d: { lte: f.revMax } });

  if (f.health) {
    const w = bucketWhere(f.health);
    if (w) and.push(w);
  }
  if (f.status === "buyable") and.push({ isBuyable: true });
  else if (f.status === "notBuyable") and.push({ isBuyable: false });
  else if (f.status === "error") and.push({ errorIssueCount: { gt: 0 } });

  if (f.q && f.q.trim()) {
    and.push({ OR: [{ itemName: { contains: f.q.trim() } }, { sku: { contains: f.q.trim() } }, { asin: { contains: f.q.trim() } }] });
  }
  return { storeIndex, ...(and.length ? { AND: and } : {}) };
}

function filterFromParams(sp: URLSearchParams): BulkFilter {
  const num = (k: string) => (sp.get(k) != null && sp.get(k) !== "" ? Number(sp.get(k)) : undefined);
  return {
    q: sp.get("q") ?? undefined,
    suppressed: sp.get("suppressed") === "1",
    hasErrors: sp.get("hasErrors") === "1",
    notBuyable: sp.get("notBuyable") === "1",
    noBuyBox: sp.get("noBuyBox") === "1",
    oppMin: num("oppMin"),
    healthMax: num("healthMax"),
    sessMin: num("sessMin"),
    errMin: num("errMin"),
    convMin: num("convMin"),
    convMax: num("convMax"),
    bbMin: num("bbMin"),
    bbMax: num("bbMax"),
    retMin: num("retMin"),
    retMax: num("retMax"),
    revMin: num("revMin"),
    revMax: num("revMax"),
    health: sp.get("health") ?? undefined,
    status: sp.get("status") ?? undefined,
  };
}

// Sort key → Prisma orderBy. SQLite sorts NULLs as lowest, so `desc` pushes
// unenriched rows to the bottom (what we want for opportunity/revenue/etc).
const SORTS: Record<string, Prisma.AmazonListingHealthItemOrderByWithRelationInput> = {
  opportunity: { opportunityScore: "desc" },
  revenue: { revenue30d: "desc" },
  traffic: { sessions30d: "desc" },
  units: { unitsOrdered30d: "desc" },
  conversion: { unitSessionPct: "desc" },
  buybox: { buyBoxPercentage: "desc" },
  returns: { returnRate: "desc" },
  worstHealth: { healthScore: "asc" },
  mostErrors: { errorIssueCount: "desc" },
};

// Display-only health bucket (matches bucketWhere semantics).
function bucketOf(c: {
  isSuppressed: boolean;
  sessions30d: number | null;
  unitSessionPct: number | null;
  returnRate: number | null;
  unitsOrdered30d: number | null;
}): string {
  if (c.isSuppressed) return "suppressed";
  if ((c.returnRate ?? 0) >= 0.15 && (c.unitsOrdered30d ?? 0) >= 3) return "high-return";
  if (c.sessions30d == null) return "new";
  if (c.sessions30d < 10) return "dead";
  if ((c.unitSessionPct ?? 0) >= 0.1) return "winner";
  return "leaky";
}

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
