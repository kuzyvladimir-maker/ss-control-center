/**
 * GET /api/cron/account-health-amazon-poll
 *
 * Follow-up poller for the daily Account Health report run. The 07:00 UTC
 * cron (`/api/cron/account-health-amazon`) requests the reports and polls
 * for only ~6s; Amazon typically needs ~30s+. Before this route existed
 * nothing polled again, every job expired, and no AccountHealthSnapshot was
 * written from 2026-06-30 until 2026-10-18.
 *
 * Schedule (vercel.json): every 15 min, 07:00–10:45 UTC. Cheap when idle —
 * one indexed query that returns no open jobs.
 *
 * CRON_SECRET via Bearer guards external callers.
 */

import { NextRequest, NextResponse } from "next/server";
import { pollOpenJobs } from "@/lib/account-health/report-orchestrator";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await pollOpenJobs();
  return NextResponse.json({ ok: true, results });
}
