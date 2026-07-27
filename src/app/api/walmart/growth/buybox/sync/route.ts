/**
 * POST /api/walmart/growth/buybox/sync
 *
 * Manually advance the Buy Box report one step (request → poll → download).
 * Same driver the cron uses. The "Refresh Buy Box" button calls this; because
 * generation takes 15-45 min, one click usually just requests or polls — the
 * data lands on a later poll (cron or another click).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient } from "@/lib/walmart/client";
import { driveBuyBoxReport } from "@/lib/walmart/sync-reports";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  let body: { storeIndex?: number } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body fine */
  }
  const storeIndex = body.storeIndex ?? 1;

  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  try {
    const result = await driveBuyBoxReport(prisma, client, storeIndex);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
