/**
 * GET /api/cron/reference-harvest-worker
 *
 * Auto-completes the Reference Catalog: finds products that still lack a full
 * gallery and harvests their BlueCart detail (≥5 photos, nutrition, ingredients,
 * UPC) THEN runs the vision image-QC — so every product ends up with full content
 * and a clean single-unit FRONT thumbnail (or a needsReview flag). 1 BlueCart +
 * 1 cheap Haiku vision call per product. Credit-floor guarded so it never drains
 * the monthly allotment. Self-terminating: a harvested product drops out of the
 * queue. Same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { harvestDonorDetail } from "@/lib/sourcing/donor-catalog";
import { bluecartCreditsRemaining } from "@/lib/sourcing/enrich";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HARVEST_PER_TICK = 18;
const TIME_BUDGET_MS = 250_000;
const CREDIT_FLOOR = 350; // above the enrichment floor so the two workers don't both drain to 0

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

function db() {
  const url = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim().replace(/^['"]|['"]$/g, "") || undefined;
  return createClient({ url, authToken });
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;
  const started = Date.now();
  const conn = db();
  const out = { harvested: 0, images: 0, withUpc: 0, flagged: 0, errors: 0 };

  const credits = await bluecartCreditsRemaining();
  (out as any).bluecartCredits = credits;
  if (credits != null && credits <= CREDIT_FLOOR) {
    return NextResponse.json({ ok: true, paused: "bluecart credits at/below floor", ...out });
  }

  // Products still lacking a full gallery, that have a Walmart offer to detail.
  const rows = await conn.execute({
    sql: `SELECT dp.id FROM "DonorProduct" dp
          WHERE (dp.imageUrls IS NULL OR json_array_length(dp.imageUrls) < 3)
            AND EXISTS (SELECT 1 FROM "DonorOffer" o WHERE o.donorProductId = dp.id AND o.retailer='walmart')
          ORDER BY dp.updatedAt ASC LIMIT 60`,
    args: [],
  });
  const ids = (rows.rows as any[]).map((r) => r.id);

  for (const id of ids) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    if (out.harvested + out.errors >= HARVEST_PER_TICK) break;
    try {
      const r = await harvestDonorDetail(conn, id);
      if (r.ok) { out.harvested++; out.images += r.images; if (r.upc) out.withUpc++; if (r.imageFlagged) out.flagged++; }
      else out.errors++;
    } catch { out.errors++; }
  }

  return NextResponse.json({ ok: true, tookMs: Date.now() - started, ...out });
}
