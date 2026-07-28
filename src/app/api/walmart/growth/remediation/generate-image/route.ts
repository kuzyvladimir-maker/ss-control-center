/**
 * POST /api/walmart/growth/remediation/generate-image  { sku }
 *
 * MANUAL generation lever (Vladimir 2026-06-30): when the deterministic cutout
 * can't produce a good main image for a listing (e.g. no clean donor front),
 * generate an N-unit AI main image (gpt-image-2, free Codex worker). Returns a
 * PREVIEW url only — publishes nothing. The operator reviews it, then calls
 * apply-generated to push it. NOT the default engine (cutout is; ~270× faster).
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { generateMainForSku } from "@/lib/walmart/multipack/generate-main";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // generation runs ~80–240s

function db() {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

export async function POST(request: NextRequest) {
  let sku = "";
  try { sku = String((await request.json())?.sku || "").trim(); } catch {}
  if (!sku) return NextResponse.json({ error: "sku required" }, { status: 400 });

  const storeIndex = Number(new URL(request.url).searchParams.get("storeIndex") || 1);
  const conn = db();
  try {
    const t = await conn.execute({ sql: `SELECT title FROM WalmartCatalogItem WHERE sku=? AND storeIndex=? LIMIT 1`, args: [sku, storeIndex] });
    const title = (t.rows[0] as any)?.title || "";
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Math.floor(Date.now() % 100000);
    const r = await generateMainForSku(conn, sku, { title, storeIndex, stamp });
    if (!r.previewUrl) return NextResponse.json({ ok: false, ...r }, { status: 200 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
