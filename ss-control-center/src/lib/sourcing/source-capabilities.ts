// Retail data-source capability map — the SINGLE SOURCE OF TRUTH for routing.
//
// Built from LIVE probes (Oxylabs) + code/docs (Unwrangle, dry) on 2026-07-05. The
// engine routes by THIS table so we never fan out to paid services blindly again:
// for every retailer we know, up front, which service gives the PRICE and which gives
// the CONTENT (photos / nutrition / ingredients / UPC), in cheapest-first tier order.
//
// Full write-up + evidence: docs/wiki/retail-source-capability-matrix.md
//
// Objective findings that shape the routing:
//  • Oxylabs has STRUCTURED parsers for ONLY walmart, amazon, google_shopping.
//  • Oxylabs amazon_product is COMPLETE (8 imgs + bullets + desc + UPC + text
//    ingredients + 1P/3P) → Amazon needs NO Unwrangle.
//  • Oxylabs walmart_product gives price + gallery + desc, but nutrition/ingredients
//    are only LABEL-IMAGE URLs and there is NO UPC → Unwrangle walmart_detail is the
//    only structured Walmart nutrition/ingredients/UPC source.
//  • Target/Sam's/Costco: no Oxylabs parser → Unwrangle only (Sam's/Costco detail = 10
//    credits each → use sparingly).
//  • Publix / Aldi / BJ's: NO paid API reaches them (Unwrangle has no Instacart) →
//    the logged-in OpenClaw browser is the ONLY path, or they're unsourceable.
//  • Google Shopping = last-resort estimate, MIX of 1P + 3P resellers → take the
//    first-party merchant only, never a reseller price.

// The FULL enrichment field set we harvest per product (not just price/photos).
// A listing needs everything here. Grouped: identity, pricing, text, GRAPHICS,
// structured ATTRIBUTES, nutrition/compliance, variations, social.
export type DataField =
  // identity
  | "upc" | "brand" | "model" | "category"
  // pricing
  | "price"
  // text content
  | "title" | "description" | "bullets"
  // graphics — the full gallery (main + angles + infographics + lifestyle + label
  // images are all inside the images[] array) + product videos
  | "images" | "video"
  // structured attributes — the FULL spec array: size, weight, dimensions, flavor,
  // color, material, form, container, count, prep, shelf-life, texture, etc.
  | "attributes"
  | "variations"
  // nutrition / compliance (grocery)
  | "nutrition" | "ingredients" | "allergens"
  // social proof
  | "reviews";

// NOTE: A+/Enhanced brand-content imagery (Amazon A+, Walmart Rich Media) is NOT
// returned by any product API — we GENERATE it (Bundle Factory / A+ Content Factory),
// not harvest it. So "graphics" here = the standard gallery + videos; A+ is a separate
// generation pipeline.

export type SourceKey =
  | "oxylabs:walmart" | "oxylabs:amazon" | "oxylabs:google"
  | "unwrangle:walmart" | "unwrangle:target" | "unwrangle:samsclub" | "unwrangle:costco" | "unwrangle:amazon"
  | "openclaw:publix" | "openclaw:aldi" | "openclaw:bjs";

export interface SourceCapability {
  key: SourceKey;
  service: "oxylabs" | "unwrangle" | "openclaw";
  structured: boolean;
  provides: DataField[];
  creditCost: number | null; // Unwrangle credits/call where known; null = flat-sub/free-compute
  firstParty: "clean" | "mixed" | "gated"; // clean=true 1P; mixed=1P+3P; gated=member/store login
  note: string;
}

