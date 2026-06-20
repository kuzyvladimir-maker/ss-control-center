// Run fund distribution. POST { preview?: boolean }. preview=true (default)
// computes the waterfall without writing; preview=false commits.

import { NextRequest, NextResponse } from "next/server";
import { runDistribution } from "@/lib/finance/run";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  let preview = true;
  try {
    const b = await req.json().catch(() => ({}));
    preview = b?.preview !== false; // default preview unless explicitly false
  } catch {
    /* empty body → preview */
  }
  try {
    const result = await runDistribution({ preview, source: "manual" });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
