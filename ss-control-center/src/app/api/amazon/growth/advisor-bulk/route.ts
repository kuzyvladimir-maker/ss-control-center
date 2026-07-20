/**
 * Bulk AI-advisor queue status.
 *
 * POST : RETIRED. Enqueueing could trigger unmetered paid analysis and optional
 *        live Amazon writes without Product Truth owner gates.
 * GET  : queue stats + recent analyzed listings (diagnosis + what was applied).
 *        ?storeIndex
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";

export async function POST() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_ADVISOR_BULK_ENQUEUE_RETIRED",
  );
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
