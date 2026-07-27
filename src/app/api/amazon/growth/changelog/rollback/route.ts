/**
 * RETIRED: rollback is still a marketplace mutation and needs a separately
 * reviewed, owner-gated Product Truth action contract.
 */

import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";

export const maxDuration = 90;

export async function POST() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_CHANGELOG_ROLLBACK_RETIRED",
  );
}
