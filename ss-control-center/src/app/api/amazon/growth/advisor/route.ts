/**
 * POST /api/amazon/growth/advisor
 *
 * Run the AI Growth Advisor on one listing — reads its full productivity funnel
 * from the DB mirror and returns a ranked, structured action plan (Claude).
 *
 * Body: { storeIndex?: number, sku: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { adviseListing, type AdvisorInput } from "@/lib/amazon/growth/advisor";

export const maxDuration = 120;

function parseIssues(s: string | null): Array<{ code: string; message: string }> {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((i) => ({ code: String(i.code ?? ""), message: String(i.message ?? "") })) : [];
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  let storeIndex = 1;
  let sku = "";
  try {
    const body = await request.json();
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
    sku = String(body?.sku ?? "");
  } catch {
    /* fallthrough */
  }
  if (!sku) return NextResponse.json({ ok: false, error: "no sku" }, { status: 400 });

  const it = await prisma.amazonListingHealthItem.findUnique({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
  });
  if (!it) return NextResponse.json({ ok: false, error: "listing not found" }, { status: 404 });

  const status: AdvisorInput["status"] = it.isSuppressed ? "suppressed" : it.isBuyable ? "live" : "inactive";
  const input: AdvisorInput = {
    sku: it.sku,
    asin: it.asin,
    itemName: it.itemName,
    productType: it.productType,
    status,
    suppressionReason: it.suppressionReason,
    healthScore: it.healthScore,
    components: {
      buyability: it.buyabilityScore,
      issues: it.issuesScore,
      content: it.contentScore,
      compliance: it.complianceScore,
      buyBox: it.buyBoxScore,
      conversion: it.conversionScore,
    },
    errorIssueCount: it.errorIssueCount,
    issues: parseIssues(it.issuesSummary),
    impressions30d: it.impressions30d,
    clicks30d: it.clicks30d,
    ctr: it.ctr,
    sessions30d: it.sessions30d,
    pageViews30d: it.pageViews30d,
    cartAdds30d: it.cartAdds30d,
    cartAddRate: it.cartAddRate,
    unitsOrdered30d: it.unitsOrdered30d,
    unitSessionPct: it.unitSessionPct,
    purchases30d: it.purchases30d,
    purchaseRate: it.purchaseRate,
    buyBoxPercentage: it.buyBoxPercentage,
    revenue30d: it.revenue30d,
    returns30d: it.returns30d,
    returnRate: it.returnRate,
  };

  try {
    const plan = await adviseListing(input);
    return NextResponse.json({ ok: true, sku, plan });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
