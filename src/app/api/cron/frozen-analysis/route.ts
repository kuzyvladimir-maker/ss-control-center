/**
 * GET /api/cron/frozen-analysis
 *
 * Nightly Vercel cron (08:00 UTC ≈ 03:00 EST / 04:00 EDT). Per the spec in
 * `docs/FROZEN_ANALYTICS_v2_0.md` §⏰ NIGHTLY CRON PIPELINE.
 *
 * Walks every frozen-classified Veeqo order with ship_date in
 * (today, today+1, today+2, today+3), pulls Open-Meteo forecast for
 * origin + destination, applies the rules engine, and writes a
 * `FrozenRiskAlert` row per order. The shipping-labels page reads these
 * via `/api/frozen/alerts` and renders the recommendation badge inline
 * on each row that has an active alert.
 *
 * Without this cron the table stays empty and badges never appear —
 * which is exactly what happened before this route landed.
 *
 * CRON_SECRET via Bearer guards external callers; Vercel cron injects
 * it automatically when invoking.
 */

import { NextRequest, NextResponse } from "next/server";
import { runFrozenAnalysisPipeline } from "@/lib/frozen-analytics/pipeline";

export const maxDuration = 300; // Open-Meteo + Veeqo round-trips for ~50 orders

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runFrozenAnalysisPipeline();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
