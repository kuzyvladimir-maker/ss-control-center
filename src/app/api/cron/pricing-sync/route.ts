import { NextRequest, NextResponse } from "next/server";
import { syncUncrustables } from "@/lib/pricing/uncrustables";

export const maxDuration = 300;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev: no gate
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/** Scheduled pricing monitor: re-scores all Uncrustable listings against the
 *  cost model so the Pricing page (and drift alerts) stay current. */
export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;
  try {
    const snapshot = await syncUncrustables();
    return NextResponse.json({ ok: true, counts: snapshot.counts });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
