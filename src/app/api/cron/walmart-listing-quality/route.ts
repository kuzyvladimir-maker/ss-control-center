/**
 * GET /api/cron/walmart-listing-quality
 *
 * Advances the resumable Listing Quality sweep for the Walmart store. The
 * per-item Insights endpoint's tiny rate bucket means a full ~21-page sweep
 * can't finish in one 300s run, so this cron is scheduled frequently and each
 * run pages as far as the budget + bucket allow, persisting the cursor. When
 * the cursor exhausts the sweep completes (fresh snapshot + prune); the next
 * run after that starts a new sweep.
 *
 * Auth: same Bearer CRON_SECRET gate as /api/cron/walmart.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient } from "@/lib/walmart/client";
import { syncListingQuality } from "@/lib/walmart/persist-listing-quality";

export const maxDuration = 300;

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

  let client: WalmartClient;
  try {
    client = new WalmartClient(1);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  try {
    // Page as far as a ~240s budget + the bucket allow; resumes next run.
    const result = await syncListingQuality(prisma, client, 1, {
      budgetMs: 240_000,
      maxPages: 30,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 }
    );
  }
}
