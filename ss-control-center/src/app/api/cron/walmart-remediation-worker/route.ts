// TEMP DIAGNOSTIC build — no heavy static imports. GET ?diag=1 probes which
// dependency fails to load in the Vercel runtime. Restored to the real worker
// once the culprit is identified.
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_request: NextRequest) {
  const mods: [string, () => Promise<any>][] = [
    ["@libsql/client", () => import("@libsql/client")],
    ["walmart/client", () => import("@/lib/walmart/client")],
    ["multipack/composite(sharp)", () => import("@/lib/walmart/multipack/composite")],
    ["multipack/r2(aws-sdk)", () => import("@/lib/walmart/multipack/r2")],
    ["multipack/donor", () => import("@/lib/walmart/multipack/donor")],
    ["multipack/polish", () => import("@/lib/walmart/multipack/polish")],
    ["multipack/analytics", () => import("@/lib/walmart/multipack/analytics")],
    ["multipack/remediate", () => import("@/lib/walmart/multipack/remediate")],
    ["sharp", () => import("sharp")],
  ];
  const results: Record<string, string> = {};
  for (const [name, fn] of mods) {
    try { await fn(); results[name] = "ok"; }
    catch (e: any) { results[name] = `FAIL: ${e?.message || String(e)}`.slice(0, 300); }
  }
  return NextResponse.json({ diag: true, results });
}
