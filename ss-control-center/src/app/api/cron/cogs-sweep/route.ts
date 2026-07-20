/**
 * RETIRED: legacy automatic COGS sweep.
 *
 * This route selected mutable/implicit catalog work and called the legacy COGS
 * engine directly. Runtime flags, query parameters, cron auth, or an in-process
 * permit must never revive that bypass. Product Truth COGS/enrichment execution
 * is available only through the sealed `npm run product-truth -- ...` CLI.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RETIREMENT_CODE = "LEGACY_COGS_SWEEP_RETIRED";

export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code: RETIREMENT_CODE,
      reason:
        "Legacy COGS sweep is disabled. Use the owner-gated, sealed Product Truth CLI.",
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}
