import { NextResponse } from "next/server";

import {
  loadWalmartListingIntegrityControlStoreStatus,
} from "@/lib/walmart/listing-integrity-control-store.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function buildListingIntegrityControlStatusResponse(
  loadStatus = loadWalmartListingIntegrityControlStoreStatus,
) {
  try {
    return NextResponse.json(
      { ok: true, control: await loadStatus() },
      { headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "LISTING_INTEGRITY_CONTROL_STATE_INVALID",
        message: error instanceof Error ? error.message : String(error),
      },
      {
        status: 503,
        headers: { "cache-control": "private, no-store, max-age=0" },
      },
    );
  }
}

export async function GET() {
  return buildListingIntegrityControlStatusResponse();
}

async function rejectMutation() {
  return NextResponse.json(
    {
      ok: false,
      error: "READ_ONLY_LISTING_INTEGRITY_CONTROL_API",
      message:
        "Stage A exposes durable verified status only and grants no runtime or Walmart write authority.",
    },
    { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
  );
}

export const POST = rejectMutation;
export const PUT = rejectMutation;
export const PATCH = rejectMutation;
export const DELETE = rejectMutation;
