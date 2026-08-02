/**
 * Phase 2.6.2 — Disclaimer text constants for bulk injection.
 *
 * History:
 *   - 2026-05-19 — Option C "Defensive" approved by Vladimir after the
 *     2026-05-17 Retailer Distributor ban for Trademark Logo Misuse.
 *     Used affiliation-negation + trademark-property statements.
 *   - 2026-05-19 — Phase 2.6.2 safety test (5 AMZCOM + 1 SALUTEM probe)
 *     blocked 100% by Amazon PDP code 99300 ("false/promotional claims
 *     or external links"). Isolation probe (`_diag-disclaimer-isolate.ts`)
 *     confirmed Claude content alone PASSED — the disclaimer text was
 *     the trigger.
 *   - 2026-05-19 — Replaced with minimal "Variant A" wording. Probed
 *     (`_diag-disclaimer-variants.ts`) on B0F74NGS3B in three forms:
 *     bullet-only, paragraph-only, and combined — all returned
 *     status=VALID. Keeps the Gift Basket Exception positioning
 *     (Salutem as curator/assembler, items packaged by their original
 *     manufacturers) without the affiliation-negation, trademark-property,
 *     or "authorized retailers" supply-chain claim that tripped 99300.
 *
 * Used by:
 *   scripts/disclaimer-injection-plan.ts     (write into ListingRemediation.new_*)
 *   scripts/disclaimer-injection-execute.ts  (push to Amazon via Listings PATCH)
 *   scripts/disclaimer-injection-verify.ts   (substring match on live response)
 *   scripts/disclaimer-injection-rollback.ts (preserved original_* on the record)
 */

export const DISCLAIMER_BULLET =
  "Curated and assembled by Salutem Solutions LLC as a gift basket.";

export const DISCLAIMER_DESCRIPTION =
  "This gift basket is curated and assembled by Salutem Solutions LLC. " +
  "The included items are packaged by their original manufacturers.";

/**
 * Walmart multipack wording (owner decision 2026-08-02).
 *
 * A Pack-of-N of one identical item is not a gift basket, so the gift-basket
 * sentence would be an untrue description of the product. Same legal purpose —
 * we state that Salutem Solutions assembled it and that the goods stay in the
 * manufacturer's own packaging — in wording that matches what is actually
 * shipped.
 */
export const MULTIPACK_DISCLAIMER_BULLET =
  "Assembled and packed by Salutem Solutions LLC as a multipack.";

export const MULTIPACK_DISCLAIMER_DESCRIPTION =
  "This multipack is assembled and packed by Salutem Solutions LLC. " +
  "The included items are packaged by their original manufacturers.";

/**
 * Detection substrings used by plan + verify scripts to recognise that
 * a listing already carries the disclaimer (so re-runs are idempotent).
 * Includes the Phase 2.6.1 legacy wording so the 1 listing that landed
 * under the old text is still recognised as compliant.
 *
 * Substrings are matched case-insensitively against bullet text and
 * description body.
 */
export const DISCLAIMER_DETECTION_SUBSTRINGS = [
  "curated and assembled by salutem solutions", // Phase 2.6.2 wording
  "curated and packaged by salutem solutions",  // Phase 2.6.1 legacy
  "assembled and packed by salutem solutions",  // Walmart multipack wording
] as const;

/** Back-compat alias — the legacy single-string export. New code should
 *  use the array above. */
export const DISCLAIMER_DETECTION_SUBSTRING = DISCLAIMER_DETECTION_SUBSTRINGS[0];

/** True if any of the given strings contains a known disclaimer marker. */
export function hasDisclaimerText(...candidates: Array<string | null | undefined>): boolean {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const lower = c.toLowerCase();
    for (const needle of DISCLAIMER_DETECTION_SUBSTRINGS) {
      if (lower.includes(needle)) return true;
    }
  }
  return false;
}
