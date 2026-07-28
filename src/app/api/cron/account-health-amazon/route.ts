/**
 * GET /api/cron/account-health-amazon
 *
 * Daily Vercel cron (07:00 UTC). Runs the full Reports API flow:
 *
 *   1. Request a fresh report for every configured Amazon store.
 *   2. Poll the queued jobs a few times within this single function
 *      invocation. Most reports are DONE within ~30s, but if any
 *      lingers past 8 seconds we leave it for the next poll cycle —
 *      either the UI (when Vladimir refreshes the page) or tomorrow's
 *      cron run will pick it up.
 *
 * CRON_SECRET via Bearer guards external callers.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requestReportsForAllStores,
  pollOpenJobs,
} from "@/lib/account-health/report-orchestrator";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const phase1 = await requestReportsForAllStores();

  // Best-effort: poll a couple of times in this same invocation. Vercel
  // Hobby gives us 10s; one poll + a 3s nap + another poll keeps us
  // safely under the limit and often catches the fast reports.
  const pollResults: Awaited<ReturnType<typeof pollOpenJobs>>[] = [];
  pollResults.push(await pollOpenJobs());
  await sleep(3000);
  pollResults.push(await pollOpenJobs());

  return NextResponse.json({
    ok: true,
    phase1,
    pollPasses: pollResults,
  });
}
