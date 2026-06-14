/**
 * POST /api/amazon/growth/optimizer/preview
 *
 * Build remediation plans for the given SKUs (live getListing → deterministic
 * fixes) and return before/after changes. No writes.
 *
 * Body: { storeIndex?: number, skus: string[] }  (max 25 per call)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { buildPlan } from "@/lib/amazon/growth/optimizer";
import type { HealthIssue } from "@/lib/amazon/growth/listing-health";

export const maxDuration = 120;

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
  try {
    const body = await request.json();
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
    if (Array.isArray(body?.skus)) skus = body.skus.slice(0, 25).map(String);
  } catch {
    /* fallthrough */
  }
  if (skus.length === 0) {
    return NextResponse.json({ ok: false, error: "no skus" }, { status: 400 });
  }

  try {
    const sellerId = await getMerchantToken(storeIndex);
    const plans = [];
    for (const sku of skus) {
      const item = await prisma.amazonListingHealthItem.findUnique({
        where: { amazon_health_item_dedup: { storeIndex, sku } },
      });
      const issues = parseIssues(item?.issuesSummary ?? null);
      try {
        plans.push(await buildPlan(storeIndex, sellerId, sku, issues));
      } catch (err) {
        plans.push({ sku, asin: null, productType: null, changes: [], patches: [], unfixable: [], error: (err as Error).message });
      }
    }
    return NextResponse.json({ ok: true, storeIndex, plans });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
