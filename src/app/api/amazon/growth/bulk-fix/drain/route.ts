/** RETIRED: legacy queue drain could submit live Amazon listing patches. */

import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";

export const maxDuration = 120;

export async function POST() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_BULK_FIX_DRAIN_RETIRED",
  );
}
