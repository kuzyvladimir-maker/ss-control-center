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

// nutritionFacts is stored as JSON (object or array) OR plain text. Normalize to
// a {label,value}[] list for the UI when it's structured, else keep the raw text.
function parseNutrition(s: any): { rows: { label: string; value: string }[]; raw: string | null } {
  if (s == null || s === "") return { rows: [], raw: null };
  const raw = String(s);
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) {
      const rows = j.map((x: any) => {
        if (x && typeof x === "object") return { label: String(x.name ?? x.label ?? x.key ?? ""), value: String(x.value ?? x.amount ?? x.qty ?? "") };
        return { label: "", value: String(x) };
      }).filter((r) => r.label || r.value);
      return { rows, raw };
    }
    if (j && typeof j === "object") {
      const rows = Object.entries(j).map(([k, v]) => ({ label: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) }));
      return { rows, raw };
    }
  } catch { /* plain text */ }
  return { rows: [], raw };
}

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
    // attributes can be a JSON array of {name,value} OR a JSON object {key:value}.
    let attributes: { name: string; value: string }[] = [];
    try {
      const a = JSON.parse(p.attributes || "[]");
      if (Array.isArray(a)) attributes = a.map((x: any) => ({ name: String(x?.name ?? x?.key ?? ""), value: String(x?.value ?? "") })).filter((x) => x.name || x.value);
      else if (a && typeof a === "object") attributes = Object.entries(a).map(([k, v]) => ({ name: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) }));
    } catch { /* ignore */ }

    const nutrition = parseNutrition(p.nutritionFacts);
    const product = {
      ...p,
      imageUrls: parseArr(p.imageUrls),
      bullets: parseArr(p.bullets),
      attributes,
      nutritionRows: nutrition.rows,
      nutritionRaw: nutrition.raw,
    };
    return NextResponse.json({ ok: true, product, offers: offers.rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || "query failed") }, { status: 500 });
  }
}
