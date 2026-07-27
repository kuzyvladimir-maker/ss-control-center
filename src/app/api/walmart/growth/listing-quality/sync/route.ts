/**
 * POST /api/walmart/growth/listing-quality/sync
 *
 * Run ONE resumable Listing Quality sweep pass for a store. The per-item
 * Insights endpoint has a tiny rate bucket, so a full ~21-page sweep spans
 * several passes — this returns where the sweep got to. The "Sync now" button
 * calls it with a small page budget so the UI returns fast; the cron uses a
 * larger budget.
 *
 * Body (optional): { storeIndex?: number, maxPages?: number, budgetMs?: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { syncListingQuality } from "@/lib/walmart/persist-listing-quality";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let body: { storeIndex?: number; maxPages?: number; budgetMs?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body fine
  }
  const storeIndex = body.storeIndex ?? 1;
  // Manual trigger defaults to a short pass so the button returns in ~1 min.
  const maxPages = body.maxPages ?? 4;
  const budgetMs = body.budgetMs ?? 60_000;

  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  try {
    const result = await syncListingQuality(prisma, client, storeIndex, {
      maxPages,
      budgetMs,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message =
      err instanceof WalmartApiError
        ? `${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
