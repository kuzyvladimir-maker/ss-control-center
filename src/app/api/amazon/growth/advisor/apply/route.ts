/**
 * RETIRED: legacy advisor apply could PATCH Amazon after a mutable listing read.
 * Advisor display does not authorize a marketplace mutation.
 */

import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";

export const maxDuration = 120;

export async function POST() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_ADVISOR_APPLY_RETIRED",
  );
}
