/**
 * RETIRED: legacy manual donor-harvest seeding endpoint.
 *
 * API callers must not create executable Product Truth work outside a sealed
 * plan. Runtime flags, auth, permits, and submitted payloads cannot revive it.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RETIREMENT_CODE = "LEGACY_REFERENCE_HARVEST_SEED_RETIRED";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code: RETIREMENT_CODE,
      reason:
        "Legacy manual harvest seeding is disabled. Use the owner-gated, sealed Product Truth CLI.",
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}