// What each concrete source objectively returns.
export const SOURCE_CAPS: Record<SourceKey, SourceCapability> = {
  "oxylabs:walmart":   { key: "oxylabs:walmart",   service: "oxylabs",   structured: true,  provides: ["price", "images", "title", "description", "bullets", "category", "attributes", "variations", "brand"], creditCost: null, firstParty: "clean", note: "walmart_product = price + 7-img gallery + desc + category(breadcrumbs) + 19-field specifications (size/weight/flavor/material/form/container/prep/shelf-life/texture…) + variations. NO UPC; nutrition/ingredients only as label-image URLs (in specs)." },
  "oxylabs:amazon":    { key: "oxylabs:amazon",    service: "oxylabs",   structured: true,  provides: ["price", "images", "video", "title", "description", "bullets", "category", "attributes", "variations", "ingredients", "upc", "brand", "model", "reviews"], creditCost: null, firstParty: "clean", note: "amazon_product = RICHEST: 8-img gallery + videos(flag) + bullets + desc + category + product_details(brand/model/dimensions/UPC) + variations + TEXT ingredients + reviews + 1P/3P buybox. Missing only: structured nutrition + A+ enhanced imagery (A+ = we GENERATE)." },
  "oxylabs:google":    { key: "oxylabs:google",    service: "oxylabs",   structured: true,  provides: ["price"], creditCost: null, firstParty: "mixed", note: "google_shopping_search: cross-retailer price, MIX of 1P + 3P resellers in one feed. Last resort; take first-party merchant only." },
  "unwrangle:walmart": { key: "unwrangle:walmart", service: "unwrangle", structured: true,  provides: ["price", "images", "nutrition", "ingredients", "upc", "description"], creditCost: 2.5, firstParty: "clean", note: "walmart_detail = richest grocery content: structured nutrition_facts + ingredients + UPC + all photos + desc + 1P seller. THE Walmart content source." },
  "unwrangle:target":  { key: "unwrangle:target",  service: "unwrangle", structured: true,  provides: ["price", "images", "upc", "description"], creditCost: 1, firstParty: "clean", note: "target_detail: price + full gallery + desc + highlights + UPC + brand. No nutrition/ingredients. Only structured Target path." },
  "unwrangle:samsclub":{ key: "unwrangle:samsclub",service: "unwrangle", structured: true,  provides: ["price", "images", "ingredients", "upc", "description"], creditCost: 10, firstParty: "clean", note: "samsclub_detail: 10 CREDITS (expensive) — price+images+desc+UPC+gtin+ingredients(in specs). Use sparingly." },
  "unwrangle:costco":  { key: "unwrangle:costco",  service: "unwrangle", structured: true,  provides: ["images", "upc", "description"], creditCost: 10, firstParty: "clean", note: "costco_detail: 10 CREDITS — images+desc+UPC. Price OFTEN MISSING (member-only). Use sparingly." },
  "unwrangle:amazon":  { key: "unwrangle:amazon",  service: "unwrangle", structured: true,  provides: ["price", "images", "description"], creditCost: 1, firstParty: "mixed", note: "NOT wired (Oxylabs amazon is better+already-paid). amazon_detail=1cr. Only if Oxylabs Amazon unavailable." },
  "openclaw:publix":   { key: "openclaw:publix",   service: "openclaw",  structured: true,  provides: ["price", "images"], creditCost: null, firstParty: "gated", note: "Logged-in browser on the box — the ONLY path to Publix shelf price (SPA + store-select, no paid API). Main image only." },
  "openclaw:aldi":     { key: "openclaw:aldi",     service: "openclaw",  structured: true,  provides: ["price", "images"], creditCost: null, firstParty: "gated", note: "Browser — only path to Aldi Clearwater. Main image only." },
  "openclaw:bjs":      { key: "openclaw:bjs",      service: "openclaw",  structured: true,  provides: ["price", "images"], creditCost: null, firstParty: "gated", note: "Browser — only path to BJ's (club-gated). Main image only." },
};

export interface RetailerRouting {
  retailer: string;
  /** Price sources in cheapest-first tier order. Engine stops at the first hit. */
  price: SourceKey[];
  /** Content sources (photos/nutrition/ingredients/UPC), best-first. Fetch ONCE per product. */
  content: SourceKey[];
  note: string;
}

