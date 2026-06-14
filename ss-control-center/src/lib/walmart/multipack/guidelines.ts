// Official Walmart Marketplace listing-quality content targets, encoded so the
// generator aims for them and the validator flags gaps. Sources: Walmart
// "Listing Quality Optimization Guide" + Listing Quality Dashboard (Marketplace
// Learn). These drive the "Content & Discoverability" sub-score.

export const WALMART_CONTENT_TARGETS = {
  titleMinChars: 50,
  titleMaxChars: 75,          // hard ceiling is higher, but 50-75 is the recommended band
  imagesMin: 4,               // minimum for a healthy listing
  imagesIdeal: 6,             // 6+ scores best
  keyFeaturesMin: 3,
  keyFeaturesIdeal: 5,
  keyFeaturesMaxChars: 200,   // per bullet, concise
  descriptionMinChars: 700,   // ~150 words, Walmart's completeness bar
} as const;

// Rules block injected into the AI copy prompt (official guidance + brand voice).
export const WALMART_CONTENT_RULES = `Walmart content quality rules (official, drive the Content & Discoverability score):
- Title format: Brand + Key Features + Product Type + Attributes (size/flavor/count); 50-75 characters.
- Provide 4-7 key features. Each is one concise, factual sentence (<=200 chars).
- Description: complete and keyword-rich, ~150+ words, covering what it is, what's inside, sizes, uses, and storage.
- Cover the product's searchable attributes (flavor, size, material, dietary tags) in natural language for discoverability.
- Factual only — no promo/subjective adjectives, no emojis, no manual bullet glyphs, no health/medical claims.`;

export interface ContentGap { field: string; issue: string; severity: "high" | "med" | "low"; }

/** Validate assembled content against Walmart targets. Returns gaps to surface
 *  in the remediation log (and to feed back into the AI prompt next round). */
export function validateListingContent(args: {
  title: string; keyFeatures: string[]; description: string; imageCount: number;
}): ContentGap[] {
  const t = WALMART_CONTENT_TARGETS;
  const gaps: ContentGap[] = [];
  const titleLen = args.title.length;
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
