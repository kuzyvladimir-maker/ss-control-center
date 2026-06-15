/**
 * Bulk AI-advisor — enqueue a filtered pool for LLM analysis + safe auto-fix,
 * and read worker progress.
 *
 * POST : enqueue listings for the AI advisor.
 *        Body: { storeIndex?, filter?, skus?:string[], allMatching?, autoApply? }
 * GET  : queue stats + recent analyzed listings (diagnosis + what was applied).
 *        ?storeIndex
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { type HealthFilter, buildHealthWhere } from "@/lib/amazon/growth/health-filters";

export async function POST(request: NextRequest) {
  let storeIndex = 1;
  let filter: HealthFilter = {};
  let skus: string[] | undefined;
  let allMatching = false;
  let autoApply = true;
  try {
    const body = await request.json();
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
    if (body?.filter) filter = body.filter;
    if (Array.isArray(body?.skus)) skus = body.skus.map(String);
    if (body?.allMatching) allMatching = true;
    if (body?.autoApply === false) autoApply = false;
  } catch {
    /* defaults */
  }

  let rows: { sku: string; asin: string | null; itemName: string | null }[];
  if (skus && skus.length && !allMatching) {
    rows = await prisma.amazonListingHealthItem.findMany({
      where: { storeIndex, sku: { in: skus } },
      select: { sku: true, asin: true, itemName: true },
    });
  } else {
    rows = await prisma.amazonListingHealthItem.findMany({
      where: buildHealthWhere(storeIndex, filter),
      select: { sku: true, asin: true, itemName: true },
      take: 1000, // AI is expensive — cap a single enqueue
    });
  }

  let queued = 0;
  for (const r of rows) {
    await prisma.amazonAdvisorQueue.upsert({
      where: { amazon_advisor_queue_dedup: { storeIndex, sku: r.sku } },
      create: { storeIndex, sku: r.sku, asin: r.asin, itemName: r.itemName, status: "REQUESTED", autoApply },
      update: {
        status: "REQUESTED", autoApply, actionsApplied: 0, result: null, error: null, processedAt: null,
        queuedAt: new Date(), diagnosis: null, rootCause: null, expectedOutcome: null, confidence: null, actionsJson: null,
      },
    });
    queued++;
  }

  return NextResponse.json({ ok: true, storeIndex, queued, matched: rows.length });
}

export async function GET(request: NextRequest) {
  const storeIndex = Number(request.nextUrl.searchParams.get("storeIndex") ?? 1);

  const [requested, running, done, skipped, errored, agg, recent] = await Promise.all([
    prisma.amazonAdvisorQueue.count({ where: { storeIndex, status: "REQUESTED" } }),
    prisma.amazonAdvisorQueue.count({ where: { storeIndex, status: "RUNNING" } }),
    prisma.amazonAdvisorQueue.count({ where: { storeIndex, status: "DONE" } }),
    prisma.amazonAdvisorQueue.count({ where: { storeIndex, status: "SKIPPED" } }),
    prisma.amazonAdvisorQueue.count({ where: { storeIndex, status: "ERROR" } }),
    prisma.amazonAdvisorQueue.aggregate({ where: { storeIndex, status: "DONE" }, _sum: { actionsApplied: true } }),
    prisma.amazonAdvisorQueue.findMany({
      where: { storeIndex, processedAt: { not: null } },
      orderBy: { processedAt: "desc" },
      take: 25,
      select: { sku: true, itemName: true, status: true, actionsApplied: true, diagnosis: true, rootCause: true, result: true, confidence: true },
    }),
  ]);

  return NextResponse.json({
    storeIndex,
    stats: { requested, running, done, skipped, errored, actionsTotal: agg._sum.actionsApplied ?? 0 },
    recent,
  });
}
