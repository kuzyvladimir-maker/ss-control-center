/**
 * POST /api/amazon/growth/listing-health/sync
 *
 * Manually advance the resumable Listing Health sweep for one store (the
 * "Sync now" button in the dashboard). Body: { storeIndex?: 1 | 3 }.
 * The cron does this on a schedule; this is the on-demand kick.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncListingHealth } from "@/lib/amazon/growth/persist-listing-health";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let storeIndex = 1;
  try {
    const body = await request.json();
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
  } catch {
    // empty body → default store
  }

  try {
    const result = await syncListingHealth(prisma, storeIndex, {
      budgetMs: 240_000,
      maxPages: 250,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  }
}
