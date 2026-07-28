/**
 * RETIRED: legacy Reference Catalog detail-harvest worker.
 *
 * This cron could claim harvest rows and call metered retailer providers outside
 * the canonical operational runner. It cannot be revived by a runtime flag,
 * metered permit, confirmation, or queued state. Product Truth harvest executes
 * only as part of an owner-approved sealed CLI plan; club routes remain forbidden.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RETIREMENT_CODE = "LEGACY_REFERENCE_HARVEST_WORKER_RETIRED";

export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code: RETIREMENT_CODE,
      reason:
        "Legacy harvest worker is disabled. Use the owner-gated, sealed Product Truth CLI.",
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}
