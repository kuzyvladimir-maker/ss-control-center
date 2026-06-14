/**
 * Walmart Growth — Listing Remediation module API.
 *
 * GET  → what we've changed (before/after metrics + deltas), a summary, and the
 *        recommended next targets (multipacks with content issues, not yet fixed).
 * POST → enqueue SKUs for remediation (drained by walmart-multipack-batch.ts
 *        --from-queue; heavy work stays off the serverless request path).
 *
 * Reads the WalmartListingRemediation log + WalmartListingQualityItem mirror via
 * raw SQL (these tables are managed by Turso migrations, not the Prisma schema).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

type Row = Record<string, any>;

function delta(a: any, b: any): number | null {
  return a != null && b != null ? Number(a) - Number(b) : null;
}

export async function GET(request: NextRequest) {
  const storeIndex = Number(new URL(request.url).searchParams.get("storeIndex") || 1);

  // 1. History — what we changed + before/after metrics.
  const hist = (await prisma.$queryRawUnsafe(
    `SELECT sku, buyerItemId, runAt, feedStatus, ok, packCount, newTitle, bulletsCount, imagesCount,
            descriptionLength, usedAiPolish, notes,
            beforeLqScore, afterLqScore, beforeContentScore, afterContentScore,
            beforeConversionRate30d, afterConversionRate30d, beforePageViews30d, afterPageViews30d,
            beforeGmv30d, afterGmv30d, afterCapturedAt
       FROM WalmartListingRemediation WHERE storeIndex=? ORDER BY runAt DESC LIMIT 200`,
    storeIndex,
  )) as Row[];

  const history = hist.map((r) => ({
    sku: r.sku,
    buyerItemId: r.buyerItemId,
    url: r.buyerItemId ? `https://www.walmart.com/ip/${r.buyerItemId}` : null,
    runAt: r.runAt,
    feedStatus: r.feedStatus,
    ok: !!r.ok,
    packCount: r.packCount,
    newTitle: r.newTitle,
    bulletsCount: r.bulletsCount,
    imagesCount: r.imagesCount,
    descriptionLength: r.descriptionLength,
    usedAiPolish: !!r.usedAiPolish,
    notes: r.notes,
    measured: !!r.afterCapturedAt,
    before: { lq: r.beforeLqScore, content: r.beforeContentScore, conv: r.beforeConversionRate30d, views: r.beforePageViews30d, gmv: r.beforeGmv30d },
    after: { lq: r.afterLqScore, content: r.afterContentScore, conv: r.afterConversionRate30d, views: r.afterPageViews30d, gmv: r.afterGmv30d },
    deltas: {
      lq: delta(r.afterLqScore, r.beforeLqScore),
      content: delta(r.afterContentScore, r.beforeContentScore),
      conv: delta(r.afterConversionRate30d, r.beforeConversionRate30d),
      views: delta(r.afterPageViews30d, r.beforePageViews30d),
      gmv: delta(r.afterGmv30d, r.beforeGmv30d),
    },
  }));

  const measured = history.filter((h) => h.measured);
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const summary = {
    applied: history.filter((h) => h.ok).length,
    measured: measured.length,
    pendingMeasure: history.filter((h) => h.ok && !h.measured).length,
    avgLqDelta: avg(measured.map((h) => h.deltas.lq)),
    avgContentDelta: avg(measured.map((h) => h.deltas.content)),
    avgConvDelta: avg(measured.map((h) => h.deltas.conv)),
    avgViewsDelta: avg(measured.map((h) => h.deltas.views)),
  };

  // 2. Recommended next targets — multipacks (pack>=2) with content issues,
  //    not already remediated. pack>=4 surfaces first (wave-1 scope).
  // Correlated subqueries for pack count avoid JOIN fan-out (SkuShippingData /
  // SkuCost can hold multiple rows per sku, which would duplicate candidates).
  const cand = (await prisma.$queryRawUnsafe(
    `SELECT q.sku, q.itemId, q.productName, q.lqScore, q.contentScore, q.issueCount, q.issuesSummary,
            q.pageViews30d, q.conversionRate30d, q.gmv30d, q.isInStock,
            COALESCE((SELECT unitsInListing FROM SkuShippingData WHERE sku=q.sku LIMIT 1),
                     (SELECT packSize FROM SkuCost WHERE sku=q.sku LIMIT 1), 1) AS packCount
       FROM WalmartListingQualityItem q
      WHERE q.storeIndex=?
        AND COALESCE((SELECT unitsInListing FROM SkuShippingData WHERE sku=q.sku LIMIT 1),
                     (SELECT packSize FROM SkuCost WHERE sku=q.sku LIMIT 1), 1) >= 2
        AND q.sku NOT IN (SELECT sku FROM WalmartListingRemediation WHERE ok=1)
        AND q.sku NOT IN (SELECT sku FROM WalmartRemediationQueue WHERE status IN ('queued','running'))
      ORDER BY (CASE WHEN COALESCE((SELECT unitsInListing FROM SkuShippingData WHERE sku=q.sku LIMIT 1),
                     (SELECT packSize FROM SkuCost WHERE sku=q.sku LIMIT 1), 1) >= 4 THEN 0 ELSE 1 END),
               q.pageViews30d DESC
      LIMIT 60`,
    storeIndex,
  )) as Row[];

  const candidates = cand.map((r) => {
    let contentIssues: string[] = [];
    try {
      const parsed = JSON.parse(r.issuesSummary || "[]");
      if (Array.isArray(parsed)) contentIssues = parsed.filter((x: any) => x?.component === "content").map((x: any) => x.title).filter(Boolean);
    } catch { /* ignore */ }
    return {
      sku: r.sku, itemId: r.itemId, productName: r.productName, packCount: r.packCount,
      lqScore: r.lqScore, contentScore: r.contentScore, issueCount: r.issueCount,
      contentIssues, pageViews30d: r.pageViews30d, conversionRate30d: r.conversionRate30d,
      gmv30d: r.gmv30d, inStock: !!r.isInStock,
    };
  });

  // 3. In-flight queue.
  const queue = (await prisma.$queryRawUnsafe(
    `SELECT sku, status, queuedAt, feedId, error FROM WalmartRemediationQueue
       WHERE storeIndex=? AND status IN ('queued','running') ORDER BY queuedAt DESC LIMIT 100`,
    storeIndex,
  )) as Row[];

  return NextResponse.json({ summary, history, candidates, queue });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const skus: string[] = Array.isArray(body?.skus) ? body.skus.filter((s: any) => typeof s === "string") : [];
  const storeIndex = Number(body?.storeIndex || 1);
  if (!skus.length) return NextResponse.json({ error: "no skus" }, { status: 400 });

  let queued = 0;
  for (const sku of skus.slice(0, 500)) {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO WalmartRemediationQueue (id, storeIndex, sku, status, requestedBy) VALUES (?, ?, ?, 'queued', 'ui')`,
        randomUUID(), storeIndex, sku,
      );
      queued++;
    } catch { /* unique partial index → already queued/running; skip */ }
  }
  return NextResponse.json({ queued, requested: skus.length });
}
