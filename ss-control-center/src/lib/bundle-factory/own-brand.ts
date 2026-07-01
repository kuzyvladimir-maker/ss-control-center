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

/** The brand the listing publishes under: the donor's own brand for an
 *  allowlisted donor, otherwise the Salutem house brand. */
export function resolveListingBrand(
  donorBrand: string | null | undefined,
  houseBrand: string,
): string {
  if (isOwnBrandPassthrough(donorBrand)) {
    const b = (donorBrand ?? "").trim();
    if (b) return b;
  }
  return houseBrand;
}
