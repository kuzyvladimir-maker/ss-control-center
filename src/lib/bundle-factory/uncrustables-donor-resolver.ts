// Uncrustables donor resolver — picks the exact-variant donor row for a
// component flavor out of the Uncrustables donor pool. Extracted verbatim
// from scripts/_trial_render.ts (QUALIFIERS + donorFor); the script remains
// the fallback operator path.
//
// Disambiguation contract (proven over the trial run):
//   1. every word of the flavor (len >= 3) must appear in the donor title;
//   2. any qualifier NOT present in the flavor is BANNED from the title
//      (stops "Whole Wheat Strawberry" donors matching plain "Strawberry");
//   3. every qualifier present in the flavor is REQUIRED in the title;
//   4. among survivors, donors whose title carries the preferred retail pack
//      size ("Nct"/"N count") sort first, then cheapest per-unit cost wins.

import { donorUnitPriceCents } from "./donor-dedup";

/** Flavor qualifiers used for token disambiguation. A qualifier absent from
 *  the requested flavor bans matching donor titles; one present is required. */
export const UNCRUSTABLES_DONOR_QUALIFIERS: string[] = [
  "whole wheat", "protein", "morning", "reduced sugar", "beamin",
  "strawberry", "grape", "honey", "chocolate", "hazelnut",
  "raspberry", "blueberry", "blackberry", "mixed berry", "apple cinnamon",
];

/** Minimal structural donor row — matches the DonorProduct select used by the
 *  trial-render script (and satisfies donor-dedup's DedupableDonor). */
export type DonorRow = {
  id: string;
  title: string | null;
  brand: string | null;
  productLine: string | null;
  flavor: string | null;
  mainImageUrl: string | null;
  bestPrice: number | null;
  offers?: ReadonlyArray<{
    price: number | null;
    packSizeSeen: number | null;
    pricePerUnit?: number | null;
  }>;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Resolve the donor for a flavor. `preferredSize` is the retail carton size
 *  of the reviewed package art — a matching "Nct"/"N count" title wins the
 *  sort so the rendered carton matches the donor photo. Null when no donor
 *  survives disambiguation. */
export function resolveUncrustablesDonor<T extends DonorRow>(
  donors: T[],
  flavor: string,
  preferredSize?: number | null,
): T | null {
  const f = norm(flavor);
  const wanted = UNCRUSTABLES_DONOR_QUALIFIERS.filter((q) => f.includes(q));
  const banned = UNCRUSTABLES_DONOR_QUALIFIERS.filter((q) => !f.includes(q));
  const candidates = donors.filter((d) => {
    const t = norm(d.title ?? "");
    if (!f.split(" ").every((w) => w.length < 3 || t.includes(w))) return false;
    if (banned.some((q) => t.includes(q))) return false;
    if (!wanted.every((q) => t.includes(q))) return false;
    return true;
  });
  const sizeRe = preferredSize
    ? new RegExp(`(?:^|[^0-9])${preferredSize}\\s*(?:ct\\b|count\\b)`, "i")
    : null;
  candidates.sort((a, b) => {
    const am = sizeRe && sizeRe.test(a.title ?? "") ? 0 : 1;
    const bm = sizeRe && sizeRe.test(b.title ?? "") ? 0 : 1;
    if (am !== bm) return am - bm;
    return (donorUnitPriceCents(a) ?? 9e9) - (donorUnitPriceCents(b) ?? 9e9);
  });
  return candidates[0] ?? null;
}
