// Foreign brands the audit pipeline treats as risky when found in a
// Salutem-owned listing's title, bullets, or main image. Source of truth
// for:
//   - risk-scorer.ts (title regex match → +40 risk)
//   - vision-check.ts (image logo prompt → list passed to Claude Vision)
//
// Names normalised:
//   - Strip trailing "'s" when matching but keep the apostrophe form in
//     the canonical list (regex below escapes it).
//   - Hyphenated forms ("Ore-Ida") AND space-separated ("Ore Ida") both
//     listed so we catch operator typos in either direction.
//
// Add entries here whenever a new Amazon IP incident hits the brand —
// pair with a BrandConflict row in prisma/seed/brand-conflicts.ts when
// there's a specific ASIN tied to the violation.

export const FOREIGN_BRAND_NAMES = [
  // ── 2026-05-17 incident brands (permanent blocklist anchors) ──
  "Goya",
  "Kraft",
  "Ore-Ida",
  "Ore Ida",
  "El Monterey",
  "Oh Snap",
  "Oh Snap!",

  // ── High-risk consumable brands (Vladimir's typical sourcing pool) ──
  "Lunchables",
  "Uncrustables",
  "Jimmy Dean",
  "Smucker's",
  "Eggland's",
  "Hormel",
  "Tyson",
  "Stouffer",
  "Healthy Choice",
  "Marie Callender",
  "Hot Pockets",
  "Lean Cuisine",
  "Eggo",
  "Bagel Bites",
  "TGI Friday",
  "Pillsbury",
  "Quaker",
  "Kellogg",
  "Cheerios",
  "Pop-Tarts",
  "Frito-Lay",
  "Doritos",
  "Lay's",
  "Pringles",
  "Cheez-It",
  "Goldfish",
  "Cheetos",

  // ── Common gift basket components ──
  "Ghirardelli",
  "Hershey",
  "Hershey's",
  "Lindt",
  "Godiva",
  "Ferrero",
  "Coca-Cola",
  "Coke",
  "Pepsi",
  "Sprite",
  "Dr Pepper",
  "Mountain Dew",
  "Starbucks",
  "Folgers",
  "Maxwell House",
  "Nescafe",
  "Keurig",
] as const;

export type ForbiddenBrand = (typeof FOREIGN_BRAND_NAMES)[number];

// Own-brand names — appearance in title is fine. Compared case-insensitive.
export const OWN_BRANDS = ["Salutem Vita", "Starfit"] as const;

// Amazon browse-node IDs that DO allow multi-brand gift baskets (Gift
// Basket Exception, Oct 14 2024). Listings under these nodes can mention
// component brands legitimately, so the audit penalty for multi-brand
// shrinks substantially.
export const GIFT_BASKET_EXCEPTION_NODES = [
  "12011207011",
  "2255572011",
  "2255573011",
  "23900459011",
  "23700435011",
  "78380725011",
] as const;
