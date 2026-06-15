/**
 * POST /api/amazon/growth/bulk-fix/drain
 *
 * Manually advance the bulk remediation queue (the "Run now" button) so the
 * operator doesn't wait for the cron. Processes a batch and returns progress.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { drainQueue } from "@/lib/amazon/growth/bulk-remediate";

export const maxDuration = 120;

export async function POST(_request: NextRequest) {
  try {
    const result = await drainQueue(prisma, { budgetMs: 100_000, max: 40 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
