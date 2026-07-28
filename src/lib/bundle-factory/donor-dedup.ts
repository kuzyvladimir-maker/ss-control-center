/**
 * Donor flavor dedup + per-unit cost — pre-planner normalisation for the mass
 * generator.
 *
 * The Reference Catalog holds the SAME flavor many times (different retailers /
 * pack sizes: "PB & Strawberry 4ct $3.97", "PB & Strawberry 10 Count $9.84"…).
 * Feeding raw donors into planVariations() would (a) produce nonsense mixes
 * ("Strawberry + Strawberry") and (b) price COGS off the PACK price as if it
 * were the UNIT price ($9.84/sandwich instead of $0.98). This module:
 *
 *   1. parsePackUnits(title)     — units in the retail pack, from the title.
 *   2. canonicalFlavorKey(title) — normalised flavor identity (brand/size/count
 *      words stripped; "Whole Wheat"/"Morning Protein" variants stay distinct).
 *   3. dedupeDonorFlavors(donors) — one entry per flavor: the donor with the
 *      CHEAPEST per-unit cost wins. DonorProduct.bestPrice is already the
 *      DonorOffer.pricePerUnit rollup; dividing it by the title's retail count
 *      again would understate COGS by 4–15x.
 *
 * Pure + deterministic → unit-tested (donor-dedup.test.ts).
 */

export interface DedupableDonor {
  id: string;
  title: string | null;
  brand: string | null;
  productLine: string | null;
  flavor: string | null;
  /** Canonical DonorProduct rollup: per base unit, dollars. */
  bestPrice: number | null;
  /** Raw retailer offers, when available. `bestPrice` is historically
   * ambiguous for warehouse-club rows because their procurement rollup treats
   * the whole carton as the buy unit. Bundle Factory needs one sandwich/unit,
   * so raw listing price ÷ observed count is the stronger source. */
  offers?: ReadonlyArray<{
    price: number | null;
    packSizeSeen: number | null;
    pricePerUnit?: number | null;
  }>;
}

export interface FlavorEntry<T extends DedupableDonor = DedupableDonor> {
  key: string;
  label: string;
  donor: T;
  /** Cheapest per-unit cost across the flavor's donors, cents. null = unknown. */
  unit_price_cents: number | null;
  costable: boolean;
  /** ALL retail pack sizes seen for this flavor across the catalog (union over
   *  the group's donors, e.g. strawberry {4,10,15}). Drives the exact-box rule
   *  on the MAIN image: boxes only when the count splits into REAL sizes. */
  pack_sizes: number[];
}

/** Units in the retail pack, parsed from the title ("10 Count", "8oz/4ct",
 *  "2ct/30oz" → 10 / 4 / 2). null when the title carries no count. */
export function parsePackUnits(title: string | null | undefined): number | null {
  const t = (title ?? "").toLowerCase();
  const m = t.match(/(\d{1,3})\s*(?:ct\b|count\b)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 200) return n;
  }
  return null;
}

// Words that never distinguish one flavor from another.
const STOP_WORDS = new Set([
  "frozen", "refrigerated", "sandwich", "sandwiches", "snack", "snacks",
  "multipack", "pack", "packs", "bag", "bags", "box", "boxes", "tray", "case",
  "each", "size", "family", "value", "bulk", "wrapped", "individually",
]);

/** Normalised flavor identity from a donor title: lowercase, sizes/counts and
 *  brand/product-line tokens removed, filler words dropped. Distinct product
 *  variants ("Whole Wheat …", "Morning Protein …") keep their qualifier. */
/** Tokens (≥3 chars, + singular/plural twin) from a brand / product-line
 *  string — the words to strip from titles when deriving flavor identity. */
