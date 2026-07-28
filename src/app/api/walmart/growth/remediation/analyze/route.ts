/**
 * Listing Optimizer — AI analyst. POST with the same filter query params as the
 * candidates route; analyzes the filtered pool and returns a narrative + split
 * recommendations (auto = our engine can apply; advisory = needs manual ops).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildFilter, OPTIMIZER_JOIN } from "@/lib/walmart/optimizer-filter";
import { analyzePool, PoolListing } from "@/lib/walmart/multipack/analyst";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Claude analysis of up to 60 listings can take >15s
type Row = Record<string, any>;

export async function POST(request: NextRequest) {
  const p = new URL(request.url).searchParams;
  const storeIndex = Number(p.get("storeIndex") || 1);
  const { whereSql, args, packExpr, period, S, U, O, R, VIEWS } = buildFilter(p);

  // If the Builder has rows checked, analyze exactly those (overrides the filter
  // pool). Otherwise analyze the top-60 of the current filter by traffic.
  const body = await request.json().catch(() => ({}));
  const onlySkus: string[] = Array.isArray(body?.skus) ? body.skus.filter((s: any) => typeof s === "string").slice(0, 60) : [];

  let scopeSql = whereSql, scopeArgs = args;
  if (onlySkus.length) {
    scopeSql = `w.storeIndex=? AND w.sku IN (${onlySkus.map(() => "?").join(",")})`;
    scopeArgs = onlySkus;
  }

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT w.sku, COALESCE(w.title, q.productName) AS name, w.publishedStatus AS status, ${packExpr} AS pack,
            q.lqScore, q.contentScore, q.issuesSummary, q.pageViews30d, q.ratingCount, q.isInStock,
            ${S} AS sales, ${U} AS units, ${R} AS returns
       FROM WalmartCatalogItem w ${OPTIMIZER_JOIN} WHERE ${scopeSql}
      ORDER BY ${VIEWS} DESC LIMIT 60`,
    storeIndex, ...scopeArgs,
  )) as Row[];

  if (!rows.length) return NextResponse.json({ narrative: "No listings match the current filter — nothing to analyze.", recommendations: [] });

  const listings: PoolListing[] = rows.map((r) => {
    let issues: string[] = [];
    try { const j = JSON.parse(r.issuesSummary || "[]"); if (Array.isArray(j)) issues = j.map((x: any) => `[${x.impact}] ${x.componentLabel}: ${x.title}`).slice(0, 8); } catch {}
    const units = Number(r.units || 0), views = Number(r.pageViews30d || 0);
    return {
      sku: r.sku, name: r.name || r.sku, status: r.status || null, pack: r.pack != null ? Number(r.pack) : null,
      lq: r.lqScore != null ? Number(r.lqScore) : null, content: r.contentScore != null ? Number(r.contentScore) : null,
      sales: Number(r.sales || 0), units, conv: views > 0 ? units / views : null, views,
      reviews: Number(r.ratingCount || 0), returns: Number(r.returns || 0), inStock: !!r.isInStock, issues,
    };
  });

  const sum = (f: (l: PoolListing) => number) => listings.reduce((a, l) => a + f(l), 0);
  const aggregates = {
    count: listings.length,
    totalSales: Math.round(sum((l) => l.sales)),
    totalUnits: sum((l) => l.units),
    outOfStock: listings.filter((l) => !l.inStock).length,
    zeroSales: listings.filter((l) => l.units === 0).length,
    totalViews: sum((l) => l.views),
    avgLq: Math.round(sum((l) => l.lq || 0) / listings.length),
    avgContent: Math.round(sum((l) => l.content || 0) / listings.length),
  };

  try {
    const analysis = await analyzePool({ period, aggregates, listings });
    return NextResponse.json({ ...analysis, analyzed: listings.length });
  } catch (e) {
    const msg = (e as Error).message || "unknown error";
    console.error(`[analyze] ${msg}`);
    return NextResponse.json({ error: "analysis_failed", narrative: `Analyst error: ${msg}`, recommendations: [] }, { status: 200 });
  }
}
