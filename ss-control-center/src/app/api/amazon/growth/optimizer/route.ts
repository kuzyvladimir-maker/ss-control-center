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

  return NextResponse.json({ storeIndex, worklist: { total, limit, offset, items } });
}
