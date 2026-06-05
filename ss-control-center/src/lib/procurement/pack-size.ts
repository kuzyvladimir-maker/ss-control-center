/**
 * Try to extract a pack-size multiplier from a marketplace product title.
 *
 * Customers order N "listings", but each listing is often itself a multi-
 * unit pack ("Pack of 7", "Bundle of 2 Cartons", "Set of 12"). On the
 * Procurement page we surface that multiplier so Vladimir knows how many
 * PHYSICAL items to grab off the shelf — qty × packSize.
 *
 * Examples it handles:
 *   "Sara Lee ... Bag - Pack Of 7"               → { size: 7, label: "Pack of 7" }
 *   "Del Monte Peaches Sliced 8.5 oz (Pack of 6)" → { size: 6, label: "Pack of 6" }
 *   "Bundle of 2 Cartons"                         → { size: 2, label: "Bundle of 2" }
 *   "Set of 12 Notebooks"                         → { size: 12, label: "Set of 12" }
 *   "Pack-of-4 ..."                               → { size: 4, label: "Pack of 4" }
 *   "Quantity of 4"                               → { size: 4, label: "Quantity of 4" }
 *   "24 Cans, Cheese & Gravy"                     → { size: 24, label: "24 Cans" }
 *   "8-Can Everyday Veggie Essentials"            → { size: 8, label: "8-Can" }
 *   "12 Count, ..."                               → { size: 12, label: "12 Count" }
 *   "Family Pack, 6 Pieces"                       → { size: 6, label: "6 Pieces" }
 *
 * Returns null when no recognised pattern is found — the caller (UI) then
 * either falls back to plain "qty шт" display or hits the AI endpoint
 * (/api/procurement/pack-size) for compound cases like
 * "12 / Carton | Bundle of 2 Cartons" (= 24) which pure regex can't
 * multiply.
 *
 * The `ambiguous` flag signals "regex found ONE simple multiplier but
 * there are other plausible quantity tokens in the title" — the UI uses
 * that to decide whether to also ask the AI endpoint for a second
 * opinion. Saves AI calls on the easy cases.
 */
export interface PackSize {
  size: number;
  label: string;
  /** True when the title contains multiple plausible quantity tokens
   *  (e.g. "12 / Carton | Bundle of 2") — regex picked one but the AI
   *  fallback may have a better answer. */
  ambiguous?: boolean;
}

