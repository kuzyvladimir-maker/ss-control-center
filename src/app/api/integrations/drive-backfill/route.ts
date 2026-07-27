// POST /api/integrations/drive-backfill
//
// Admin-triggered version of the cron back-fill. Same scan as
// /api/cron/drive-backfill but with a bigger row cap (200 vs 20) and no
// cron secret — just the admin session check from the project-wide
// /api/* middleware.
//
// Body (optional): { lookbackDays?: number }  — 1..365, default 30.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-server";
import { getDriveStatus } from "@/lib/google-drive";
import { runDriveBackfill } from "@/lib/shipping/drive-backfill";

const MAX_BATCH_SIZE = 200;

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  const lookbackDays = Math.min(
    Math.max(Number(body.lookbackDays ?? 30), 1),
    365,
  );

  const status = getDriveStatus();
  if (!status.configured) {
    return NextResponse.json(
      { error: `Drive not configured: ${status.reason}`, configured: false },
      { status: 503 },
    );
  }

  const results = await runDriveBackfill({
    lookbackDays,
    maxBatchSize: MAX_BATCH_SIZE,
  });
  return NextResponse.json(results);
}
