/**
 * Own-brand passthrough (the Uncrustables carve-out).
 *
 * Some donor brands let us list the genuine product UNDER THEIR OWN BRAND
 * (brand field = the donor brand), as a normal reseller listing — NOT as a
 * Salutem gift set. For those:
 *   - brand field = the donor brand (e.g. Smucker's), not Salutem Vita
 *   - the donor brand IS allowed in the title (the "no foreign brand in title"
 *     rule only applies when the brand field is Salutem — Vladimir 2026-06-30)
 *   - NO gift-set framing, NO curator/assembler disclaimer
 *   - Salutem may appear ONLY on our cooler + gel packs in the title photo
 *
 * This is the NARROW exception to the gift-set model. The allowlist is
 * deliberately tiny — add a brand ONLY when confirmed it permits this (Amazon
 * has never objected to our existing Uncrustables listings). Everything NOT on
 * the allowlist keeps the full Salutem gift-set model + brand-in-title block.
 *
 * Mode is derived from the LISTING brand (no DB flag): the studio only sets a
 * non-Salutem brand for allowlisted donors, so `isOwnBrandPassthrough(brand)`
 * downstream cleanly identifies the mode in content-gen + the compliance gate.
 */

/** Donor brands we may list under their own brand. Keep tiny + verified. */
export const OWN_BRAND_PASSTHROUGH_BRANDS = [
  "Smucker's",
  "Smuckers",
  "Uncrustables",
] as const;

const ALLOWLIST_LOWER = OWN_BRAND_PASSTHROUGH_BRANDS.map((b) => b.toLowerCase());

/** True when a brand string is on the own-brand passthrough allowlist. Matches
 *  loosely (substring either direction) so "Smucker's Uncrustables" and
 *  "Smuckers" both resolve. */
export function isOwnBrandPassthrough(brand: string | null | undefined): boolean {
  const b = (brand ?? "").trim().toLowerCase();
  if (!b) return false;
  return ALLOWLIST_LOWER.some((x) => b.includes(x) || x.includes(b));
}

/** Canonical display spelling per allowlist entry — catalog rows carry the
 *  brand in unreliable casing ("Smucker'S", "SMUCKERS") that would otherwise
 *  leak straight into listing titles. */
// Owner 2026-07-08: the listing brand FIELD is always "Uncrustables" for the
// whole Smucker's/Uncrustables family (titles may still factually say
// "Smucker's Uncrustables" — that's the real product name; the BRAND attribute
// is what he standardises on).
const CANONICAL_DISPLAY: Record<(typeof OWN_BRAND_PASSTHROUGH_BRANDS)[number], string> = {
  "Smucker's": "Uncrustables",
  "Smuckers": "Uncrustables",
  "Uncrustables": "Uncrustables",
};

/** Brand-string-independent Uncrustables identity: any listing/draft text that
 *  names Uncrustables. The allowlist above is how the own-brand MODE is chosen;
 *  this is the safety net for PRICING and publish guards — a null or misspelled
 *  brand field ("J.M. Smucker", "") must never route an actual Uncrustables
 *  bundle onto the generic markup path. That exact gap birthed the 2026-07
 *  price-above-max cohort: price landed×~1.53 from the generic engine while the
 *  band stayed canonical 1.3/1.5 → Amazon suppressed the offer. */
export function textSaysUncrustables(text: string | null | undefined): boolean {
  return /uncrustables/i.test(text ?? "");
}

/** The brand the listing publishes under: the donor's own brand for an
 *  allowlisted donor (in its CANONICAL spelling — never the raw donor casing),
 *  otherwise the Salutem house brand. */
export function resolveListingBrand(
  donorBrand: string | null | undefined,
  houseBrand: string,
): string {
  const b = (donorBrand ?? "").trim().toLowerCase();
  if (b) {
    for (const entry of OWN_BRAND_PASSTHROUGH_BRANDS) {
      const x = entry.toLowerCase();
      if (b.includes(x) || x.includes(b)) return CANONICAL_DISPLAY[entry];
    }
  }
  return houseBrand;
}
