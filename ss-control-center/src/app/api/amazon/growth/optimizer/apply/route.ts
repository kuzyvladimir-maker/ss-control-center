/**
 * POST /api/amazon/growth/optimizer/apply
 *
 * Build + apply remediation plans for the given SKUs. SAFE BY DEFAULT:
 * dryRun=true (Amazon VALIDATION_PREVIEW, no mutation) unless explicitly set
 * false. On a real apply we re-fetch + re-score the touched SKUs so the
 * worklist reflects the fix immediately.
 *
 * Body: { storeIndex?: number, skus: string[], dryRun?: boolean }  (max 25)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { listSkus } from "@/lib/amazon-sp-api/listings";
import { buildPlan, applyPlan } from "@/lib/amazon/growth/optimizer";
import { scoreListing, type HealthIssue } from "@/lib/amazon/growth/listing-health";

export const maxDuration = 180;

function parseIssues(s: string | null): HealthIssue[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  let storeIndex = 1;
  let skus: string[] = [];
  let dryRun = true;
  try {
    const body = await request.json();
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
    if (Array.isArray(body?.skus)) skus = body.skus.slice(0, 25).map(String);
    if (body?.dryRun === false) dryRun = false;
  } catch {
    /* fallthrough */
  }
  if (skus.length === 0) {
    return NextResponse.json({ ok: false, error: "no skus" }, { status: 400 });
  }

  try {
    const sellerId = await getMerchantToken(storeIndex);
    const results = [];
    for (const sku of skus) {
      const item = await prisma.amazonListingHealthItem.findUnique({
        where: { amazon_health_item_dedup: { storeIndex, sku } },
      });
      const issues = parseIssues(item?.issuesSummary ?? null);
      const plan = await buildPlan(storeIndex, sellerId, sku, issues);
      const result = await applyPlan(storeIndex, sellerId, plan, dryRun);
      results.push({ ...result, changes: plan.changes.length });

      // On a real, accepted apply, re-score the SKU from a fresh read so the
      // worklist updates without waiting for the next full sweep.
      if (!dryRun && result.applied) {
        try {
          await rescore(storeIndex, sellerId, sku);
        } catch {
          /* the next sweep will reconcile */
        }
      }
    }
    return NextResponse.json({ ok: true, storeIndex, dryRun, results });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}

/** Re-fetch one SKU and re-score the Phase-A components (status/issues/title). */
async function rescore(storeIndex: number, sellerId: string, sku: string): Promise<void> {
  const page = await listSkus(storeIndex, sellerId, {
    pageSize: 1,
    includedData: ["summaries", "issues"],
  });
  const raw = page.items.find((i) => i.sku === sku);
  if (!raw) return;
  const s = scoreListing(raw as unknown as Record<string, unknown>);
  const existing = await prisma.amazonListingHealthItem.findUnique({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
  });
  if (!existing) return;
  // Recompute the overall score from merged components (keep report-enriched ones).
  const { computeHealthScore, pickTopFix } = await import("@/lib/amazon/growth/listing-health");
  const components = {
    buyability: s.components.buyability,
    issues: s.components.issues,
    content: existing.contentScore,
    compliance: s.components.compliance,
    buyBox: existing.buyBoxScore,
    conversion: existing.conversionScore,
  };
  await prisma.amazonListingHealthItem.update({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
    data: {
      itemName: s.itemName,
      buyabilityScore: s.components.buyability,
      issuesScore: s.components.issues,
      complianceScore: s.components.compliance,
      errorIssueCount: s.errorIssueCount,
      warningIssueCount: s.warningIssueCount,
      issuesSummary: JSON.stringify(s.issues),
      healthScore: computeHealthScore(components),
      topFixComponent: pickTopFix(components),
    },
  });
}
