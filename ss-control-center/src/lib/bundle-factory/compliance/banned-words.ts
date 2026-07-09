// Phase 2.0 Compliance Gate — banned-word lists.
//
// Four tiers. All comparisons throughout the gate are case-insensitive
// and use word-boundary / substring semantics depending on the rule
// (see each rule file).
//
// Sources:
//   - FOREIGN_BRANDS_HARD_BLOCK — `forbidden-brands.ts` (Phase 2.0a),
//     `docs/marketplace-rules/amazon/prohibited-keywords.md`, and the
//     2026-05-17 incident report. Anything that landed an ASIN block or
//     IP complaint goes here.
//   - OWN_BRANDS — exempt from Rule 1; reused from
//     `bundle-factory/audit/vision-check.ts` (OWN_BRANDS_WHITELIST).
//   - PROMOTIONAL_BANNED — empirically derived from the Phase 2.6.2
//     safety-test failures (Amazon PDP code 99300 triggers). The 2.6.x
//     scrub regex did not catch all of these — hence Rule 8 doing a
//     proper substring scan instead of a single regex.
//   - HEALTH_CLAIM_BANNED — FDA-territory words. All Salutem listings are
//     food bundles, never supplements.

/**
 * Brand names that MUST NOT appear in a Salutem-owned listing's title.
 * Mention in bullets / description is allowed (factual reference to the
 * included product), but title placement implies endorsement.
 *
 * Case-insensitive substring match. Hyphenated AND space-separated
 * forms both listed so operator typos in either direction are caught.
 */
export const FOREIGN_BRANDS_HARD_BLOCK = [
  // 2026-05-17 incident anchors (5 ASINs that took down the account)
  "Goya",
  "El Monterey",
  "Ore-Ida",
  "Ore Ida",
  "Oh Snap",
  "Oh Snap!",
  "Kraft",
  "SpongeBob",

  // High-risk consumable brands flagged across AMZCOM + SALUTEM audit
  "Cheez-It",
  "Cheez Its",
  "Hamburger Helper",
  "Lunchables",
  "Uncrustables",
  "Oscar Mayer",
  "Jimmy Dean",
  "Healthy Choice",
  "Lean Cuisine",
  "Velveeta",
  "Birds Eye",
  "Thomas'",
  "Thomas's",
  "Michelina",
  "Michelina's",
  "Pepperidge Farm",
  "Freshpet",
  "FarmRich",
  "Farm Rich",
  "Eggland's Best",
  "Egglands Best",
  "Old El Paso",
  "Hungry-Man",
  "Hungry Man",
  "Entenmann",
  "Entenmann's",
  "Little Bites",
  "New York Bakery",
  "Texas Toast",

  // Meat / protein brands
  "Tyson",
  "Hormel",
  "Hebrew National",
  "Ball Park",
  "Nathan's",
  "Nathans",
  "Hillshire Farm",
  "Boar's Head",
  "Boars Head",
  "Smucker's",
  "Smuckers",

  // Cereal / breakfast
  "Kellogg",
  "Kellogg's",
  "Kelloggs",
  "General Mills",
  "Pillsbury",
  "Betty Crocker",
  "Quaker",
  "Cheerios",
  "Pop-Tarts",
  "Pop Tarts",
  "Frosted Flakes",
  "Lucky Charms",
  "Eggo",
  "Bagel Bites",

  // Frozen meals
  "Stouffer",
  "Stouffer's",
  "Stouffers",
  "Banquet",
  "Marie Callender",
  "Marie Callender's",
  "Hot Pockets",
  "TGI Friday",
  "TGI Friday's",

  // Condiments / dairy
  "Heinz",
  "French's",
  "Frenchs",
  "Hellmann's",
  "Hellmanns",
  "Philadelphia",
  "Tillamook",
  "Sargento",
  "Land O'Lakes",
  "Land O Lakes",
  "Cabot",
  "Polly-O",
  "Polly O",

  // Candy / snacks
  "M&M",
  "M&Ms",
  "Hershey",
  "Hershey's",
  "Hersheys",
  "Lindt",
  "Godiva",
  "Ferrero",
  "Russell Stover",
  "Reese",
  "Reese's",
  "Reeses",
  "Kit Kat",
  "Snickers",
  "Twix",
  "Skittles",
  "Frito-Lay",
  "Frito Lay",
  "Doritos",
  "Lay's",
  "Lays",
  "Pringles",
  "Goldfish",
  "Cheetos",

  // Beverages
  "Coca-Cola",
  "Coca Cola",
  "Coke",
  "Pepsi",
  "Sprite",
  "Dr Pepper",
  "Mountain Dew",

  // Coffee / tea
  "Starbucks",
  "Folgers",
  "Maxwell House",
  "Nescafe",
  "Nescafé",
  "Dunkin",
  "Bigelow",
  "Twinings",
  "Celestial Seasonings",
  "Lipton",
  "Keurig",
] as const;

