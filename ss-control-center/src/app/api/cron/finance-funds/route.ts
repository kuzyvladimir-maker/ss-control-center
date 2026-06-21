// Weekly Finance Funds cron: ingest new payouts, then commit a distribution run.
// Gate with CRON_SECRET (Bearer). Schedule weekly in vercel.json.

import { NextRequest, NextResponse } from "next/server";
import { ingestAllPayouts } from "@/lib/finance/payouts";
import { runDistribution } from "@/lib/finance/run";

export const maxDuration = 300;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev: no gate
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;
  try {
    const ingest = await ingestAllPayouts(35);
    const run = await runDistribution({ preview: false, source: "cron" });
    return NextResponse.json({ ok: true, ingest, run });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
