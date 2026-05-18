/**
 * Phase 2.6.1 — Disclaimer text constants for bulk injection.
 *
 * Option C (Defensive) selected by Vladimir on 2026-05-19 after the
 * 2026-05-17 Retailer Distributor ban for Trademark Logo Misuse.
 * Aligns with Amazon Gift Basket Exception (node 12011207011) positioning
 * and the NO-LOA compliance strategy in
 * BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md.
 *
 * Used by:
 *   scripts/disclaimer-injection-plan.ts     (write into ListingRemediation.new_*)
 *   scripts/disclaimer-injection-execute.ts  (push to Amazon via Listings PATCH)
 *   scripts/disclaimer-injection-verify.ts   (substring match on live response)
 *   scripts/disclaimer-injection-rollback.ts (preserved original_* on the record)
 */

export const DISCLAIMER_BULLET =
  "Curated and packaged by Salutem Solutions LLC as a gift basket assembly. " +
  "This is not a manufacturer's product; individual items are sourced from " +
  "authorized retailers and assembled for buyer convenience.";

export const DISCLAIMER_DESCRIPTION =
  "About this gift basket: This product is a curated assembly created by " +
  "Salutem Solutions LLC, a third-party curator. Salutem Solutions LLC is " +
  "not affiliated with, sponsored by, or endorsed by any of the brands " +
  "included in this collection. Each item is independently sourced from " +
  "authorized retailers and assembled into this gift basket for buyer " +
  "convenience. All trademarks, brand names, logos, and packaging visible " +
  "in the product images are the property of their respective owners. " +
  "This product is intended as a gift basket; included items are not " +
  "modified, repackaged into branded materials, or altered in any way.";

/**
 * Used by plan + verify scripts to detect whether a listing already has
 * the disclaimer. Robust substring check on the first ~60 chars of the
 * bullet, case-insensitive.
 */
export const DISCLAIMER_DETECTION_SUBSTRING =
  "curated and packaged by salutem solutions";

/** True if any of the given strings contains the disclaimer marker. */
export function hasDisclaimerText(...candidates: Array<string | null | undefined>): boolean {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    if (c.toLowerCase().includes(DISCLAIMER_DETECTION_SUBSTRING)) return true;
  }
  return false;
}
