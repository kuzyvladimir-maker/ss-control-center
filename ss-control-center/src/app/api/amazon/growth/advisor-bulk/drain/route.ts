/**
 * POST /api/amazon/growth/advisor-bulk/drain
 *
 * Advance the bulk AI-advisor queue one batch (the UI calls this in a loop).
 * Each item runs the LLM advisor + applies the safe executable subset. Smaller
 * batch than the deterministic worker — the LLM is slow and costs money.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { drainAdvisorQueue } from "@/lib/amazon/growth/bulk-advise";

export const maxDuration = 120;

export async function POST(_request: NextRequest) {
  try {
    const result = await drainAdvisorQueue(prisma, { budgetMs: 100_000, max: 12 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
