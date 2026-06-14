/**
 * Walmart Growth — Listing Optimizer API.
 *
 * GET  → filtered candidate listings + live match counts (driven by the
 *        Builder's sliders: pack size, listing-quality, content score, has-gaps,
 *        exclude-bundles), plus the before/after history and a summary.
 * POST → enqueue selected SKUs for optimization (drained by
 *        walmart-multipack-batch.ts --from-queue; heavy work off the request path).
 *
 * Reads WalmartListingRemediation + WalmartListingQualityItem via raw SQL.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

type Row = Record<string, any>;
const delta = (a: any, b: any): number | null => (a != null && b != null ? Number(a) - Number(b) : null);

// Words that signal a mixed/variety bundle (quantity-confusion fix doesn't apply).
const BUNDLE_WORDS = ["bundle", "variety pack", "variety", "assorted", "sampler", "gift"];

function buildFilter(p: URLSearchParams) {
  const packMin = Number(p.get("packMin") ?? 2);
  const packMax = Number(p.get("packMax") ?? 99);
  const lqMin = p.get("lqMin") != null ? Number(p.get("lqMin")) : null;
  const lqMax = p.get("lqMax") != null ? Number(p.get("lqMax")) : null;
  const contentMax = p.get("contentMax") != null ? Number(p.get("contentMax")) : null;
  const hasIssues = p.get("hasIssues") === "1";
  const excludeBundles = p.get("excludeBundles") !== "0"; // default on
  // Pack count: prefer our SKU tables, else the count parsed from the title
  // (titlePackCount, backfilled by walmart-backfill-pack.ts) so the filter sees
  // the full multipack catalog, not just the ~30 SKUs with a recorded pack.
  const packExpr = `COALESCE((SELECT unitsInListing FROM SkuShippingData WHERE sku=q.sku LIMIT 1),(SELECT packSize FROM SkuCost WHERE sku=q.sku LIMIT 1),q.titlePackCount,1)`;
  const where: string[] = ["q.storeIndex=?"];
  const args: any[] = [];
  where.push(`${packExpr} BETWEEN ? AND ?`); args.push(packMin, packMax);
  if (lqMin != null) { where.push(`q.lqScore >= ?`); args.push(lqMin); }
  if (lqMax != null) { where.push(`q.lqScore <= ?`); args.push(lqMax); }
  if (contentMax != null) { where.push(`q.contentScore <= ?`); args.push(contentMax); }
  if (hasIssues) where.push(`q.issueCount > 0`);
  if (excludeBundles) for (const w of BUNDLE_WORDS) { where.push(`LOWER(COALESCE(q.productName,'')) NOT LIKE ?`); args.push(`%${w}%`); }
  where.push(`q.sku NOT IN (SELECT sku FROM WalmartListingRemediation WHERE ok=1)`);
  where.push(`q.sku NOT IN (SELECT sku FROM WalmartRemediationQueue WHERE status IN ('queued','running'))`);
  return { whereSql: where.join(" AND "), args, packExpr };
}

export async function GET(request: NextRequest) {
  const p = new URL(request.url).searchParams;
  const storeIndex = Number(p.get("storeIndex") || 1);
  const { whereSql, args, packExpr } = buildFilter(p);

  // Live counts for the current filter.
  const countRow = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS match,
            SUM(CASE WHEN ${packExpr} >= 4 THEN 1 ELSE 0 END) AS pack4,
            SUM(CASE WHEN q.issueCount > 0 THEN 1 ELSE 0 END) AS withGaps
       FROM WalmartListingQualityItem q WHERE ${whereSql}`,
    storeIndex, ...args,
  )) as Row[];
  const counts = {
    match: Number(countRow[0]?.match || 0),
    pack4: Number(countRow[0]?.pack4 || 0),
    withGaps: Number(countRow[0]?.withGaps || 0),
  };

  // Candidate sample for the list (capped).
  const limit = Math.min(Number(p.get("limit") || 60), 200);
  const cand = (await prisma.$queryRawUnsafe(
    `SELECT q.sku, q.itemId, q.productName, q.lqScore, q.contentScore, q.issueCount, q.issuesSummary,
            q.pageViews30d, q.conversionRate30d, q.gmv30d, q.isInStock, ${packExpr} AS packCount
       FROM WalmartListingQualityItem q WHERE ${whereSql}
      ORDER BY (CASE WHEN ${packExpr} >= 4 THEN 0 ELSE 1 END), q.pageViews30d DESC
      LIMIT ${limit}`,
    storeIndex, ...args,
  )) as Row[];
  const candidates = cand.map((r) => {
    let contentIssues: string[] = [];
    try { const j = JSON.parse(r.issuesSummary || "[]"); if (Array.isArray(j)) contentIssues = j.filter((x: any) => x?.component === "content").map((x: any) => x.title).filter(Boolean); } catch {}
    return { sku: r.sku, itemId: r.itemId, productName: r.productName, packCount: r.packCount, lqScore: r.lqScore, contentScore: r.contentScore, issueCount: r.issueCount, contentIssues, pageViews30d: r.pageViews30d, conversionRate30d: r.conversionRate30d, gmv30d: r.gmv30d, inStock: !!r.isInStock };
  });

  // Content-gap heatmap across all multipack candidates (top recurring content issues).
  const heatRows = (await prisma.$queryRawUnsafe(
    `SELECT issuesSummary FROM WalmartListingQualityItem q WHERE q.storeIndex=? AND ${packExpr} >= 2 AND q.issueCount > 0 LIMIT 2000`,
    storeIndex,
  )) as Row[];
  const heat: Record<string, number> = {};
  for (const r of heatRows) { try { const j = JSON.parse(r.issuesSummary || "[]"); if (Array.isArray(j)) for (const x of j) if (x?.component === "content" && x.title) heat[x.title] = (heat[x.title] || 0) + 1; } catch {} }
  const contentGapHeatmap = Object.entries(heat).map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  // History + summary (before/after impact).
  const hist = (await prisma.$queryRawUnsafe(
    `SELECT sku, buyerItemId, runAt, feedStatus, ok, packCount, newTitle, bulletsCount, imagesCount, descriptionLength, usedAiPolish, notes,
            beforeLqScore, afterLqScore, beforeContentScore, afterContentScore, beforeConversionRate30d, afterConversionRate30d,
            beforePageViews30d, afterPageViews30d, beforeGmv30d, afterGmv30d, afterCapturedAt
       FROM WalmartListingRemediation WHERE storeIndex=? ORDER BY runAt DESC LIMIT 200`, storeIndex,
  )) as Row[];
  const history = hist.map((r) => ({
    sku: r.sku, url: r.buyerItemId ? `https://www.walmart.com/ip/${r.buyerItemId}` : null, runAt: r.runAt,
    feedStatus: r.feedStatus, ok: !!r.ok, packCount: r.packCount, newTitle: r.newTitle, bulletsCount: r.bulletsCount,
    imagesCount: r.imagesCount, descriptionLength: r.descriptionLength, usedAiPolish: !!r.usedAiPolish, notes: r.notes, measured: !!r.afterCapturedAt,
    before: { lq: r.beforeLqScore, content: r.beforeContentScore, conv: r.beforeConversionRate30d, views: r.beforePageViews30d, gmv: r.beforeGmv30d },
    after: { lq: r.afterLqScore, content: r.afterContentScore, conv: r.afterConversionRate30d, views: r.afterPageViews30d, gmv: r.afterGmv30d },
    deltas: { lq: delta(r.afterLqScore, r.beforeLqScore), content: delta(r.afterContentScore, r.beforeContentScore), conv: delta(r.afterConversionRate30d, r.beforeConversionRate30d), views: delta(r.afterPageViews30d, r.beforePageViews30d), gmv: delta(r.afterGmv30d, r.beforeGmv30d) },
  }));
  const measured = history.filter((h) => h.measured);
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const summary = {
    applied: history.filter((h) => h.ok).length, measured: measured.length, pendingMeasure: history.filter((h) => h.ok && !h.measured).length,
    avgLqDelta: avg(measured.map((h) => h.deltas.lq)), avgContentDelta: avg(measured.map((h) => h.deltas.content)),
    avgConvDelta: avg(measured.map((h) => h.deltas.conv)), avgViewsDelta: avg(measured.map((h) => h.deltas.views)),
  };

  const queue = (await prisma.$queryRawUnsafe(
    `SELECT sku, status, queuedAt, feedId, error FROM WalmartRemediationQueue WHERE storeIndex=? AND status IN ('queued','running') ORDER BY queuedAt DESC LIMIT 100`, storeIndex,
  )) as Row[];

  return NextResponse.json({ counts, candidates, contentGapHeatmap, summary, history, queue });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const skus: string[] = Array.isArray(body?.skus) ? body.skus.filter((s: any) => typeof s === "string") : [];
  const scope = body?.scope && typeof body.scope === "object" ? body.scope : null; // {image,gallery,title,bullets,description,attributes}
  const storeIndex = Number(body?.storeIndex || 1);
  if (!skus.length) return NextResponse.json({ error: "no skus" }, { status: 400 });
  let queued = 0;
  for (const sku of skus.slice(0, 500)) {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO WalmartRemediationQueue (id, storeIndex, sku, status, requestedBy, result) VALUES (?, ?, ?, 'queued', 'ui', ?)`,
        randomUUID(), storeIndex, sku, scope ? JSON.stringify({ scope }) : null,
      );
      queued++;
    } catch { /* already queued/running */ }
  }
  return NextResponse.json({ queued, requested: skus.length });
}
