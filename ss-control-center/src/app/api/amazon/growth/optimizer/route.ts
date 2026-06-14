/**
 * GET /api/amazon/growth/optimizer
 *
 * Candidate listings for deterministic auto-fix, from the DB mirror — no live
 * SP-API calls (preview/apply do the live work). A candidate has ERROR issues
 * or a brand-voice (compliance) deduction. We flag which fix CLASSES apply
 * (title-scrub / dedupe) from the stored issues so the UI can pre-segment.
 *
 * Query: storeIndex (default 1), limit (default 50, max 200), offset, q.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

interface StoredIssue {
  code: string;
  message: string;
  severity: string;
  attributeNames: string[];
  categories: string[];
}

function parseIssues(s: string | null): StoredIssue[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);
  const offset = Number(sp.get("offset") ?? 0);
  const q = (sp.get("q") ?? "").trim();

  const and: Prisma.AmazonListingHealthItemWhereInput[] = [
    { OR: [{ errorIssueCount: { gt: 0 } }, { complianceScore: { lt: 85 } }] },
  ];
  if (q) and.push({ OR: [{ itemName: { contains: q } }, { sku: { contains: q } }, { asin: { contains: q } }] });
  const where: Prisma.AmazonListingHealthItemWhereInput = { storeIndex, AND: and };

  const [total, rows] = await Promise.all([
    prisma.amazonListingHealthItem.count({ where }),
    prisma.amazonListingHealthItem.findMany({
      where,
      orderBy: [{ healthScore: "asc" }, { errorIssueCount: "desc" }],
      take: limit,
      skip: offset,
    }),
  ]);

  const items = rows.map((r) => {
    const issues = parseIssues(r.issuesSummary);
    const hasDedupe = issues.some((i) => /maximum of \d+ occurrence/i.test(i.message));
    const hasTitleScrub = (r.complianceScore ?? 100) < 85;
    return {
      sku: r.sku,
      asin: r.asin,
      itemName: r.itemName,
      productType: r.productType,
      healthScore: r.healthScore,
      complianceScore: r.complianceScore,
      errorIssueCount: r.errorIssueCount,
      fixes: { titleScrub: hasTitleScrub, dedupe: hasDedupe },
      issues,
    };
  });

  // ── Impact (before/after) — closes the Grow loop ──
  const remediations = await prisma.amazonListingRemediation.findMany({
    where: { storeIndex, ok: true },
    orderBy: { runAt: "desc" },
    take: 40,
  });
  const measured = remediations.filter((r) => r.afterMeasuredAt != null);
  const deltas = measured
    .map((r) => (r.afterHealthScore != null && r.beforeHealthScore != null ? r.afterHealthScore - r.beforeHealthScore : null))
    .filter((d): d is number => d != null);
  const avgHealthDelta = deltas.length ? Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10 : null;
  const summary = {
    applied: remediations.length,
    measured: measured.length,
    pendingMeasure: remediations.length - measured.length,
    avgHealthDelta,
  };
  const history = remediations.slice(0, 30).map((r) => ({
    sku: r.sku,
    asin: r.asin,
    itemName: r.itemName,
    runAt: r.runAt,
    fixKinds: safeArr(r.fixKinds),
    changeCount: r.changeCount,
    measured: r.afterMeasuredAt != null,
    beforeHealth: r.beforeHealthScore,
    afterHealth: r.afterHealthScore,
    healthDelta: r.afterHealthScore != null && r.beforeHealthScore != null ? Math.round((r.afterHealthScore - r.beforeHealthScore) * 10) / 10 : null,
    beforeErrors: r.beforeErrorCount,
    afterErrors: r.afterErrorCount,
  }));

  // ── Most-common-issues heatmap (catalog-wide) ──
  const issueRows = await prisma.amazonListingHealthItem.findMany({
    where: { storeIndex, errorIssueCount: { gt: 0 } },
    select: { issuesSummary: true },
    take: 2000,
  });
  const tally = new Map<string, { code: string; message: string; count: number }>();
  for (const row of issueRows) {
    for (const iss of parseIssues(row.issuesSummary)) {
      if (iss.severity !== "ERROR") continue;
      const key = iss.code || iss.message.slice(0, 40);
      const cur = tally.get(key) ?? { code: iss.code, message: iss.message, count: 0 };
      cur.count++;
      tally.set(key, cur);
    }
  }
  const issueHeatmap = [...tally.values()].sort((a, b) => b.count - a.count).slice(0, 12);

  return NextResponse.json({
    storeIndex,
    worklist: { total, limit, offset, items },
    summary,
    history,
    issueHeatmap,
  });
}

function safeArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
