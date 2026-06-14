/**
 * GET /api/cron/amazon-listing-health
 *
 * Advances the resumable Amazon Listing Health sweep for the selling accounts
 * (store1 = Salutem, store3 = AMZ Commerce). Listings API is 5 req/s so a full
 * sweep usually finishes in one run; the cursor pattern resumes any store that
 * didn't. On clean completion each store gets a fresh seller snapshot + prune.
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncListingHealth } from "@/lib/amazon/growth/persist-listing-health";

export const maxDuration = 300;

/** Selling accounts in scope for Amazon Grow (see amazon-growth-roadmap.md). */
const STORES = [1, 3];

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev/local: no gate
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const results: unknown[] = [];
  for (const storeIndex of STORES) {
    try {
      const result = await syncListingHealth(prisma, storeIndex, {
        budgetMs: 110_000, // ~110s each → both stores stay under maxDuration
        maxPages: 250,
      });
      results.push(result);
    } catch (err) {
      results.push({ storeIndex, ok: false, error: (err as Error).message });
    }
  }

  return NextResponse.json({ ok: true, results });
}
