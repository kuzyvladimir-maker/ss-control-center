/**
 * Pick which Ship-with-Walmart rate to buy for a Walmart order.
 *
 * Walmart offers far fewer services than Amazon Shipping (typically a handful
 * of USPS/FedEx options), so the rule is the Dry-goods rule from the Veeqo
 * flow: the cheapest service that still meets the delivery promise. (Frozen
 * orders can't ship via Walmart at all — they're blocked upstream in the
 * dashboard, so no Frozen-specific banding is needed here.)
 *
 * Operates on the WalmartRateOption shape from lib/walmart/shipping.ts.
 */

import type { WalmartRateOption } from "@/lib/walmart/shipping";

export interface WalmartRateSelection {
  chosen: WalmartRateOption | null;
  reason: string;
}

export function selectBestWalmartRate(
  rates: WalmartRateOption[],
): WalmartRateSelection {
  const priced = rates.filter((r) => typeof r.amount === "number" && r.amount! > 0);
  if (priced.length === 0) {
    return { chosen: null, reason: "No priced rates returned by Walmart." };
  }

  // Prefer services that meet Walmart's delivery promise; if none do, fall
  // back to all priced rates (better to ship late than not at all — the
  // operator can still override in the UI).
  const promiseMet = priced.filter((r) => r.deliveryPromiseFulfilled);
  const pool = promiseMet.length > 0 ? promiseMet : priced;

  const sorted = [...pool].sort((a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity));
  const chosen = sorted[0];

  return {
    chosen,
    reason:
      promiseMet.length > 0
        ? `Cheapest of ${promiseMet.length} service(s) meeting the delivery promise: ${chosen.displayName} $${chosen.amount}.`
        : `No service meets the delivery promise; cheapest overall: ${chosen.displayName} $${chosen.amount}.`,
  };
}
