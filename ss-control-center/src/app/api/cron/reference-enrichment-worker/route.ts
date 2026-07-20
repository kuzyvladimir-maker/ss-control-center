/**
 * RETIRED: legacy Reference Catalog enrichment worker.
 *
 * This cron drained a mutable queue and called retailer/provider sourcing
 * directly. It cannot be enabled by a runtime flag, permit, queue row, or cron
 * invocation. Product Truth enrichment executes only through the sealed canonical
 * CLI, whose plan, approval, target set, DB fingerprint, and budget are bound.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RETIREMENT_CODE = "LEGACY_REFERENCE_ENRICHMENT_WORKER_RETIRED";

export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code: RETIREMENT_CODE,
      reason:
        "Legacy enrichment worker is disabled. Use the owner-gated, sealed Product Truth CLI.",
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}
