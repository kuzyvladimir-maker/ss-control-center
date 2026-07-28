/**
 * Walmart Growth — Listing Optimizer API.
 *
 * GET  → filtered candidate listings + live match counts (driven by the
 *        Builder's sliders: pack size, listing-quality, content score, has-gaps,
 *        exclude-bundles), plus the before/after history and a summary.
 * POST → RETIRED. The legacy queue was drained by the now-retired remediation
 *        worker and bypassed Product Truth/owner action gates.
 *
 * Reads WalmartListingRemediation + WalmartListingQualityItem via raw SQL.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildFilter } from "@/lib/walmart/optimizer-filter";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const RETIREMENT_CODE = "LEGACY_WALMART_REMEDIATION_ENQUEUE_RETIRED";

type Row = Record<string, unknown>;
const delta = (a: unknown, b: unknown): number | null =>
  a != null && b != null ? Number(a) - Number(b) : null;

function issueRows(value: unknown): Row[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
        (item): item is Row =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
      : [];
  } catch {
    return [];
  }
}

async function queueProgress(storeIndex: number) {
  const statRows = (await prisma.$queryRawUnsafe(
    `SELECT status, COUNT(*) AS c FROM WalmartRemediationQueue
      WHERE storeIndex=? AND (status IN ('queued','running','submitted','held') OR (status IN ('done','error','skipped') AND COALESCE(finishedAt, queuedAt) >= datetime('now','-24 hours')))
      GROUP BY status`, storeIndex,
  )) as Row[];
  const queueStats: Record<string, number> = { queued: 0, running: 0, submitted: 0, held: 0, done: 0, error: 0, skipped: 0 };
  for (const r of statRows) queueStats[String(r.status)] = Number(r.c || 0);
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
  return { queueStats, progress: { elapsedMin, ratePerHour, remaining, etaHours, finished: Number(progRow[0]?.finished || 0) } };
}

export async function GET(request: NextRequest) {
  const p = new URL(request.url).searchParams;
  const storeIndex = Number(p.get("storeIndex") || 1);

  // Lightweight poll: only the live counters + ETA. Used by the module's
  // auto-refresh so it doesn't re-read the heavy candidate/heatmap/history rows
  // every few seconds (that read amplification is what exhausted the DB quota).
  if (p.get("light") === "1") {
    const { queueStats, progress } = await queueProgress(storeIndex);
    return NextResponse.json({ light: true, queueStats, progress });
  }

  const { whereSql, args, packExpr, period, S, U, O, R, sortSql } = buildFilter(p);
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
    let issues: { component: string; label: string; title: string; detail: string; impact: string }[] = [];
    const parsedIssues = issueRows(r.issuesSummary);
    contentIssues = parsedIssues
      .filter((item) => item.component === "content" && item.title)
      .map((item) => String(item.title));
    // Full per-issue list (all components) — Walmart's own diagnosis, surfaced
    // inline so the Optimizer is both the diagnosis and the fix.
    issues = parsedIssues
      .filter((item) => item.title)
      .map((item) => ({
        component: String(item.component || ""),
        label: String(item.componentLabel || item.component || ""),
        title: String(item.title || ""),
        detail: String(item.detail || ""),
        impact: String(item.impact || ""),
      }))
      .slice(0, 20);
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
      lqScore: r.lqScore, contentScore: r.contentScore, issueCount: r.issueCount, contentIssues, issues,
      pageViews30d: views, reviews: Number(r.ratingCount || 0), inStock: !!r.isInStock, status: r.status || null,
      sales: Number(r.sales || 0), units, orders: Number(r.orders || 0), returns, conv, returnRate, health,
    };
  });

  // Content-gap heatmap across all multipack candidates (top recurring content issues).
  const heatRows = (await prisma.$queryRawUnsafe(
    `SELECT issuesSummary FROM WalmartListingQualityItem q WHERE q.storeIndex=? AND COALESCE(q.titlePackCount,1) >= 2 AND q.issueCount > 0 LIMIT 500`,
    storeIndex,
  )) as Row[];
  const heat: Record<string, number> = {};
  for (const row of heatRows) {
    for (const issue of issueRows(row.issuesSummary)) {
      if (issue.component !== "content" || !issue.title) continue;
      const title = String(issue.title);
      heat[title] = (heat[title] || 0) + 1;
    }
  }
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

  // Live worker progress + ETA (shared with the lightweight poll).
  const { queueStats, progress } = await queueProgress(storeIndex);

  // Seller-level Listing Quality headline (Walmart's own score + 6 components) for
  // the health strip — folds the old Listing Quality tab into the Optimizer.
  // Non-critical header strip — never let it blank the whole Optimizer if it fails.
  let snap: Row[] = [];
  try {
    snap = (await prisma.$queryRawUnsafe(
      `SELECT listingQuality, contentScore, transactibilityScore, priceScore, offerScore, ratingReviewScore, shippingScore
         FROM WalmartListingQualitySnapshot WHERE storeIndex=? ORDER BY capturedAt DESC LIMIT 1`, storeIndex,
    )) as Row[];
  } catch { /* snapshot table optional — fall back to no seller score */ }
  const s0 = snap[0];
  const sellerScore = s0 ? {
    listingQuality: Number(s0.listingQuality),
    components: [
      { label: "Content", score: s0.contentScore != null ? Number(s0.contentScore) : null },
      { label: "Published & in stock", score: s0.transactibilityScore != null ? Number(s0.transactibilityScore) : null },
      { label: "Price", score: s0.priceScore != null ? Number(s0.priceScore) : null },
      { label: "Offer", score: s0.offerScore != null ? Number(s0.offerScore) : null },
      { label: "Ratings & reviews", score: s0.ratingReviewScore != null ? Number(s0.ratingReviewScore) : null },
      { label: "Shipping speed", score: s0.shippingScore != null ? Number(s0.shippingScore) : null },
    ],
  } : null;

  return NextResponse.json({ period, counts, candidates, contentGapHeatmap, summary, history, queue, queueStats, progress, sellerScore, page: { limit, offset, total: counts.match } });
}

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code: RETIREMENT_CODE,
      reason:
        "Legacy Walmart remediation enqueue is disabled. Use the manifest-bound Product Truth preview and a separate owner action gate.",
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}
