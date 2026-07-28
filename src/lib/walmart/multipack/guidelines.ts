// Official Walmart Marketplace listing-quality content targets, encoded so the
// generator aims for them and the validator flags gaps. Sources: Walmart
// "Listing Quality Optimization Guide" + Listing Quality Dashboard (Marketplace
// Learn). These drive the "Content & Discoverability" sub-score.

export const WALMART_CONTENT_TARGETS = {
  titleMinChars: 50,
  titleMaxChars: 75,          // optimization target; exact current Product Type spec owns the hard ceiling
  imagesMin: 4,               // minimum for a healthy listing
  imagesIdeal: 6,             // 6+ scores best
  keyFeaturesMin: 3,
  keyFeaturesIdeal: 5,
  keyFeaturesMaxChars: 200,   // project optimization target; exact Product Type spec owns hard limit
  descriptionMinChars: 700,   // project proxy for U.S. guide's ~150-word general guidance
} as const;

// Rules block injected into the AI copy prompt (official guidance + brand voice).
export const WALMART_CONTENT_RULES = `Walmart content quality rules (official, drive the Content & Discoverability score):
- Title order: Brand + exact Item/Product Type + Model/Style/Variant + key attributes + single-unit size/count + Pack Count.
- Keep the searchable product identity before the outer Pack Count; never lead a standard grocery multipack title with "Pack of N".
- Aim for 50-75 characters unless the exact current Product Type spec requires a different boundary.
- Provide 3-10 key features; 4-7 is our optimization target. Keep each concise and factual; the exact current Product Type spec owns the hard field limit.
- Description: complete and keyword-rich; ~150 words is general U.S. guidance and category requirements may differ. Cover what it is, what's inside, sizes, uses, and storage.
- Cover the product's searchable attributes (flavor, size, material, dietary tags) in natural language for discoverability.
- Factual only — no promo/subjective adjectives, no emojis, no manual bullet glyphs, no health/medical claims.`;

export interface ContentGap { field: string; issue: string; severity: "high" | "med" | "low"; }

const LEADING_PACK_COUNT_RE =
  /^\s*(?:pack\s+of\s+\d+\b|\d+\s*(?:-|–|—|\s)?\s*pack\b|\d+\s*(?:ct|count)\b)/i;

/** Standard grocery multipacks should lead with product identity, not quantity.
 *  Category-mandated prefixes remain the responsibility of the exact current
 *  Product Type spec and must not be inferred from this generic content target. */
export function hasFrontLoadedPackCount(title: string): boolean {
  return LEADING_PACK_COUNT_RE.test(title);
}

/** Validate assembled content against Walmart targets. Returns gaps to surface
 *  in the remediation log (and to feed back into the AI prompt next round). */
export function validateListingContent(args: {
  title: string; keyFeatures: string[]; description: string; imageCount: number;
}): ContentGap[] {
  const t = WALMART_CONTENT_TARGETS;
  const gaps: ContentGap[] = [];
  const titleLen = args.title.length;
  if (hasFrontLoadedPackCount(args.title)) {
    gaps.push({
      field: "title",
      issue: "pack/count is front-loaded; lead with brand and exact product identity, then place Pack Count later",
      severity: "med",
    });
  }
  if (titleLen > t.titleMaxChars + 5) gaps.push({ field: "title", issue: `title ${titleLen} chars > ${t.titleMaxChars}`, severity: "low" });
  if (titleLen < t.titleMinChars) gaps.push({ field: "title", issue: `title ${titleLen} chars < ${t.titleMinChars}`, severity: "low" });
  if (args.imageCount < t.imagesMin) gaps.push({ field: "images", issue: `${args.imageCount} images < min ${t.imagesMin}`, severity: "high" });
  else if (args.imageCount < t.imagesIdeal) gaps.push({ field: "images", issue: `${args.imageCount} images < ideal ${t.imagesIdeal}`, severity: "med" });
  if (args.keyFeatures.length < t.keyFeaturesMin) gaps.push({ field: "keyFeatures", issue: `${args.keyFeatures.length} bullets < min ${t.keyFeaturesMin}`, severity: "high" });
  else if (args.keyFeatures.length < t.keyFeaturesIdeal) gaps.push({ field: "keyFeatures", issue: `${args.keyFeatures.length} bullets < ideal ${t.keyFeaturesIdeal}`, severity: "low" });
  const tooLong = args.keyFeatures.filter((b) => b.length > t.keyFeaturesMaxChars).length;
  if (tooLong) gaps.push({ field: "keyFeatures", issue: `${tooLong} bullet(s) > ${t.keyFeaturesMaxChars} chars`, severity: "low" });
  if (args.description.length < t.descriptionMinChars) gaps.push({ field: "description", issue: `description ${args.description.length} chars < ${t.descriptionMinChars} (~150 words)`, severity: "med" });
  return gaps;
}
