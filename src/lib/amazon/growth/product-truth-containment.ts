import { NextResponse } from "next/server";

export const LEGACY_AMAZON_LISTING_IMPROVEMENT_RETIRED_REASON =
  "Legacy Amazon listing-improvement writes and paid advisor execution are disabled. Use manifest-bound Product Truth preview plus a separate owner action or budget gate." as const;

export function retiredAmazonListingImprovementResponse(code: string): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      retired: true,
      code,
      reason: LEGACY_AMAZON_LISTING_IMPROVEMENT_RETIRED_REASON,
    },
    {
      status: 410,
      headers: { "cache-control": "no-store" },
    },
  );
}