// Per-retailer routing. Order matters = escalation tiers. The engine consults this
// instead of fanning out to every service.
export const RETAILER_ROUTING: RetailerRouting[] = [
  { retailer: "walmart", price: ["oxylabs:walmart"], content: ["unwrangle:walmart", "oxylabs:walmart"], note: "Price+photos from Oxylabs (free-ish). Unwrangle detail ONLY when we need UPC/structured nutrition — once per product." },
  { retailer: "amazon",  price: ["oxylabs:amazon"],  content: ["oxylabs:amazon"], note: "FULLY covered by Oxylabs (price+photos+UPC+ingredients). No Unwrangle." },
  { retailer: "target",  price: ["unwrangle:target"], content: ["unwrangle:target"], note: "Unwrangle only (no Oxylabs parser). 1 credit." },
  { retailer: "samsclub",price: ["unwrangle:samsclub"], content: ["unwrangle:samsclub"], note: "Unwrangle, 10cr — expensive, use only when the item is Sam's-specific." },
  { retailer: "costco",  price: ["unwrangle:costco"], content: ["unwrangle:costco"], note: "Unwrangle, 10cr, price often missing. Use last." },
  { retailer: "publix",  price: ["openclaw:publix"], content: ["openclaw:publix"], note: "Browser ONLY — no paid API. Big FL grocer, worth it for buy-zone truth." },
  { retailer: "aldi",    price: ["openclaw:aldi"],   content: ["openclaw:aldi"], note: "Browser ONLY." },
  { retailer: "bjs",     price: ["openclaw:bjs"],    content: ["openclaw:bjs"], note: "Browser ONLY." },
  { retailer: "google",  price: ["oxylabs:google"],  content: [], note: "LAST-RESORT price estimate. First-party merchant only, flag as estimate." },
];

/** The cheapest-first escalation order for PRICING one of OUR listings, by channel.
 *  Walmart-first-stop-on-hit for the common case; Google is the final estimate. */
export const PRICE_TIERS: SourceKey[] = [
  "oxylabs:walmart", // tier 1 — cheapest & covers most (buy zone shops mostly = Walmart)
  "unwrangle:target", // tier 2 — Walmart miss, Target is next-cheapest structured
  "openclaw:publix", "openclaw:aldi", "openclaw:bjs", // tier 3 — local grocers, browser-only
  "unwrangle:samsclub", "unwrangle:costco", // tier 4 — club stores (expensive credits)
  "oxylabs:google", // tier 5 — last-resort estimate (first-party only)
];

export function routingFor(retailer: string): RetailerRouting | undefined {
  return RETAILER_ROUTING.find((r) => r.retailer === retailer.toLowerCase());
}

// ── FREE content sources that FILL the gaps (attributes / graphics / nutrition) ──
// The paid retailer APIs give gallery+attributes+variations, but for the FULL scope
// (all graphics + every attribute + structured nutrition) we layer FREE sources on
// top — cheaper and often richer for grocery. See reference_sourcing_strategy_2026-07.
export const FREE_ENRICHMENT_SOURCES = [
  { key: "openfoodfacts", for: ["nutrition", "ingredients", "allergens", "attributes", "images", "brand", "category"] as DataField[],
    note: "Open Food Facts — free open DB by UPC/barcode: structured nutrition + ingredients + allergens + food attributes + product images. Fills the grocery nutrition/attribute gap the paid APIs leave. ADOPT." },
  { key: "google-cse", for: ["images"] as DataField[],
    note: "Google Programmable Search (CSE) — free image/content DISCOVERY (find more product photos across the web). Old-client keys live to 2027." },
  { key: "gemini-vision", for: ["attributes", "nutrition", "ingredients"] as DataField[],
    note: "Gemini Flash vision (free lane) — EXTRACT attributes/nutrition/ingredients from label images (e.g. Walmart's nutrition-facts-label-image → structured text). Also a 3rd vision lane for identify." },
] as const;

// A+/Enhanced brand-content imagery is GENERATED, not harvested:
//   Amazon A+ → project_aplus_content_factory ; Bundle Factory image-gen (Codex, $0).
export const APLUS_IS_GENERATED = true;
