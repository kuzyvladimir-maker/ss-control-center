import { NextResponse } from "next/server";

import { loadWalmartListingIntegrityRuntimeStatus } from
  "@/lib/walmart/listing-integrity-runtime-status.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function buildListingIntegrityRuntimeStatusResponse(
  loadStatus = loadWalmartListingIntegrityRuntimeStatus,
) {
  try {
    return NextResponse.json(
      { ok: true, runtime: await loadStatus() },
      { headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "LISTING_INTEGRITY_RUNTIME_STATUS_INVALID",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 503, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }
}

export async function GET() {
  return buildListingIntegrityRuntimeStatusResponse();
}

async function rejectMutation() {
  return NextResponse.json(
    {
      ok: false,
      error: "READ_ONLY_LISTING_INTEGRITY_RUNTIME_API",
      message: "This endpoint reads durable runtime status and exposes no mutation authority.",
    },
    { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
  );
}

export const POST = rejectMutation;
export const PUT = rejectMutation;
export const PATCH = rejectMutation;
export const DELETE = rejectMutation;
