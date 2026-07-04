/**
 * GET /api/cogs/catalog
 *
 * The SKU-cost catalog — the "record" layer of the COGS engine: every one of our
 * SKUs and its true cost, how we got it (own-brand / exact 1P / line-price / google),
 * and its structural bill-of-materials (SkuComponent rows, each linked to a donor
 * product for full content). This is what the economics + listing tools consume, and
 * what Vladimir looks at to trust coverage ("100% of SKUs must have a number").
 *
 * Query params (all optional):
 *   q         free-text over sku + title
 *   method    own-brand | exact | line-price | google | none  (SKUs with ≥1 such component)
 *   review    "1" → only needsReview
 *   channel   walmart | amazon
 *   status    costed (default) | uncosted   (uncosted = PUBLISHED Walmart with no cost)
 *   limit / offset   pagination (default 50 / 0)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, type Client } from "@libsql/client";

export const dynamic = "force-dynamic";

function db(): Client {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

const num = (v: any): number => Number(v || 0);

export async function GET(request: NextRequest) {
  try {
    return await handle(request);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

async function handle(request: NextRequest) {
  const conn = db();
  const p = new URL(request.url).searchParams;
  const q = (p.get("q") || "").trim().toLowerCase();
  const method = (p.get("method") || "").trim();
  const review = p.get("review") === "1";
  const channel = (p.get("channel") || "").trim().toLowerCase();
  const status = (p.get("status") || "costed").toLowerCase();
  const limit = Math.max(1, Math.min(200, parseInt(p.get("limit") || "50", 10)));
  const offset = Math.max(0, parseInt(p.get("offset") || "0", 10));

  // ── Summary (coverage + method mix) ──────────────────────────────────────
  const wmRem = await conn.execute(`SELECT COUNT(*) AS n FROM WalmartCatalogItem w LEFT JOIN "SkuCost" c ON c.sku=w.sku AND c.source='retail:batch' WHERE w.publishedStatus='PUBLISHED' AND c.sku IS NULL`);
  const wmTot = await conn.execute(`SELECT COUNT(*) AS n FROM WalmartCatalogItem WHERE publishedStatus='PUBLISHED'`);
  const costedTot = await conn.execute(`SELECT COUNT(*) AS n FROM "SkuCost" WHERE source='retail:batch'`);
  const reviewTot = await conn.execute(`SELECT COUNT(*) AS n FROM "SkuCost" WHERE source='retail:batch' AND needsReview=1`);
  const byMethodRows = (await conn.execute(`SELECT costMethod AS m, COUNT(DISTINCT sku) AS n FROM "SkuComponent" GROUP BY costMethod`)).rows;
  const byMethod: Record<string, number> = {};
  for (const r of byMethodRows as any[]) byMethod[r.m || "none"] = num(r.n);

  const wmTotal = num((wmTot.rows[0] as any)?.n);
  const wmRemaining = num((wmRem.rows[0] as any)?.n);
  const summary = {
    walmartTotal: wmTotal,
    walmartCosted: wmTotal - wmRemaining,
    walmartRemaining: wmRemaining,
    walmartCoveragePct: wmTotal ? Math.round(((wmTotal - wmRemaining) / wmTotal) * 1000) / 10 : 0,
    costedTotal: num((costedTot.rows[0] as any)?.n),
    needsReview: num((reviewTot.rows[0] as any)?.n),
    byMethod,
  };

  // ── UNCOSTED rows: PUBLISHED Walmart SKUs with no cost yet ────────────────
  if (status === "uncosted") {
    const args: any[] = [];
    let where = `w.publishedStatus='PUBLISHED' AND c.sku IS NULL`;
    if (q) { where += ` AND (lower(w.sku) LIKE ? OR lower(w.title) LIKE ?)`; args.push(`%${q}%`, `%${q}%`); }
    const rows = (await conn.execute({
      sql: `SELECT w.sku, w.title FROM WalmartCatalogItem w
            LEFT JOIN "SkuCost" c ON c.sku=w.sku AND c.source='retail:batch'
            WHERE ${where} ORDER BY w.syncedAt DESC LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    })).rows;
    return NextResponse.json({
      ok: true,
      summary,
      status,
      rows: (rows as any[]).map((r) => ({ sku: r.sku, title: r.title, channel: "walmart", costed: false })),
      nextOffset: rows.length === limit ? offset + limit : null,
    });
  }

  // ── COSTED rows: SkuCost joined to title + method + component count ───────
  const args: any[] = [];
  const conds: string[] = [`c.source='retail:batch'`];
  if (q) { conds.push(`(lower(c.sku) LIKE ? OR lower(COALESCE(w.title, ssd.productTitle, ssd.baseUnitDesc)) LIKE ?)`); args.push(`%${q}%`, `%${q}%`); }
  if (review) conds.push(`c.needsReview=1`);
  if (method) { conds.push(`EXISTS (SELECT 1 FROM "SkuComponent" sc WHERE sc.sku=c.sku AND sc.costMethod=?)`); args.push(method); }
  if (channel === "walmart") conds.push(`w.sku IS NOT NULL`);
  else if (channel === "amazon") conds.push(`w.sku IS NULL`);

  const rows = (await conn.execute({
    sql: `SELECT c.sku, c.totalCost, c.costPerUnit, c.packSize, c.confidence, c.needsReview, c.notes, c.updatedAt,
                 COALESCE(w.title, ssd.productTitle, ssd.baseUnitDesc) AS title,
                 (SELECT COUNT(*) FROM "SkuComponent" sc WHERE sc.sku=c.sku) AS compCount,
                 (SELECT GROUP_CONCAT(DISTINCT sc.costMethod) FROM "SkuComponent" sc WHERE sc.sku=c.sku) AS methods,
                 CASE WHEN w.sku IS NOT NULL THEN 'walmart' ELSE 'amazon' END AS channel
          FROM "SkuCost" c
          LEFT JOIN WalmartCatalogItem w ON w.sku=c.sku
          LEFT JOIN SkuShippingData ssd ON ssd.sku=c.sku
          WHERE ${conds.join(" AND ")}
          ORDER BY c.needsReview DESC, c.updatedAt DESC
          LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  })).rows;

  // Attach the bill-of-materials for the returned SKUs (one round-trip).
  const skus = (rows as any[]).map((r) => r.sku);
  const compsBySku: Record<string, any[]> = {};
  if (skus.length) {
    const placeholders = skus.map(() => "?").join(",");
    const comps = (await conn.execute({
      sql: `SELECT sku, idx, product, flavor, size, qty, perUnitCost, lineCost, retailer, costMethod, donorProductId, isBundleComponent
            FROM "SkuComponent" WHERE sku IN (${placeholders}) ORDER BY sku, idx`,
      args: skus,
    })).rows;
    for (const c of comps as any[]) {
      (compsBySku[c.sku] ||= []).push({
        idx: num(c.idx), product: c.product, flavor: c.flavor, size: c.size, qty: num(c.qty),
        perUnitCost: c.perUnitCost, lineCost: c.lineCost, retailer: c.retailer,
        costMethod: c.costMethod, donorProductId: c.donorProductId, isBundleComponent: !!num(c.isBundleComponent),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    summary,
    status,
    rows: (rows as any[]).map((r) => ({
      sku: r.sku,
      title: r.title,
      channel: r.channel,
      costed: true,
      totalCost: r.totalCost,
      costPerUnit: r.costPerUnit,
      packSize: num(r.packSize),
      confidence: r.confidence,
      needsReview: !!num(r.needsReview),
      notes: r.notes,
      updatedAt: r.updatedAt,
      compCount: num(r.compCount),
      methods: (r.methods || "").split(",").filter(Boolean),
      components: compsBySku[r.sku] || [],
    })),
    nextOffset: rows.length === limit ? offset + limit : null,
  });
}
