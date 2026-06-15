/**
 * Bulk remediation — enqueue a filtered pool, and read worker progress.
 *
 * POST  : enqueue every listing matching the filter for the chosen fixes.
 *         Body: { storeIndex?, filter: {...}, scope: {dedupe,brandVoice,suppression} }
 * GET    : queue stats + recent results for the progress UI. ?storeIndex
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

interface BulkFilter {
  suppressed?: boolean;
  hasErrors?: boolean;
  notBuyable?: boolean;
  oppMin?: number; // opportunity ≥
  healthMax?: number; // health ≤
  q?: string;
}

function buildWhere(storeIndex: number, f: BulkFilter): Prisma.AmazonListingHealthItemWhereInput {
  const and: Prisma.AmazonListingHealthItemWhereInput[] = [];
  if (f.suppressed) and.push({ isSuppressed: true });
  if (f.hasErrors) and.push({ errorIssueCount: { gt: 0 } });
  if (f.notBuyable) and.push({ isBuyable: false });
  if (typeof f.oppMin === "number" && f.oppMin > 0) and.push({ opportunityScore: { gte: f.oppMin } });
  if (typeof f.healthMax === "number" && f.healthMax < 100) and.push({ healthScore: { lte: f.healthMax } });
  if (f.q && f.q.trim()) {
    and.push({ OR: [{ itemName: { contains: f.q.trim() } }, { sku: { contains: f.q.trim() } }, { asin: { contains: f.q.trim() } }] });
  }
  return { storeIndex, ...(and.length ? { AND: and } : {}) };
}

export async function POST(request: NextRequest) {
  let storeIndex = 1;
  let filter: BulkFilter = {};
  let scope = { dedupe: true, brandVoice: true, suppression: true };
  try {
    const body = await request.json();
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
    if (body?.filter) filter = body.filter;
    if (body?.scope) scope = { ...scope, ...body.scope };
  } catch {
    /* defaults */
  }
  if (!scope.dedupe && !scope.brandVoice && !scope.suppression) {
    return NextResponse.json({ ok: false, error: "select at least one fix" }, { status: 400 });
  }

  const where = buildWhere(storeIndex, filter);
  const rows = await prisma.amazonListingHealthItem.findMany({
    where,
    select: { sku: true, asin: true, itemName: true },
    take: 3000,
  });

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
  // Live match count for the current filter (so the UI shows the pool size).
  const filter: BulkFilter = {
    suppressed: sp.get("suppressed") === "1",
    hasErrors: sp.get("hasErrors") === "1",
    notBuyable: sp.get("notBuyable") === "1",
    oppMin: sp.get("oppMin") ? Number(sp.get("oppMin")) : undefined,
    healthMax: sp.get("healthMax") ? Number(sp.get("healthMax")) : undefined,
    q: sp.get("q") ?? undefined,
  };
  const match = await prisma.amazonListingHealthItem.count({ where: buildWhere(storeIndex, filter) });

  const [requested, running, done, skipped, errored, agg, recent] = await Promise.all([
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
    stats: { requested, running, done, skipped, errored, changesTotal: agg._sum.changesApplied ?? 0 },
    recent,
  });
}
