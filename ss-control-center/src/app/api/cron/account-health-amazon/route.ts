/**
 * GET /api/cron/account-health-amazon
 *
 * Vercel cron triggers this every 4 hours (0 *\/4 * * *). Walks every
 * SP-API-configured Amazon store and runs syncStoreHealth, which now
 * also pulls AHR + Policy Compliance and fires the Critical Alerts
 * evaluator. CRON_SECRET gates outside callers.
 */

import { NextRequest, NextResponse } from "next/server";
import { syncStoreHealth } from "@/lib/amazon-sp-api/account-health-sync";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Array<{
    storeIndex: number;
    success: boolean;
    status?: string;
    alertsCreated?: number;
    error?: string;
  }> = [];

  for (let i = 1; i <= 5; i++) {
    if (!getStoreCredentials(i)) continue;
    try {
      const r = await syncStoreHealth(i);
      results.push(r);
    } catch (err) {
      results.push({
        storeIndex: i,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ ok: true, results });
}
