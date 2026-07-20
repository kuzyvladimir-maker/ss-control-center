/**
 * RETIRED: legacy Walmart remediation worker.
 *
 * This route previously combined ad-hoc retailer enrichment with Walmart feed
 * submission. That bypasses the manifest-bound Product Truth read contract,
 * owner-sealed consumer activation, the durable metered ledger, and the
 * separate marketplace-mutation gate. Runtime configuration must not be able
 * to revive that path. A future Listing Improvement apply flow must be exposed
 * through a new, reviewed Product Truth entrypoint; it must not reuse this
 * legacy route.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RETIREMENT_CODE = "LEGACY_WALMART_REMEDIATION_RETIRED";

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return process.env.NODE_ENV === "production"
      ? NextResponse.json(
          { error: "CRON_SECRET is required in production" },
          { status: 503 },
        )
      : null;
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code: RETIREMENT_CODE,
      reason:
        "Legacy paid sourcing and Walmart feed submission are disabled. Use the owner-gated Product Truth cutover path.",
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}
