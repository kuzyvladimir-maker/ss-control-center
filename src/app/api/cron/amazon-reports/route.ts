/**
 * GET /api/cron/amazon-reports
 *
 * Drives the Amazon Growth report state machine (FYP suppressed-listings +
 * Sales & Traffic conversion) for the selling accounts. One step per report
 * per run: request → poll → ingest. Reports generate in ~1-3 min, so the
 * frequent schedule walks each through to ingestion, enriching the health items
 * with suppression + conversion + buy-box signals.
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { advanceReports } from "@/lib/amazon/growth/reports";

export const maxDuration = 120;

const STORES = [1, 3];

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

  const steps: unknown[] = [];
  for (const storeIndex of STORES) {
    try {
      steps.push(...(await advanceReports(prisma, storeIndex)));
    } catch (err) {
      steps.push({ storeIndex, action: "error", error: (err as Error).message });
    }
  }
  return NextResponse.json({ ok: true, steps });
}
