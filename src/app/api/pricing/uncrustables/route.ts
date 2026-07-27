import { NextRequest, NextResponse } from "next/server";
import {
  syncUncrustables,
  readSnapshot,
} from "@/lib/pricing/uncrustables";

// Refreshing pulls the Merchant Listings report (~60-90s).
export const maxDuration = 300;

/**
 * GET  /api/pricing/uncrustables           → cached snapshot
 * GET  /api/pricing/uncrustables?refresh=1 → re-sync from SP-API, then snapshot
 */
export async function GET(request: NextRequest) {
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";
  try {
    const snapshot = refresh
      ? await syncUncrustables()
      : (await readSnapshot()) ?? (await syncUncrustables());
    return NextResponse.json({ ok: true, snapshot });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/pricing/uncrustables
 * Direct offer-price mutations are disabled. The regular Uncrustables base is
 * canonical and fixed; promotions are implemented with Amazon Coupons.
 */
export async function POST() {
  return NextResponse.json({
    ok: false,
    error:
      "Uncrustables base prices are policy-locked. Use the sealed surgical repair for canonical corrections and Amazon Coupons for launch promotions.",
  }, { status: 409 });
}
