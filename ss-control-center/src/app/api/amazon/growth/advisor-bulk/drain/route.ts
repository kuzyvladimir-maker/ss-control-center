/**
 * RETIRED: legacy advisor drain combined unmetered paid analysis with optional
 * live Amazon writes.
 */

import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";

export const maxDuration = 300;

export async function POST() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_ADVISOR_BULK_DRAIN_RETIRED",
  );
}
