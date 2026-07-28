// The word-level half of the identity gate, in ONE place.
//
// This logic used to be copy-pasted into _gen_enriched / _fix_gen / _qc_pending /
// _suggest_donors / _probe_relink / _fix_sku. The copies drifted, and the drift cost us:
// _sync_donorfail.ts never learned about the VARIANT_MISMATCH status, so 65 SKUs with a
// knowingly wrong donor sat outside COGS's queue for a day. Import from here instead.

/** Words whose presence flips the product into a DIFFERENT one. If the listing says
 *  "Dr Pepper" and the donor says "Diet Dr Pepper", they are not the same drink — no
 *  vision call needed. Asymmetric presence of ANY of these = wrong donor. Deliberately
 *  small: only words that are never mere decoration. */
export const MODIFIERS = [
  "diet", "zero", "decaf", "decaffeinated", "caffeine", "whole", "honey", "xxtra",
  "flamin", "unsweetened", "sugarfree", "lite", "reduced", "gluten", "organic",
  "spicy", "original", "classic", "smoked", "toasted",
];

/** Compound spellings that mean the same thing as the spaced form. Without this,
 *  "SunChips Garden Salsa **Whole Grain** Snacks" (listing) vs "...Flavored
 *  **Wholegrain** Snacks" (donor) reads as a "whole" disagreement and the correct donor
 *  gets quarantined. Found live on FaisalX-1293, 2026-07-10. */
const COMPOUNDS: Array<[RegExp, string]> = [
  [/\bwholegrain\b/g, "whole grain"],
  [/\bwholewheat\b/g, "whole wheat"],
  [/\bsugarfree\b/g, "sugar free"],
  [/\bglutenfree\b/g, "gluten free"],
  [/\bcaffeinefree\b/g, "caffeine free"],
  [/\bfatfree\b/g, "fat free"],
];

function normalize(s: string): string {
  let t = (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  for (const [re, to] of COMPOUNDS) t = t.replace(re, to);
  return t;
}

export const words = (s: string) => new Set(normalize(s).split(/\s+/).filter(Boolean));

/** The offending modifier, or "" when listing and donor agree on all of them. */
export function modifierMismatch(listing: string, donor: string): string {
  const L = words(listing), D = words(donor);
  for (const m of MODIFIERS) if (L.has(m) !== D.has(m)) return m;
  return "";
}

/** Owner's rule (2026-07-10): frozen is an **Amazon-only** line — Walmart carries none
 *  (0 of 4243 Walmart listings say "frozen"). So a frozen donor behind a Walmart listing
 *  is a DIFFERENT PRODUCT, not a storage note: a "Vegetable Blend" listing drew "Corn Cob
 *  Bites (Frozen)". Kept out of MODIFIERS on purpose — the reason is a channel policy, not
 *  a word, and an Amazon run must NOT inherit it. */
const frozen = (s: string) => /\bfrozen\b/i.test(s || "");
export const frozenDonorMismatch = (listing: string, donor: string) => frozen(donor) && !frozen(listing);

/** The listing title minus its multipack phrasing. The donor FRONT is a single unit, so
 *  handing "…(Pack of 2)" to the single-unit gate makes it reject perfectly good fronts.
 *  qualifyTiledMain still gets the full title — it takes packCount separately. */
export function baseListingTitle(listing: string): string {
  return (listing || "")
    .replace(/\(?\s*pack\s+of\s+\d+\s*\)?/gi, " ")
    .replace(/\b\d+\s*[-\s]?\s*pack\b/gi, " ")
    .replace(/\bquantity\s+of\s+\d+\b/gi, " ")
    .replace(/\b\d+\s*[-\s]?\s*ct\b/gi, " ")
    .replace(/\b\d+\s*x\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–,.]+|[\s\-–,]+$/g, "") // "2x-Foo" would leave a stray leading dash
    .trim();
}
