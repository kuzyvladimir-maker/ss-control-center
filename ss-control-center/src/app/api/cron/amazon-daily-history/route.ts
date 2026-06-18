/**
 * GET /api/cron/amazon-daily-history
 *
 * Per-ASIN daily funnel history (experiment engine, Phase 0). Each run, for each
 * selling account: ingest the latest settled day, then opportunistically backfill
 * a few missing days within the trailing ~90d window so the trend fills in over
 * time without long jobs. Self-heals gaps; idempotent (skips days already stored).
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ingestDay, backfillDays, latestSettledDay } from "@/lib/amazon/growth/daily-history";
import { measureChangesDiD } from "@/lib/amazon/growth/change-log";

export const maxDuration = 300;

const STORES = [1, 3];
const DAY_MS = 864e5;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const out: unknown[] = [];
  const latest = latestSettledDay();
  for (const storeIndex of STORES) {
    try {
      const written = await ingestDay(prisma, storeIndex, latest);
      // Fill a few trailing gaps each run to build the ~90d trend window.
      const backfill = await backfillDays(prisma, storeIndex, new Date(latest.getTime() - 90 * DAY_MS), latest, { maxDays: 5 });
      // Now that today's funnel is in, measure any changes whose window elapsed.
      const did = await measureChangesDiD(prisma, storeIndex);
      out.push({ storeIndex, latest: latest.toISOString().slice(0, 10), written, backfill, did });
    } catch (err) {
      out.push({ storeIndex, error: (err as Error).message });
    }
  }
  return NextResponse.json({ ok: true, steps: out });
}
