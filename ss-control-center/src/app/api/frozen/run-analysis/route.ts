// POST /api/frozen/run-analysis
//
// Trigger the Frozen Analytics v2 pipeline. Two auth paths:
//   1. n8n cron — `Authorization: Bearer ${CRON_SECRET}` (production).
//   2. Logged-in operator hitting the "Run analysis now" button — no Bearer,
//      but the browser already carries the session cookie. We only enforce
//      CRON_SECRET when the env var is set, so local dev without CRON_SECRET
//      still works.
//
// Returns the PipelineResult summary so n8n can decide whether to fire a
// Telegram error alert (errors > 0).

import { NextRequest, NextResponse } from "next/server";
import { runFrozenAnalysisPipeline } from "@/lib/frozen-analytics/pipeline";

export const maxDuration = 300; // Vercel: allow up to 5 min

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (secret && auth && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runFrozenAnalysisPipeline();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
