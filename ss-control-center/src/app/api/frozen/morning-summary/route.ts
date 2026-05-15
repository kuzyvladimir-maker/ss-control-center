// GET /api/frozen/morning-summary
//
// Called by n8n at 07:00 ET. Returns aggregated counts + a pre-formatted
// HTML Telegram message that the workflow forwards verbatim to the bot.

import { NextResponse } from "next/server";
import { buildMorningSummary } from "@/lib/frozen-analytics/morning-summary";

// Auth: handled by /api/* middleware (session cookie OR SSCC_API_TOKEN).
export async function GET() {
  const summary = await buildMorningSummary();
  return NextResponse.json(summary);
}
