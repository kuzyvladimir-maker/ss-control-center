import { NextResponse } from "next/server";

import { loadListingIntegrityOperationsState } from "@/lib/walmart/listing-integrity-operations.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(
      {
        ok: true,
        operations: await loadListingIntegrityOperationsState(),
      },
      { headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "LISTING_INTEGRITY_STATE_INVALID",
        message: error instanceof Error ? error.message : String(error),
      },
      {
        status: 503,
        headers: { "cache-control": "private, no-store, max-age=0" },
      },
    );
  }
}

async function rejectMutation() {
  return NextResponse.json(
    {
      ok: false,
      error: "READ_ONLY_LISTING_INTEGRITY_API",
      message:
        "This API exposes verified state only. Walmart writes use the frozen one-SKU operator contract.",
    },
    { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
  );
}

export const POST = rejectMutation;
export const PUT = rejectMutation;
export const PATCH = rejectMutation;
export const DELETE = rejectMutation;
