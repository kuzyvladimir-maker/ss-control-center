import { NextResponse } from "next/server";

// This endpoint used to drive a hand-rolled metrics calculation that diverged
// from Amazon's official numbers (FBA filtering / proprietary shipment events
// we can't see). It now returns 410 Gone so nothing accidentally pulls stale
// math back into the snapshot.
//
// Real sync flow:
//   - daily cron       /api/cron/account-health-amazon  (Reports API)
//   - manual refresh   POST /api/account-health/amazon/sync  (Phase 1)
//                      POST /api/account-health/amazon/poll  (Phase 2)
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Deprecated. Use /api/account-health/amazon/sync + /api/account-health/amazon/poll, or wait for the daily cron.",
    },
    { status: 410 }
  );
}