// ── "X of N" patterns. The noun comes first, then "of", then the number.
// Order matters only for the label — every match returns the first N found.
const X_OF_N_PATTERNS: Array<{ regex: RegExp; nounLabel: string }> = [
  { regex: /\bpack[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Pack of" },
  { regex: /\bbundle[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Bundle of" },
  { regex: /\bset[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Set of" },
  { regex: /\bbox[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Box of" },
  { regex: /\bcase[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Case of" },
  { regex: /\bcount[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Count of" },
  { regex: /\bquantity[\s\-]+of[\s\-]+(\d+)\b/i, nounLabel: "Quantity of" },
];

// ── "N <unit>" patterns. The number comes first, then a quantity noun.
// More forgiving — covers "24 Cans", "8-Can", "12 Count", "6 Pieces".
// Anchored with a word boundary AND a non-digit lookbehind via [^.\d]/start
// so "8.5 oz" and "10.5 Ounce" don't get mis-matched as "8 oz" or "10 Ounce".
const N_UNIT_PATTERNS: Array<{ regex: RegExp; unitLabel: string }> = [
  // "N Cans" / "N-Can" / "N Can"
  { regex: /(?:^|[^.\d])(\d+)[\s\-]*cans?\b/i, unitLabel: "Cans" },
  // "N Bottles" / "N-Bottle"
  { regex: /(?:^|[^.\d])(\d+)[\s\-]*bottles?\b/i, unitLabel: "Bottles" },
  // "N Boxes" / "N-Box"
  { regex: /(?:^|[^.\d])(\d+)[\s\-]*boxes?\b/i, unitLabel: "Boxes" },
  // "N Bags" / "N-Bag"
  { regex: /(?:^|[^.\d])(\d+)[\s\-]*bags?\b/i, unitLabel: "Bags" },
  // "N Packs" / "N-Pack" — NB this is "N Pack" not "Pack of N"
  { regex: /(?:^|[^.\d])(\d+)[\s\-]*packs?\b/i, unitLabel: "Pack" },
  // "N Pouches"
  { regex: /(?:^|[^.\d])(\d+)[\s\-]*pouch(?:es)?\b/i, unitLabel: "Pouches" },
  // "N Count" / "N-Count" / "N ct" / "N Ct"
  { regex: /(?:^|[^.\d])(\d+)[\s\-]*(?:count|ct)\b/i, unitLabel: "Count" },
  // "N Pieces" / "N pcs"
  { regex: /(?:^|[^.\d])(\d+)[\s\-]*(?:pieces?|pcs)\b/i, unitLabel: "Pieces" },
  // "N Cartons" — NB compound "12 / Carton" requires AI
  { regex: /(?:^|[^.\d])(\d+)[\s\-]*cartons?\b/i, unitLabel: "Cartons" },
];

const ALL_N_CAPTURE_RE =
  /(?:^|[^.\d])(\d+)[\s\-]*(?:cans?|bottles?|boxes?|bags?|packs?|pouch(?:es)?|count|ct|pieces?|pcs|cartons?|of)\b/gi;

function isPlausibleSize(n: number): boolean {
  return Number.isFinite(n) && n >= 2 && n <= 999;
}

/**
 * Sync regex extractor. Always cheap, always synchronous. Returns null
 * when no pattern matches OR when the matched value falls outside the
 * plausible range. The `ambiguous` flag in the result tells the caller
 * whether an AI second-opinion is worth asking for.
 */
export function parsePackSize(title: string | null | undefined): PackSize | null {
  if (!title) return null;

  // First pass: "X of N" patterns (Pack of N, Bundle of N, etc.).
  for (const { regex, nounLabel } of X_OF_N_PATTERNS) {
    const m = title.match(regex);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (isPlausibleSize(n)) {
        return {
          size: n,
          label: `${nounLabel} ${n}`,
          ambiguous: hasOtherPlausibleNumbers(title, n),
        };
      }
    }
  }

  // Second pass: "N <unit>" patterns. We pick the LARGEST candidate that
  // matches a known unit noun — heuristic: when a title contains
  // "24 Cans" alongside "(Pack of 4)", the customer-facing total count
  // tends to be the larger number. (Compound cases like "12/Carton x
  // Bundle of 2" still need AI to multiply.)
  let best: { size: number; label: string } | null = null;
  for (const { regex, unitLabel } of N_UNIT_PATTERNS) {
    const m = title.match(regex);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (!isPlausibleSize(n)) continue;
      if (!best || n > best.size) {
        best = { size: n, label: `${n} ${unitLabel}` };
      }
    }
  }
  if (best) {
    return {
      ...best,
      ambiguous: hasOtherPlausibleNumbers(title, best.size),
    };
  }

  return null;
}

/**
 * Heuristic: does the title contain a SECOND plausible quantity number
 * besides the one we already matched? Compound expressions like
 * "12 / Carton | Bundle of 2 Cartons" have two relevant numbers (12 and
 * 2), and the right answer is the product (24) which regex can't compute.
 * When this returns true, the UI escalates to the AI endpoint.
 */
function hasOtherPlausibleNumbers(title: string, picked: number): boolean {
  const seen = new Set<number>();
  ALL_N_CAPTURE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ALL_N_CAPTURE_RE.exec(title)) !== null) {
    const n = parseInt(m[1], 10);
    if (isPlausibleSize(n)) seen.add(n);
  }
  seen.delete(picked);
  return seen.size > 0;
}
