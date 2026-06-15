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
import { buildFilter, OPTIMIZER_JOIN } from "@/lib/walmart/optimizer-filter";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const ENQUEUE_CAP = 3000;

type Row = Record<string, any>;
const delta = (a: any, b: any): number | null => (a != null && b != null ? Number(a) - Number(b) : null);

export async function GET(request: NextRequest) {
  const p = new URL(request.url).searchParams;
  const storeIndex = Number(p.get("storeIndex") || 1);
  const { whereSql, args, packExpr, period, S, U, O, R, VIEWS, sortSql } = buildFilter(p);
  const JOIN = `LEFT JOIN WalmartListingQualityItem q ON q.sku=w.sku AND q.storeIndex=w.storeIndex
                LEFT JOIN WalmartSkuPerf perf ON perf.sku=w.sku AND perf.storeIndex=w.storeIndex`;

  // Live counts for the current filter (over the whole catalog).
  const countRow = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS match,
            SUM(CASE WHEN ${packExpr} >= 4 THEN 1 ELSE 0 END) AS pack4,
            SUM(CASE WHEN COALESCE(q.issueCount,0) > 0 THEN 1 ELSE 0 END) AS withGaps
       FROM WalmartCatalogItem w ${JOIN} WHERE ${whereSql}`,
    storeIndex, ...args,
  )) as Row[];
  const counts = { match: Number(countRow[0]?.match || 0), pack4: Number(countRow[0]?.pack4 || 0), withGaps: Number(countRow[0]?.withGaps || 0) };

  // Candidate page (paginated), with performance for the chosen period.
  const limit = Math.min(Number(p.get("limit") || 50), 200);
  const offset = Math.max(Number(p.get("offset") || 0), 0);
  const cand = (await prisma.$queryRawUnsafe(
    `SELECT w.sku, w.itemId, COALESCE(w.title, q.productName) AS productName, q.lqScore, q.contentScore, q.issueCount, q.issuesSummary,
            q.pageViews30d, q.ratingCount, q.isInStock, ${packExpr} AS packCount, w.publishedStatus AS status,
            ${S} AS sales, ${U} AS units, ${O} AS orders, ${R} AS returns
       FROM WalmartCatalogItem w ${JOIN} WHERE ${whereSql}
      ORDER BY ${sortSql} LIMIT ${limit} OFFSET ${offset}`,
    storeIndex, ...args,
  )) as Row[];
  const candidates = cand.map((r) => {
    let contentIssues: string[] = [];
    try { const j = JSON.parse(r.issuesSummary || "[]"); if (Array.isArray(j)) contentIssues = j.filter((x: any) => x?.component === "content").map((x: any) => x.title).filter(Boolean); } catch {}
    const units = Number(r.units || 0), views = Number(r.pageViews30d || 0), returns = Number(r.returns || 0);
    const conv = views > 0 ? units / views : null;
    const returnRate = units > 0 ? returns / units : null;
    // Health badge — prioritized.
    let health = "new";
    if (returnRate != null && returnRate >= 0.15 && units >= 3) health = "high-return";
    else if (units > 0) health = "winner";
    else if (views >= 20) health = "leaky";
    else if (views === 0 && (r.ratingCount ?? 0) === 0) health = "dead";
    return {
      sku: r.sku, itemId: r.itemId, productName: r.productName, packCount: r.packCount,
      lqScore: r.lqScore, contentScore: r.contentScore, issueCount: r.issueCount, contentIssues,
      pageViews30d: views, reviews: Number(r.ratingCount || 0), inStock: !!r.isInStock, status: r.status || null,
      sales: Number(r.sales || 0), units, orders: Number(r.orders || 0), returns, conv, returnRate, health,
    };
  });

  // Content-gap heatmap across all multipack candidates (top recurring content issues).
  const heatRows = (await prisma.$queryRawUnsafe(
    `SELECT issuesSummary FROM WalmartListingQualityItem q WHERE q.storeIndex=? AND COALESCE(q.titlePackCount,1) >= 2 AND q.issueCount > 0 LIMIT 2000`,
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
    `SELECT sku, status, queuedAt, feedId, error FROM WalmartRemediationQueue WHERE storeIndex=? AND status IN ('queued','running','submitted') ORDER BY queuedAt DESC LIMIT 100`, storeIndex,
  )) as Row[];

  // Live progress of the worker: counts per status (done/error since 24h so the
  // bar reflects the current batch, not all-time history).
  const statRows = (await prisma.$queryRawUnsafe(
    `SELECT status, COUNT(*) AS c FROM WalmartRemediationQueue
      WHERE storeIndex=? AND (status IN ('queued','running','submitted','held') OR (status IN ('done','error','skipped') AND COALESCE(finishedAt, queuedAt) >= datetime('now','-24 hours')))
      GROUP BY status`, storeIndex,
  )) as Row[];
  const queueStats: Record<string, number> = { queued: 0, running: 0, submitted: 0, held: 0, done: 0, error: 0, skipped: 0 };
  for (const r of statRows) queueStats[String(r.status)] = Number(r.c || 0);

  // Processing ETA: elapsed since the run started + a smoothed throughput (last
  // 2h) → estimated time remaining for everything still pending.
  const progRow = (await prisma.$queryRawUnsafe(
    `SELECT (julianday('now') - julianday(MIN(queuedAt))) * 24 * 60 AS elapsedMin,
            (SELECT COUNT(*) FROM WalmartRemediationQueue WHERE storeIndex=? AND status IN ('done','error','skipped') AND finishedAt >= datetime('now','-120 minutes')) AS fin2h,
            (SELECT COUNT(*) FROM WalmartRemediationQueue WHERE storeIndex=? AND status IN ('done','error','skipped')) AS finished
       FROM WalmartRemediationQueue WHERE storeIndex=?`,
    storeIndex, storeIndex, storeIndex,
  )) as Row[];
  const elapsedMin = Number(progRow[0]?.elapsedMin || 0);
  const ratePerHour = Number(progRow[0]?.fin2h || 0) / 2;
  const remaining = queueStats.held + queueStats.queued + queueStats.running + queueStats.submitted;
  const etaHours = ratePerHour > 0.2 ? remaining / ratePerHour : null;
  const progress = { elapsedMin, ratePerHour, remaining, etaHours, finished: Number(progRow[0]?.finished || 0) };

  return NextResponse.json({ period, counts, candidates, contentGapHeatmap, summary, history, queue, queueStats, progress, page: { limit, offset, total: counts.match } });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const scope = body?.scope && typeof body.scope === "object" ? body.scope : null; // {image,gallery,title,bullets,description,attributes}
  const storeIndex = Number(body?.storeIndex || 1);

  // Two modes: explicit `skus` (checked rows), or `allMatching` → enqueue the
  // ENTIRE filtered pool (thousands), resolved server-side from the same filter.
  let skus: string[] = Array.isArray(body?.skus) ? body.skus.filter((s: any) => typeof s === "string") : [];
  if (body?.allMatching) {
    const { whereSql, args } = buildFilter(new URL(request.url).searchParams);
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT w.sku FROM WalmartCatalogItem w ${OPTIMIZER_JOIN} WHERE ${whereSql} LIMIT ${ENQUEUE_CAP}`,
      storeIndex, ...args,
    )) as Row[];
    skus = rows.map((r) => String(r.sku));
  }
  if (!skus.length) return NextResponse.json({ error: "no skus" }, { status: 400 });

  // Batched, dedup-tolerant insert (OR IGNORE skips SKUs already queued/running).
  const requested = Math.min(skus.length, ENQUEUE_CAP);
  let queued = 0;
  for (let i = 0; i < requested; i += 100) {
    const chunk = skus.slice(i, i + 100);
    const values = chunk.map(() => "(?, ?, ?, 'queued', 'ui', ?)").join(", ");
    const flat: any[] = [];
    for (const sku of chunk) flat.push(randomUUID(), storeIndex, sku, scope ? JSON.stringify({ scope }) : null);
    try {
      const r = await prisma.$executeRawUnsafe(`INSERT OR IGNORE INTO WalmartRemediationQueue (id, storeIndex, sku, status, requestedBy, result) VALUES ${values}`, ...flat);
      queued += Number(r) || 0;
    } catch { /* chunk-level guard */ }
  }
  return NextResponse.json({ queued, requested });
}
