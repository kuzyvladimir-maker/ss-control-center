import { NextResponse } from "next/server";
import { requestReportsForAllStores } from "@/lib/account-health/report-orchestrator";

// POST /api/account-health/amazon/sync
//
// Phase 1 of the Reports API flow: kicks off a fresh
// GET_V2_SELLER_PERFORMANCE_REPORT for every Amazon store, persists the
// reportId in ReportSyncJob, returns immediately. The UI then polls
// /api/account-health/amazon/poll every ~15 seconds until all jobs are
// done (typically 1-3 minutes per store).
export async function POST() {
  const results = await requestReportsForAllStores();
  return NextResponse.json({
    phase: "request",
    results,
    pendingCount: results.filter((r) => r.success).length,
  });
}