export type ForeignBrandHardBlock = (typeof FOREIGN_BRANDS_HARD_BLOCK)[number];

/**
 * Salutem-owned brand names. Allowed everywhere — title, bullets,
 * description, brand field. Used by Rule 1 to skip own-brand matches and
 * by Rule 6 (vision-check.ts already filters these via OWN_BRANDS_WHITELIST).
 *
 * Order matters for `findForeignBrandsInText`: own-brand matches are
 * stripped from the text BEFORE the foreign-brand scan, so a title like
 * "Salutem Vita Heinz Ketchup Gift Set" still flags Heinz without
 * a Vita -> false-positive on something unrelated.
 */
export const OWN_BRANDS = [
  "Salutem Vita",
  "Salutem Solutions",
  "Salutem",
  "Starfit",
] as const;

/**
 * Brands accepted in the Amazon `brand` field for a published Salutem
 * listing. "Generic" is allowed in narrow cases but explicitly NOT for
 * multi-brand bundles (Rule 5 owns that logic; this list is just the
 * allowlist for Rule 2).
 */
export const ALLOWED_BRAND_FIELD_VALUES = [
  "Salutem Vita",
  "Starfit",
  "Generic",
] as const;

/**
 * Promotional / subjective language that triggers Amazon PDP code 99300
 * ("false or promotional claims"). Empirically derived — Phase 2.6.2
 * safety test confirmed that words OUTSIDE this list (`high-quality`,
 * `hassle-free`, `optimal`, `expertly`) also tripped the classifier, so
 * Rule 8 does a plain case-insensitive substring scan instead of a
 * word-boundary regex.
 *
 * Multi-word phrases included as-is — substring scan catches them whole.
 */
export const PROMOTIONAL_BANNED = [
  "ultimate",
  "perfect",
  "delightful",
  "delicious",
  "ideal",
  "amazing",
  "incredible",
  "premium",
  "exclusive",
  "must-have",
  "must have",
  "best",
  "finest",
  "exceptional",
  "outstanding",
  "magnificent",
  "wonderful",
  "fantastic",
  "superior",
  "top-quality",
  "top quality",
  "world-class",
  "world class",
  "awesome",
  "high-quality",
  "high quality",
  "optimal",
  "hassle-free",
  "hassle free",
  "expertly",
  "satisfying",
  "experience the ease",
  "discover",
  "trusted brand",
  "quality and taste",
  "order now",
  "buy today",
  "ready whenever you are",
] as const;

/**
 * Sale / shipping / availability claims. Amazon's Product detail page policy
 * forbids these in title, bullets and description — they are the "false
 * claims" half of error 99300.
 *
 * Empirically confirmed 2026-07-09: the bullet "…each 2.8 oz, sold and shipped
 * frozen." made SP-API VALIDATION_PREVIEW return 99300 on HU-ASMI-DN3X, and
 * dropping just that phrase flipped the listing to VALID (leave-one-out bisect
 * over the 5 bullets). Note the classifier is inconsistent — sibling listings
 * with "Ships frozen…" were accepted — so we ban the phrasing proactively
 * rather than trusting Amazon to catch it every time.
 *
 * Say "Keep frozen" (a storage instruction) instead of "Ships frozen" (a
 * shipping claim). Case-insensitive substring scan in Rule 8.
 */
