/**
 * RETIRED: legacy Amazon optimizer apply. Read-only optimizer preview remains a
 * separate route; live apply requires Product Truth evidence and an owner gate.
 */

import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";

export const maxDuration = 180;

export async function POST() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_OPTIMIZER_APPLY_RETIRED",
  );
}
