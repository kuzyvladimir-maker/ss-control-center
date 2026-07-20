/**
 * RETIRED: the legacy Amazon remediation worker could drain mutable raw-SKU work
 * into live Listings API writes without a manifest-bound Product Truth snapshot
 * and a separate owner action permit.
 */

import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";

export const maxDuration = 120;

export async function GET() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_REMEDIATION_WORKER_RETIRED",
  );
}
