/**
 * GET /api/cron/walmart-reports
 *
 * Advances the Buy Box report state machine one step (request → poll →
 * download). Async report generation takes 15-45 min and the /reports endpoint
 * has a tiny rate bucket, so this is scheduled every 30 min and does one step
 * per run. See src/lib/walmart/sync-reports.ts.
 *
 * Auth: same Bearer CRON_SECRET gate as the other Walmart crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient } from "@/lib/walmart/client";
import { driveBuyBoxReport } from "@/lib/walmart/sync-reports";

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

  let client: WalmartClient;
  try {
    client = new WalmartClient(1);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  try {
    const result = await driveBuyBoxReport(prisma, client, 1);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
