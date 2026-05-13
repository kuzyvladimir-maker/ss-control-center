import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { pollOpenJobs } from "@/lib/account-health/report-orchestrator";

// POST /api/account-health/amazon/poll
//
// Phase 2 of the Reports API flow. Walks every ReportSyncJob that's still
// open (requested / processing / downloading), advances each one, downloads
// + parses + writes the snapshot when DONE, and runs alert evaluation.
//
// Idempotent — UI hammers this every ~15s after the sync button is clicked;
// daily cron also calls it.
export async function POST() {
  const results = await pollOpenJobs();
  const pending = await prisma.reportSyncJob.count({
    where: {
      reportType: "GET_V2_SELLER_PERFORMANCE_REPORT",
      status: { in: ["requested", "processing", "downloading"] },
    },
  });
  return NextResponse.json({
    phase: "poll",
    results,
    pendingCount: pending,
    done: pending === 0,
  });
}

// GET — same data, lets the UI cheap-poll without a POST body.
export async function GET() {
  return POST();
}
