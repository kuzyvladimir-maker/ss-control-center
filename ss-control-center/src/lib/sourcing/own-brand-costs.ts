// OWN-BRAND manual cost table — the TOP tier of the COGS ladder.
//
// A handful of our listings are OUR OWN products (Starfit jump ropes + supplements,
// Salutem Vita detox). They have NO retail donor to price against, so the retail
// search + Google fallback can never cost them. Vladimir gives us the true landed
// cost per unit directly; this module returns it so the engine can cost these SKUs
// with confidence 1.0 and skip all paid retail search.
//
// IMPORTANT — this is DELIBERATELY narrow. It matches ONLY our specific own-brand
// products by brand + product keyword. Salutem Vita *gift sets* (assembled from
// third-party brands) must NOT match here — they decompose into components and get
// priced at retail. So we key on the concrete product word (jump rope / detox /
// lion's mane / nicotinamide), never on the brand alone.
//
// Costs provided by Vladimir 2026-07-04 (memory: reference_own_brand_costs).
// To add a new own-brand SKU: add a row to OWN_BRAND_COSTS below.

export type OwnBrandCostHit = {
  perUnit: number; // landed cost of ONE base unit ($)
  label: string; // human label for logs / notes
  method: "own-brand"; // provenance tag written to SkuCost.notes / SkuComponent.costMethod
};

type OwnBrandRule = {
  key: string;
  // Brand gate — our own brands. Kept a touch loose (Starfit / Salutem Vita /
  // Salutem Solutions) because the product-keyword gate below is what actually
  // pins the match; the brand gate just prevents a third-party "detox tea" hit.
  brand: RegExp;
  // The concrete product this rule prices. Must appear in the identity text.
  product: RegExp;
  // Default per-unit cost.
  perUnit: number;
  // Optional pack-economy override: when the config matches `packWhen`, use
  // `packPerUnit` instead (e.g. Starfit rope is $0.80 single but $0.75/rope in a
  // 2-pack, since the 2-pack lands at $1.50). The engine multiplies perUnit ×
  // units_in_listing, so we express the pack as a per-rope number.
  packWhen?: RegExp;
  packPerUnit?: number;
};

const OWN_BRAND = /\b(starfit|star\s?fit|salutem\s?vita|salutem\s?solutions)\b/i;

const OWN_BRAND_COSTS: OwnBrandRule[] = [
  {
    key: "starfit-jump-rope",
    brand: OWN_BRAND,
    product: /\b(jump\s?rope|jumping\s?rope|skipping\s?rope|speed\s?rope)\b/i,
    perUnit: 0.8, // single rope
    packWhen: /\b(2\s?[- ]?pack|pack\s?of\s?2|set\s?of\s?2|two\s?pack|double|2\s?pk|x\s?2)\b/i,
    packPerUnit: 0.75, // $1.50 / 2 ropes
  },
  {
    key: "salutem-vita-detox",
    brand: OWN_BRAND,
    product: /\bdetox\b/i,
    perUnit: 5.5,
  },
  {
    key: "starfit-lions-mane",
    brand: OWN_BRAND,
    product: /\b(lion'?s?\s?mane|lions\s?mane)\b/i,
    perUnit: 6.5,
  },
  {
    key: "starfit-nicotinamide",
    brand: OWN_BRAND,
    product: /\b(nicotinamide|niacinamide|nad\+?\s?precursor)\b/i,
    perUnit: 7.5,
  },
];

// Resolve an own-brand manual cost for a product config, or null if it isn't one of
// ours. `brand` + `text` (product line / flavor / base_unit / title — anything that
// names the product) + optional `size`/pack text are matched against the rules.
export function ownBrandCost(parts: {
  brand?: string | null;
  text?: string | null;
  size?: string | null;
  units?: number | null; // units_in_listing — a 2-pack rope arrives as units=2, not text
}): OwnBrandCostHit | null {
  // Normalize typographic apostrophes (’ U+2019, ‘ U+2018, ` U+0060) to a straight '
  // so "Lion’s Mane" (how Walmart/Amazon titles render it) matches the same as "Lion's".
  const norm = (s?: string | null) => (s || "").replace(/[‘’`]/g, "'");
  const brand = norm(parts.brand).trim();
  const text = `${norm(parts.brand)} ${norm(parts.text)}`.trim();
  // Fold the unit count into the pack context so "units_in_listing: 2" reads as
  // "2 pack" for the packWhen regex (the 2-pack signal is usually in the count).
  const unitHint = parts.units && parts.units > 1 ? ` ${parts.units} pack` : "";
  const packCtx = `${norm(parts.text)} ${norm(parts.size)}${unitHint}`;
  if (!text) return null;
  for (const r of OWN_BRAND_COSTS) {
    // Brand may live in `brand` OR inline in the combined text.
    if (!r.brand.test(brand) && !r.brand.test(text)) continue;
    if (!r.product.test(text)) continue;
    const isPack = r.packWhen != null && r.packPerUnit != null && r.packWhen.test(packCtx);
    const perUnit = isPack ? (r.packPerUnit as number) : r.perUnit;
    return { perUnit, label: `${r.key}${isPack ? " (pack)" : ""}`, method: "own-brand" };
  }
  return null;
}
