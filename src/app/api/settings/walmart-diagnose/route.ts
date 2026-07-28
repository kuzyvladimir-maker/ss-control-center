/**
 * POST /api/settings/walmart-diagnose
 *
 * Admin-only Walmart API probe. Calls every plausible Seller Performance
 * URL shape + every plausible On-Request Reports reportType, returns the
 * full findings and the markdown body that should go into
 * docs/WALMART_API_DIAGNOSTIC_RESULTS.md so we can hard-code the working
 * path in a follow-up commit.
 *
 * GET form returns nothing — only POST runs the probe (it makes up to
 * ~20 API calls; we don't want it firing on accidental page-prefetch).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-server";
import {
  runDiagnostic,
  findingsToMarkdown,
} from "@/lib/walmart/diagnose";

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let storeIndex = 1;
  try {
    const body = await request.json();
    if (typeof body?.storeIndex === "number") storeIndex = body.storeIndex;
  } catch {
    // empty body — keep default
  }

  try {
    const findings = await runDiagnostic(storeIndex);
    return NextResponse.json({
      findings,
      markdown: findingsToMarkdown(findings),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
