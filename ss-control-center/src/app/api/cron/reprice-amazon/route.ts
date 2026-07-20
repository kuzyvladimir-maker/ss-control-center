/**
 * RETIRED: legacy Amazon Featured Offer repricer.
 *
 * This route previously called a raw-SKU cost reader that could fall back to
 * an older positive SkuCost or a $1 floor, then mutate marketplace prices.
 * Runtime configuration must not be able to revive that path. Repricing may
 * return only through a new manifest-bound Product Truth implementation and a
 * separate owner-sealed marketplace-action gate.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RETIREMENT_CODE = "LEGACY_AMAZON_REPRICER_RETIRED";

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is required" },
      { status: 503 },
    );
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
        "Legacy raw-SKU/$1 repricing is disabled. Use manifest-bound Product Truth plus a separate owner action gate.",
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}