export const SALE_SHIPPING_CLAIM_BANNED = [
  "sold and shipped",
  "ships frozen",
  "ship frozen",
  "ships fast",
  "ships free",
  "ships today",
  "free shipping",
  "fast shipping",
  "on sale",
  "best price",
  "lowest price",
  "buy now",
  "limited time",
  "while supplies last",
  "money-back",
  "money back",
] as const;

/**
 * Health / medical claims. Even for food bundles, mentioning these
 * lands in FDA-claims territory and triggers Amazon suppression.
 *
 * Case-insensitive substring scan in Rule 8.
 */
export const HEALTH_CLAIM_BANNED = [
  "cure",
  "treat",
  "prevent",
  "boost",
  "weight loss",
  "detox",
  "antioxidant",
  "immune",
  "heal",
  "therapeutic",
  "medical",
  "clinical",
  "prescription",
  "diagnosis",
  "doctor recommended",
  "doctor approved",
  "clinically proven",
  "medically proven",
  "fda approved",
] as const;

/**
 * Lower-cased copies for hot-path scans (avoid re-lower-casing every
 * rule invocation). Exported separately so tests can verify and so
 * future rules can reuse without recomputing.
 */
export const FOREIGN_BRANDS_HARD_BLOCK_LOWER = FOREIGN_BRANDS_HARD_BLOCK.map(
  (s) => s.toLowerCase(),
);
export const OWN_BRANDS_LOWER = OWN_BRANDS.map((s) => s.toLowerCase());
export const PROMOTIONAL_BANNED_LOWER = PROMOTIONAL_BANNED.map((s) =>
  s.toLowerCase(),
);
export const SALE_SHIPPING_CLAIM_BANNED_LOWER = SALE_SHIPPING_CLAIM_BANNED.map(
  (s) => s.toLowerCase(),
);
export const HEALTH_CLAIM_BANNED_LOWER = HEALTH_CLAIM_BANNED.map((s) =>
  s.toLowerCase(),
);

/**
 * Strip own-brand mentions from a text fragment, returning a sanitised
 * lower-cased copy that downstream foreign-brand scans can match against
 * without false positives on Salutem-owned names that happen to share
 * substrings.
 */
export function stripOwnBrands(text: string): string {
  let out = (text || "").toLowerCase();
  for (const own of OWN_BRANDS_LOWER) {
    // Replace every occurrence with a single space so adjacent foreign
    // brand fragments don't accidentally fuse.
    out = out.split(own).join(" ");
  }
  return out;
}

/**
 * Find foreign brands appearing in a piece of text (post own-brand strip).
 * Returns the canonical (original-case) entry from FOREIGN_BRANDS_HARD_BLOCK
 * so caller can show it back to the user verbatim.
 *
 * De-duplicates by lower-case to avoid both "Stouffer" and "Stouffer's"
 * reporting when only one variant actually matched.
 */
export function findForeignBrandsInText(text: string): string[] {
  if (!text) return [];
  const stripped = stripOwnBrands(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < FOREIGN_BRANDS_HARD_BLOCK.length; i++) {
    const canonical = FOREIGN_BRANDS_HARD_BLOCK[i];
    const lower = FOREIGN_BRANDS_HARD_BLOCK_LOWER[i];
    if (stripped.includes(lower) && !seen.has(lower)) {
      seen.add(lower);
      out.push(canonical);
    }
  }
  return out;
}

/**
 * Substring scan for any banned word in `list` against `text`. Returns
 * the canonical entries that matched, de-duplicated.
 */
export function findBannedSubstrings(
  text: string,
  list: readonly string[],
  listLower: readonly string[],
): string[] {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    if (lowerText.includes(listLower[i]) && !seen.has(listLower[i])) {
      seen.add(listLower[i]);
      out.push(list[i]);
    }
  }
  return out;
}
