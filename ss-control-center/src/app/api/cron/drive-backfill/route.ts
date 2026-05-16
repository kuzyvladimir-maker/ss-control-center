// GET /api/cron/drive-backfill
//
// Layer 2 of the dual-layer Drive upload reliability scheme. Triggered by
// n8n every 15 minutes (Vercel Hobby plan only allows daily crons, so the
// fast cadence lives in n8n — see docs/n8n-workflows/drive-backfill.json).
//
// Scans purchased labels whose PDFs didn't make it to Drive (labelPdfUrl
// missing or pointing at our /api/shipping/label-pdf proxy), downloads from
// Veeqo, uploads to Drive, rewrites labelPdfUrl. Bounded to 20 rows per
// tick to fit Vercel's function timeout; the queue drains within a few
// ticks for typical load.
//
// Auth: same Bearer ${CRON_SECRET} as other cron routes.

import { NextRequest, NextResponse } from "next/server";
import { getDriveStatus } from "@/lib/google-drive";
import { runDriveBackfill } from "@/lib/shipping/drive-backfill";

const MAX_BATCH_SIZE = 20;
const LOOKBACK_DAYS = 30;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // If Drive isn't configured the run is a no-op — log explicitly so the
  // operator can grep n8n / Vercel logs to find the misconfiguration.
  const status = getDriveStatus();
  if (!status.configured) {
    console.error(
      `[drive-backfill] Drive not configured: ${status.reason}. Skipping tick.`,
    );
    return NextResponse.json({ skipped: true, reason: status.reason });
  }

  const results = await runDriveBackfill({
    lookbackDays: LOOKBACK_DAYS,
    maxBatchSize: MAX_BATCH_SIZE,
  });

  console.log(
    `[drive-backfill] found=${results.found} ` +
      `uploaded=${results.uploaded.length} ` +
      `errors=${results.errors.length} ` +
      `skipped=${results.skipped.length}`,
  );

  return NextResponse.json(results);
}
