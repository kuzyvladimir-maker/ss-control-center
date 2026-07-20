/**
 * RETIRED: the autonomous Amazon improvement producer fed the legacy remediation
 * worker without Product Truth activation or an owner-sealed mutation gate.
 */

import { retiredAmazonListingImprovementResponse } from "@/lib/amazon/growth/product-truth-containment";

export const maxDuration = 120;

export async function GET() {
  return retiredAmazonListingImprovementResponse(
    "LEGACY_AMAZON_AUTO_IMPROVE_RETIRED",
  );
}
