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
 *
 * ⛔ CRON PAUSED 2026-07-12 (removed from vercel.json). Root cause of the slow
 * Unwrangle drain (~500 cr/hr): the eligibility query re-selects any product still
 * missing a description, and ~1,185 Target-only donors STRUCTURALLY never get one
 * (Target detail returns no bullets/description/UPC). The 1h time-gate only delays
 * them — after 1h they re-qualify and get re-harvested forever, 2.5 cr each. Do NOT
 * re-add the cron until the query excludes un-completable rows (e.g. a harvest-
 * attempts cap, or "skip if the only offer is Target and description already tried").
 * The route still works for a deliberate one-shot completion run.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { harvestDonorDetail } from "@/lib/sourcing/donor-catalog";
import { bluecartCreditsRemaining } from "@/lib/sourcing/enrich";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HARVEST_PER_TICK = 48;
const CONCURRENCY = 6; // each product = 1 Unwrangle detail + 1 vision-QC; run a batch at once
const TIME_BUDGET_MS = 250_000;

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

  // Harvest now uses Unwrangle walmart_detail (100k-credit plan, ~2.5/product) —
  // it no longer drains BlueCart, so no BlueCart credit gate. We surface the
  // BlueCart balance for visibility only.
  (out as any).bluecartCredits = await bluecartCreditsRemaining();

  // Products still lacking a full gallery, that have a Walmart offer to detail.
  // Newest-first: a freshly-enriched product gets its full content fast, so the
  // catalog (sorted "newest") never shows a wall of empty rows. The backlog still
  // drains completely because harvested rows fall out of this query.
  // Harvest products missing a gallery OR missing text content (Target search gives
  // many images but no bullets/description/UPC, so image-count alone isn't "done").
  // Time-gate (updatedAt > 1h ago) so a product whose detail genuinely lacks text
  // isn't re-harvested every tick; freshly-created rows are handled inline by the
  // enrichment worker, this cron is the backstop.
  const rows = await conn.execute({
    sql: `SELECT dp.id FROM "DonorProduct" dp
          WHERE (dp.imageUrls IS NULL OR json_array_length(dp.imageUrls) < 3
                 OR dp.description IS NULL OR dp.description='')
            AND (dp.updatedAt IS NULL OR dp.updatedAt < datetime('now','-1 hour'))
            AND EXISTS (SELECT 1 FROM "DonorOffer" o WHERE o.donorProductId = dp.id
                        AND o.retailer IN ('walmart','target','samsclub','costco') AND o.productUrl IS NOT NULL)
          ORDER BY dp.createdAt DESC LIMIT ?`,
    args: [HARVEST_PER_TICK * 2],
  });
  const ids = (rows.rows as any[]).map((r) => r.id);

  // Process in concurrent batches — each product is independent (its own Unwrangle
  // detail + vision-QC), so a batch of CONCURRENCY runs in roughly one product's time.
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    if (out.harvested + out.errors >= HARVEST_PER_TICK) break;
    const batch = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((id) => harvestDonorDetail(conn, id).then((r) => ({ ok: true as const, r })).catch(() => ({ ok: false as const })))
    );
    for (const x of results) {
      if (x.ok && x.r.ok) { out.harvested++; out.images += x.r.images; if (x.r.upc) out.withUpc++; if (x.r.imageFlagged) out.flagged++; }
      else out.errors++;
    }
  }

  return NextResponse.json({ ok: true, tookMs: Date.now() - started, ...out });
}