export function brandTokens(...sources: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const src of sources) {
    for (const tok of (src ?? "").toLowerCase().replace(/[''`’]/g, "").split(/[^a-z]+/)) {
      if (tok.length >= 3) {
        out.add(tok);
        out.add(tok.endsWith("s") ? tok.slice(0, -1) : `${tok}s`);
      }
    }
  }
  return out;
}

export function canonicalFlavorKey(
  title: string | null | undefined,
  opts: {
    brand?: string | null;
    productLine?: string | null;
    /** Extra tokens to strip — pass the UNION of brand tokens across the whole
     *  donor set: catalog rows carry the brand inconsistently ("Uncrustables" /
     *  "Smucker'S" / null), so per-donor stripping alone leaks brand words into
     *  some keys and the same flavor splits into several entries. */
    extraTokens?: Iterable<string>;
  } = {},
): string {
  let s = (title ?? "").toLowerCase().replace(/[''`’]/g, "");
  // Sizes + counts + loose numbers.
  s = s
    .replace(/\d+(?:\.\d+)?\s*(?:oz|lb|lbs|g|kg|ml|fl)\b/g, " ")
    .replace(/\d+\s*(?:ct|count)\b/g, " ")
    .replace(/pack of\s*\d+/g, " ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " ");
  // Punctuation → spaces (keep & — it separates flavor halves).
  s = s.replace(/[^a-z&\s]/g, " ");
  // Brand + product-line tokens (e.g. "smuckers", "uncrustables").
  const skip = brandTokens(opts.brand, opts.productLine);
  for (const tok of opts.extraTokens ?? []) skip.add(tok);
  const words = s
    .split(/\s+/)
    .filter((w) => w.length > 0 && w !== "s" && !skip.has(w) && !STOP_WORDS.has(w));
  return words.join(" ").trim();
}

/** Title-case a canonical key for use as the planner/display label. */
function labelFor(key: string): string {
  return key
    .split(" ")
    .map((w) => (w === "&" ? "&" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Truncate at a WORD boundary (a mid-word cut turned "…Jelly Protein" into
 *  "…Jelly Pro" on the owner's review screen). */
function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : s.slice(0, max)).trim();
}

/** Per consumer unit from factual raw offers. Null when no raw total price is
 * available. Title count is a deterministic fallback/cross-check for legacy
 * offers whose `packSizeSeen` was stored as 1. */
export function normalizedOfferUnitPriceCents(
  d: Pick<DedupableDonor, "title" | "offers">,
): number | null {
  const titleUnits = parsePackUnits(d.title);
  const candidates: number[] = [];
  for (const offer of d.offers ?? []) {
    if (typeof offer.price !== "number" || !Number.isFinite(offer.price) || offer.price <= 0) {
      continue;
    }
    const observed =
      typeof offer.packSizeSeen === "number" &&
      Number.isInteger(offer.packSizeSeen) &&
      offer.packSizeSeen > 0
        ? offer.packSizeSeen
        : 1;
    const divisor = Math.max(observed, titleUnits ?? 1);
    candidates.push(Math.round((offer.price / divisor) * 100));
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** Per-unit cost in cents for one donor, or null when un-costable. */
export function donorUnitPriceCents(d: DedupableDonor): number | null {
  const fromRawOffer = normalizedOfferUnitPriceCents(d);
  if (fromRawOffer != null && fromRawOffer > 0) return fromRawOffer;
  if (typeof d.bestPrice !== "number" || !(d.bestPrice > 0)) return null;
  return Math.round(d.bestPrice * 100);
}

/**
 * Collapse donors into one entry per flavor. Winner = cheapest per-unit donor.
 * Entries with `costable:false` (no donor in the group had a parseable pack)
 * should be excluded from automatic planning — a listing can't be priced off
 * an unknown unit cost.
 */
export function dedupeDonorFlavors<T extends DedupableDonor>(
  donors: T[],
): FlavorEntry<T>[] {
  // Union of brand/product-line tokens across the WHOLE set — catalog rows
  // carry the brand inconsistently, so every title is stripped with the same
  // vocabulary ("Smuckers X" ≡ "Uncrustables X" ≡ "X").
  const shared = brandTokens(...donors.flatMap((d) => [d.brand, d.productLine]));
  const groups = new Map<string, FlavorEntry<T>>();
  for (const d of donors) {
    const key =
      (d.flavor ?? "").trim().toLowerCase() ||
      canonicalFlavorKey(d.title, {
        brand: d.brand,
        productLine: d.productLine,
        extraTokens: shared,
      });
    if (!key) continue;
    const unit = donorUnitPriceCents(d);
    const units = parsePackUnits(d.title);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        label: truncateAtWord(labelFor(key), 60),
        donor: d,
        unit_price_cents: unit,
        costable: unit != null,
        pack_sizes: units != null ? [units] : [],
      });
      continue;
    }
    if (units != null && !existing.pack_sizes.includes(units)) existing.pack_sizes.push(units);
    // A costable donor always beats an un-costable one; among costable donors
    // the cheaper per-unit price wins.
    if (unit != null && (existing.unit_price_cents == null || unit < existing.unit_price_cents)) {
      existing.donor = d;
      existing.unit_price_cents = unit;
      existing.costable = true;
    }
  }
  for (const e of groups.values()) e.pack_sizes.sort((a, b) => b - a);
  return Array.from(groups.values());
}
