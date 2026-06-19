/**
 * POST /api/reference-catalog/harvest — Phase 3 full content harvest (selective).
 *   body: { productId } — harvest one product, OR
 *          { brand, limit? } — harvest that brand's products that still lack content.
 * Each product = 1 BlueCart detail credit, so this is on-demand (never blanket on
 * the whole catalog). Guarded by a BlueCart credit floor.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { harvestDonorDetail } from "@/lib/sourcing/donor-catalog";
import { bluecartCreditsRemaining } from "@/lib/sourcing/enrich";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const CREDIT_FLOOR = 300;

function db() {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({} as any));
  const productId = body?.productId ? String(body.productId) : null;
  const brand = body?.brand ? String(body.brand).trim() : null;
  const limit = Math.min(parseInt(body?.limit || "20"), 50);
  if (!productId && !brand) return NextResponse.json({ error: "productId or brand required" }, { status: 400 });

  const conn = db();
  const credits = await bluecartCreditsRemaining();
  if (credits != null && credits <= CREDIT_FLOOR) {
    return NextResponse.json({ ok: false, error: `BlueCart credits at floor (${credits}) — harvest paused` }, { status: 429 });
  }

  let ids: string[] = [];
  if (productId) {
    ids = [productId];
  } else {
    // brand: products that still lack a full gallery (and have a Walmart offer to detail).
    const rows = await conn.execute({
      sql: `SELECT dp.id FROM "DonorProduct" dp
            WHERE dp.brand = ?
              AND (dp.imageUrls IS NULL OR json_array_length(dp.imageUrls) < 3)
              AND EXISTS (SELECT 1 FROM "DonorOffer" o WHERE o.donorProductId = dp.id AND o.retailer='walmart')
            LIMIT ?`,
      args: [brand, limit],
    });
    ids = (rows.rows as any[]).map((r) => r.id);
  }

  let harvested = 0, images = 0, withUpc = 0, merged = 0;
  const errors: string[] = [];
  for (const id of ids) {
    const r = await harvestDonorDetail(conn, id);
    if (r.ok) { harvested++; images += r.images; if (r.upc) withUpc++; merged += r.merged; }
    else if (r.reason) errors.push(r.reason);
  }
  return NextResponse.json({ ok: true, requested: ids.length, harvested, totalImages: images, withUpc, merged, creditsRemaining: credits, errors: errors.slice(0, 5) });
}
