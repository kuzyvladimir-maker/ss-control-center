/**
 * GET /api/cron/amazon-remediation
 *
 * Drains the Amazon bulk remediation queue — applies the chosen safe fixes to
 * each queued listing via the Listings API, paced for the rate limit. Runs
 * frequently; each run processes a batch and the next run picks up the rest.
 * The "Fix all matching" button enqueues; this worker does the work.
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { drainQueue } from "@/lib/amazon/growth/bulk-remediate";

export const maxDuration = 120;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;
  try {
    const result = await drainQueue(prisma, { budgetMs: 110_000, max: 60 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
