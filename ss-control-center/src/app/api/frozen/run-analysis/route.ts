// POST /api/frozen/run-analysis
//
// Trigger the Frozen Analytics v2 pipeline. Auth is enforced by the
// project-wide /api/* middleware in src/proxy.ts — accepts either a logged-
// in session cookie (operator clicking "Run analysis") OR `Authorization:
// Bearer ${SSCC_API_TOKEN}` (n8n / external automation).
//
// Returns the PipelineResult summary so n8n can decide whether to fire a
// Telegram error alert (errors > 0).

import { NextResponse } from "next/server";
import { runFrozenAnalysisPipeline } from "@/lib/frozen-analytics/pipeline";

export const maxDuration = 300; // Vercel: allow up to 5 min

export async function POST() {
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
