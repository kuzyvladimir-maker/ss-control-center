// GET /api/frozen/morning-summary
//
// Called by n8n at 07:00 ET. Returns aggregated counts + a pre-formatted
// HTML Telegram message that the workflow forwards verbatim to the bot.

import { NextRequest, NextResponse } from "next/server";
import { buildMorningSummary } from "@/lib/frozen-analytics/morning-summary";

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (secret && auth && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const summary = await buildMorningSummary();
  return NextResponse.json(summary);
}
