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

// Vercel Pro caps Node functions at 300s. Each LLM listing takes ~10-25s, so we
// give the worker a budget well under this ceiling (below) — a listing started
// near the budget still finishes before the function is killed.
export const maxDuration = 300;

export async function POST(_request: NextRequest) {
  try {
    // budgetMs leaves >60s of headroom under maxDuration so the last-started
    // listing can finish; otherwise Vercel kills the fn and returns non-JSON.
    const result = await drainAdvisorQueue(prisma, { budgetMs: 230_000, max: 12 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
