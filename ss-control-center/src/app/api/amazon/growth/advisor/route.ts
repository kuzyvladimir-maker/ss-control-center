/**
 * RETIRED: the legacy single-listing advisor called the paid Anthropic API
 * outside the Product Truth metered ledger and owner budget gate.
 */

import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";

export const maxDuration = 120;

export async function POST() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_ADVISOR_PAID_EXECUTION_RETIRED",
  );
}
