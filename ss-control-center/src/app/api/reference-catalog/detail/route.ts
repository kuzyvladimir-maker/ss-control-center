/**
 * GET /api/reference-catalog/detail?id=<DonorProduct.id>
 * Full product detail for the catalog drawer: all harvested content (gallery,
 * description, bullets, ingredients, nutrition, specs, UPC) + every retailer offer.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";

export const dynamic = "force-dynamic";

function db() {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

const parseArr = (s: any): any[] => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const conn = db();
  try {
    const pr = await conn.execute({ sql: `SELECT * FROM "DonorProduct" WHERE id=? LIMIT 1`, args: [id] });
    if (!pr.rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const p: any = pr.rows[0];
    const offers = await conn.execute({
      sql: `SELECT retailer, retailerProductId, via, price, packSizeSeen, pricePerUnit, currency, zip, inStock, productUrl, sellerName, isFirstParty, sourceApi, fetchedAt
            FROM "DonorOffer" WHERE donorProductId=? ORDER BY pricePerUnit ASC`,
      args: [id],
    });
    const product = {
      ...p,
      imageUrls: parseArr(p.imageUrls),
      bullets: parseArr(p.bullets),
      attributes: parseArr(p.attributes),
    };
    return NextResponse.json({ ok: true, product, offers: offers.rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || "query failed") }, { status: 500 });
  }
}
