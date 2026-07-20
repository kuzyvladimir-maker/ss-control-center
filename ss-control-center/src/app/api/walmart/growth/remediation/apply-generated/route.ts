/**
 * RETIRED: legacy Walmart generated-image apply endpoint.
 *
 * The former route accepted an unauthenticated SKU/image URL and submitted a
 * marketplace feed without a manifest-bound Product Truth snapshot or a
 * separate owner-sealed action gate. Runtime input must not be able to revive
 * that mutation path. A future apply flow must use a new reviewed endpoint.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const RETIREMENT_CODE = "LEGACY_WALMART_IMAGE_APPLY_RETIRED";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code: RETIREMENT_CODE,
      reason:
        "Legacy Walmart image apply is disabled. Use manifest-bound Product Truth plus a separate owner action gate.",
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}
