/**
 * GET /api/reference-catalog — the Reference Catalog (Donor DB) table feed.
 * Query params: search, brand, category, retailer, sort (price|ppm|new), limit.
 * Returns products + total/filtered counts + facets (brands/categories/retailers)
 * + daily growth + enrichment-queue summary. Reads the product-centric DonorProduct
 * / DonorOffer / EnrichmentJob tables. See docs/wiki/reference-catalog-engine.md.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";

export const dynamic = "force-dynamic";

function db() {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

const SORTS: Record<string, string> = {
  price: "dp.bestPrice ASC NULLS LAST",
  ppm: "dp.pricePerMeasure ASC NULLS LAST",
  new: "dp.createdAt DESC",
};

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const search = (sp.get("search") || "").trim().toLowerCase();
  const brand = (sp.get("brand") || "").trim();
  const category = (sp.get("category") || "").trim();
  const retailer = (sp.get("retailer") || "").trim();
  const sort = SORTS[sp.get("sort") || "new"] || SORTS.new;
  const limit = Math.min(parseInt(sp.get("limit") || "200"), 1000);

  const conn = db();
  try {
    // Build the shared WHERE for products.
    const where: string[] = [];
    const args: any[] = [];
    if (brand) { where.push("dp.brand = ?"); args.push(brand); }
    if (category) { where.push("dp.category = ?"); args.push(category); }
    if (search) { where.push("(lower(dp.title) LIKE ? OR lower(dp.brand) LIKE ?)"); args.push(`%${search}%`, `%${search}%`); }
    if (retailer) { where.push(`EXISTS (SELECT 1 FROM "DonorOffer" o2 WHERE o2.donorProductId = dp.id AND o2.retailer = ?)`); args.push(retailer); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const products = await conn.execute({
      sql: `SELECT dp.id, dp.brand, dp.title, dp.size, dp.unitMeasure, dp.category, dp.mainImageUrl,
                   dp.bestPrice, dp.bestRetailer, dp.pricePerMeasure,
                   (SELECT COUNT(*) FROM "DonorOffer" o WHERE o.donorProductId = dp.id) AS offerCount,
                   (SELECT o3.productUrl FROM "DonorOffer" o3 WHERE o3.donorProductId = dp.id AND o3.productUrl IS NOT NULL ORDER BY o3.pricePerUnit ASC LIMIT 1) AS bestOfferUrl
            FROM "DonorProduct" dp ${whereSql}
            ORDER BY ${sort} LIMIT ?`,
      args: [...args, limit],
    });

    const total = await conn.execute(`SELECT COUNT(*) n FROM "DonorProduct"`);
    const filtered = await conn.execute({ sql: `SELECT COUNT(*) n FROM "DonorProduct" dp ${whereSql}`, args });

    const brands = await conn.execute(`SELECT brand, COUNT(*) n FROM "DonorProduct" WHERE brand IS NOT NULL AND brand != '' GROUP BY brand ORDER BY n DESC LIMIT 60`);
    const categories = await conn.execute(`SELECT category, COUNT(*) n FROM "DonorProduct" WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY n DESC`);
    const retailers = await conn.execute(`SELECT retailer, COUNT(*) n FROM "DonorOffer" GROUP BY retailer ORDER BY n DESC`);
    const growth = await conn.execute(`SELECT substr(createdAt,1,10) d, COUNT(*) n FROM "DonorProduct" GROUP BY d ORDER BY d`);
    const queue = await conn.execute(`SELECT status, COUNT(*) n FROM "EnrichmentJob" GROUP BY status`);

    return NextResponse.json({
      ok: true,
      products: products.rows,
      total: Number((total.rows[0] as any)?.n || 0),
      filtered: Number((filtered.rows[0] as any)?.n || 0),
      facets: {
        brands: brands.rows,
        categories: categories.rows,
        retailers: retailers.rows,
      },
      growth: growth.rows,
      queue: Object.fromEntries((queue.rows as any[]).map((r) => [r.status, Number(r.n)])),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || "query failed"), products: [], total: 0, filtered: 0, facets: { brands: [], categories: [], retailers: [] }, growth: [], queue: {} });
  }
}
