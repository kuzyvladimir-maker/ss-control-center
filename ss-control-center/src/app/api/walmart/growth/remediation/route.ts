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
  // Base = full catalog (WalmartCatalogItem w) so unpublished/error listings show
  // too; scores (q) + sales (perf) are LEFT-joined and may be null.
  const packExpr = `COALESCE((SELECT unitsInListing FROM SkuShippingData WHERE sku=w.sku LIMIT 1),(SELECT packSize FROM SkuCost WHERE sku=w.sku LIMIT 1),w.titlePackCount,1)`;
  const where: string[] = ["w.storeIndex=?"];
  const args: any[] = [];
  where.push(`${packExpr} BETWEEN ? AND ?`); args.push(packMin, packMax);
  // Guard score filters so the default (0..100) never drops null-score (unpublished) rows.
  if (lqMin != null && lqMin > 0) { where.push(`q.lqScore >= ?`); args.push(lqMin); }
  if (lqMax != null && lqMax < 100) { where.push(`q.lqScore <= ?`); args.push(lqMax); }
  if (contentMax != null && contentMax < 100) { where.push(`q.contentScore <= ?`); args.push(contentMax); }
  if (hasIssues) where.push(`COALESCE(q.issueCount,0) > 0`);
  if (excludeBundles) for (const bw of BUNDLE_WORDS) { where.push(`LOWER(COALESCE(w.title,'')) NOT LIKE ?`); args.push(`%${bw}%`); }
  where.push(`w.sku NOT IN (SELECT sku FROM WalmartListingRemediation WHERE ok=1)`);
  where.push(`w.sku NOT IN (SELECT sku FROM WalmartRemediationQueue WHERE status IN ('queued','running'))`);

  // Performance window (sales/units/returns from our own orders) + perf filters.
  const periodRaw = Number(p.get("period") ?? 30);
  const period = [30, 90, 180].includes(periodRaw) ? periodRaw : 30;
  const S = `COALESCE(perf.sales${period},0)`, U = `COALESCE(perf.units${period},0)`, O = `COALESCE(perf.orders${period},0)`, R = `COALESCE(perf.returns${period},0)`;
  const VIEWS = `COALESCE(q.pageViews30d,0)`;
  const num = (k: string) => (p.get(k) != null && p.get(k) !== "" ? Number(p.get(k)) : null);
  // Two-sided ranges: min + max for sales / units / reviews / return-rate.
  const rng = (k: string, expr: string, max: number) => {
    const lo = num("min" + k), hi = num("max" + k);
    if (lo != null && lo > 0) where.push(`${expr} >= ${lo}`);
    if (hi != null && hi < max) where.push(`${expr} <= ${hi}`);
  };
  rng("Sales", S, 1000);
  rng("Units", U, 50);
  rng("Reviews", "COALESCE(q.ratingCount,0)", 50);
  rng("ReturnPct", `(${R}*100.0/NULLIF(${U},0))`, 100);
  const maxConvPct = num("maxConvPct"); if (maxConvPct != null && maxConvPct < 100) where.push(`(${U}*100.0/NULLIF(${VIEWS},0)) <= ${maxConvPct}`);

  // Health-type filter (chips).
  const health = p.get("health");
  const HEALTH_SQL: Record<string, string> = {
    winner: `${U} > 0`,
    leaky: `${U} = 0 AND ${VIEWS} >= 20`,
    "high-return": `${U} >= 3 AND (${R}*1.0/NULLIF(${U},0)) >= 0.15`,
    dead: `${VIEWS} = 0 AND COALESCE(q.ratingCount,0) = 0`,
    new: `${U} = 0 AND ${VIEWS} < 20 AND (${VIEWS} > 0 OR COALESCE(q.ratingCount,0) > 0)`,
  };
  if (health && HEALTH_SQL[health]) where.push(`(${HEALTH_SQL[health]})`);

  // Listing status (published / unpublished / error) from the catalog mirror.
  const status = p.get("status");
  const STATUS_SQL: Record<string, string> = { published: "PUBLISHED", unpublished: "UNPUBLISHED", error: "SYSTEM_PROBLEM" };
  if (status && STATUS_SQL[status]) where.push(`w.publishedStatus = '${STATUS_SQL[status]}'`);

  const sortKey = p.get("sort") || "views";
  const SORTS: Record<string, string> = {
    sales: `${S} DESC`, units: `${U} DESC`, views: `${VIEWS} DESC`,
    conv: `(${U}*1.0/NULLIF(${VIEWS},0)) DESC`, reviews: `COALESCE(q.ratingCount,0) DESC`,
    returnRate: `(${R}*1.0/NULLIF(${U},0)) DESC`, lq: `q.lqScore ASC`,
  };
  const sortSql = SORTS[sortKey] || SORTS.views;
  return { whereSql: where.join(" AND "), args, packExpr, period, S, U, O, R, VIEWS, sortSql };
}

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
    `SELECT sku, status, queuedAt, feedId, error FROM WalmartRemediationQueue WHERE storeIndex=? AND status IN ('queued','running') ORDER BY queuedAt DESC LIMIT 100`, storeIndex,
  )) as Row[];

  return NextResponse.json({ period, counts, candidates, contentGapHeatmap, summary, history, queue, page: { limit, offset, total: counts.match } });
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
