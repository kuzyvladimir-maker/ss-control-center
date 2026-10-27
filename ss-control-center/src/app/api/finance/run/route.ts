// Run fund distribution. POST { preview?: boolean }. preview=true (default)
// computes the waterfall without writing; preview=false commits.

import { NextRequest, NextResponse } from "next/server";
import { runDistribution } from "@/lib/finance/run";
import { scopeOf } from "@/lib/finance/scope";
import { requireAdmin } from "@/lib/auth-server";
import { isFinanceWriteConflict } from "@/lib/finance/treasury";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  let preview = true;
  try {
    const b = await req.json().catch(() => ({}));
    preview = b?.preview !== false; // default preview unless explicitly false
  } catch {
    /* empty body → preview */
  }
  try {
    const result = await runDistribution({ preview, source: "manual", scope: scopeOf(req) });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (isFinanceWriteConflict(e)) return NextResponse.json({ ok: false, error: "Another finance update is in progress. Reload the preview." }, { status: 409 });
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
