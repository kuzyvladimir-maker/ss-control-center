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

export type DataField = "price" | "images" | "nutrition" | "ingredients" | "upc" | "description";

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
  "oxylabs:walmart":   { key: "oxylabs:walmart",   service: "oxylabs",   structured: true,  provides: ["price", "images", "description"], creditCost: null, firstParty: "clean", note: "walmart_search=1P price+main img; walmart_product=price+7img gallery+desc+specs. NO UPC, nutrition/ingredients only as label-image URLs." },
  "oxylabs:amazon":    { key: "oxylabs:amazon",    service: "oxylabs",   structured: true,  provides: ["price", "images", "ingredients", "upc", "description"], creditCost: null, firstParty: "clean", note: "amazon_product = COMPLETE: 8-img gallery + bullets + desc + UPC + TEXT ingredients + buybox 1P/3P. No structured nutrition. Amazon needs nothing else." },
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
