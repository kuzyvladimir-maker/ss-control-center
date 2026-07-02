// Product Sourcing Engine — Stage B fetchers (LIVE IN OUR PROJECT).
// Given a brain-resolved canonical product (Stage A), fetch the base-unit shelf
// price + content + images from multiple retailers, normalize to one shape, and
// run the verification gates that keep our own/reseller multipack listings out of
// COGS. The orchestrator stores every accepted offer (multi-offer per SKU) and
// picks the cheapest clean base unit as the procurement source.
//
// Services (accounts on info@salutem.solutions, keys in .env.local):
//   - BlueCart (Traject Data)  → Walmart.com, exposes is_marketplace_item (1P flag)
//   - Unwrangle                → Target / Sam's / Costco (+ Walmart, but no 1P filter)
// Oxylabs+Instacart (Publix/BJ's/ALDI) is a separate scrape path, added later.

export type RetailOffer = {
  retailer: string; // walmart | target | samsclub | costco | ...
  retailerProductId: string;
  price: number | null;
  currency: string;
  inStock: boolean | null;
  productUrl: string | null;
  title: string | null;
  description: string | null;
  keyFeatures: string[];
  imageUrls: string[];
  packSizeSeen: number | null;
  isMarketplaceItem: boolean | null; // true = 3P/reseller (incl. our own); false = first-party
  sellerName: string | null;
  sourceApi: string; // bluecart | unwrangle | oxylabs
  via?: "direct" | "instacart"; // instacart prices are inflated → de-marked-up downstream
};

// Canonical product the brain produced (subset we need here).
export type CanonicalProduct = {
  brand?: string;
  product_line?: string;
  flavor?: string;
  size?: string;
  retail_search_query?: string;
  base_unit?: string;
};

// Our own storefronts + the resellers we've seen polluting search — never a COGS source.
const OWN_OR_RESELLER = [
  "starfitstore", "salutem", "minixpress", "brit commerce", "harris online",
  "blueline", "deals", "trading", "wholesale", "marketplace",
];

export function isOwnOrReseller(seller?: string | null): boolean {
  if (!seller) return false;
  const s = seller.toLowerCase();
  return OWN_OR_RESELLER.some((b) => s.includes(b));
}

// FIRST-PARTY ONLY (Vladimir's rule #8): on a retailer's own marketplace we buy
// ONLY from the retailer itself, never third-party resellers — their prices are
// inflated and are not our procurement source. BlueCart exposes is_marketplace_item
// per offer; we trust that flag first, then fall back to the seller name. Anything
// not provably first-party is rejected (better a miss than a wrong/reseller cost).
export function isFirstParty(offer: { isMarketplaceItem: boolean | null; sellerName: string | null; retailer: string }): boolean {
  if (offer.isMarketplaceItem === true) return false; // explicit third-party/reseller
  if (offer.isMarketplaceItem === false) return true; // explicit first-party
  // Flag unknown → accept only when the seller name IS the retailer itself.
  const s = (offer.sellerName || "").toLowerCase().replace(/\s+/g, "");
  if (!s) return false; // unknown seller + unknown flag → not provably 1P
  return (
    s.startsWith(offer.retailer.toLowerCase()) ||
    s.includes("walmart.com") ||
    s.includes("samsclub") ||
    s.includes("target.com")
  );
}

// Parse a pack/multipack count out of a title. Returns 1 when nothing multipack-y is found.
export function extractPackSize(title?: string | null): number {
  if (!title) return 1;
  const t = title.toLowerCase();
  // Only MULTI-PACKAGE markers divide the price. "N count"/"N ct" denote pieces
  // INSIDE one retail package (12-count tortilla bag, 10-count Uncrustables box) —
  // that package IS the base unit, so they must NOT divide (fixes La Abuela $0.26).
  const pats = [
    /pack of\s*(\d+)/, /(\d+)\s*[- ]?pack\b/, /(\d+)\s*[- ]?pk\b/, /case of\s*(\d+)/,
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (m) { const n = parseInt(m[1], 10); if (n > 1 && n <= 96) return n; }
  }
  return 1;
}

// Rough per-category price sanity bands (single base unit), USD. Outside → flag suspect.
const SANITY: Record<string, [number, number]> = {
  bread: [1.5, 9], loaf: [1.5, 9], tortilla: [1.5, 8],
  soup: [1, 5], can: [0.6, 4.5], ramen: [0.5, 3], cup: [0.5, 3],
  default: [0.4, 40],
};
export function priceSuspect(price: number | null, hint?: string): boolean {
  if (price === null) return false;
  const key = Object.keys(SANITY).find((k) => k !== "default" && (hint || "").toLowerCase().includes(k));
  const [lo, hi] = SANITY[key || "default"];
  return price < lo || price > hi;
}

// Token gate: candidate title must carry the brand (and flavor/line if the brain gave one),
// and must not be a *different* named brand. Cheap deterministic guard for the 4 misses.
export function tokenGate(
  offerTitle: string | null,
  cp: CanonicalProduct
): { ok: boolean; reason: string } {
  const t = (offerTitle || "").toLowerCase();
  if (!t) return { ok: false, reason: "no title" };
  const need: string[] = [];
  if (cp.brand) need.push(...cp.brand.toLowerCase().split(/\s+/).slice(0, 2));
  // distinctive flavor/line words (drop generic filler)
  const filler = new Set(["the", "and", "with", "bread", "soup", "classics", "variety", "original", "&"]);
  for (const src of [cp.product_line, cp.flavor]) {
    if (!src) continue;
    for (const w of src.toLowerCase().split(/\s+/)) if (w.length > 2 && !filler.has(w)) need.push(w);
  }
  const missing = need.filter((w) => !t.includes(w));
  // allow one miss (titles abbreviate), but brand word must be present
  const brandWord = cp.brand?.toLowerCase().split(/\s+/)[0];
  if (brandWord && !t.includes(brandWord)) return { ok: false, reason: `brand "${brandWord}" absent` };
  if (missing.length > Math.max(1, Math.floor(need.length / 2)))
    return { ok: false, reason: `missing tokens: ${missing.join(",")}` };
  return { ok: true, reason: "ok" };
}

// Dedup image URLs (BlueCart often returns main_image === images[0], which showed
// up as "two identical photos" on un-harvested rows). Keeps first-seen order.
function dedupImages(arr: (string | null | undefined)[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const u of arr) { if (typeof u === "string" && u.startsWith("http") && !seen.has(u)) { seen.add(u); out.push(u); } }
  return out;
}

async function getJson(url: string, timeoutMs = 20000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let r: Response;
  try {
    r = await fetch(url, { signal: ctrl.signal });
  } catch (e: any) {
    if (e.name === "AbortError") throw new Error(`timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* leave null */ }
  if (!r.ok) {
    const msg = j?.message || j?.error || text.slice(0, 120);
    const err: any = new Error(`HTTP ${r.status}: ${msg}`);
    err.status = r.status; err.body = j;
    throw err;
  }
  return j;
}

// --- BlueCart (Walmart.com) ---------------------------------------------------
export async function bluecartWalmartSearch(
  query: string
): Promise<{ creditsRemaining: number | null; offers: RetailOffer[]; trialExhausted: boolean }> {
  const key = process.env.BLUECART_API_KEY;
  if (!key) throw new Error("BLUECART_API_KEY missing");
  const url = `https://api.bluecartapi.com/request?api_key=${key}&type=search&search_term=${encodeURIComponent(query)}&walmart_domain=walmart.com`;
  let j: any;
  try {
    j = await getJson(url);
  } catch (e: any) {
    if (e.status === 401 || e.status === 402 || /credit|quota|limit/i.test(e.message))
      return { creditsRemaining: 0, offers: [], trialExhausted: true };
    throw e;
  }
  const offers: RetailOffer[] = (j.search_results || []).map((x: any) => {
    const p = x.product || {};
    const o = x.offers?.primary || x.offers || {};
    return {
      retailer: "walmart",
      retailerProductId: String(p.item_id ?? p.us_item_id ?? ""),
      price: o.price ?? null,
      currency: o.currency || "USD",
      inStock: x.inventory?.in_stock ?? null,
      productUrl: p.link ?? null,
      title: p.title ?? null,
      description: p.description ?? null,
      keyFeatures: Array.isArray(p.feature_bullets) ? p.feature_bullets : [],
      imageUrls: dedupImages([p.main_image, ...(p.images || [])]),
      packSizeSeen: extractPackSize(p.title),
      isMarketplaceItem: x.offers?.is_marketplace_item ?? null,
      sellerName: o.seller?.name ?? x.seller?.name ?? null,
      sourceApi: "bluecart",
    } as RetailOffer;
  });
  return { creditsRemaining: j.request_info?.credits_remaining ?? null, offers, trialExhausted: false };
}

// --- Unwrangle (Target / Sam's / Costco / Walmart) ----------------------------
const UNWRANGLE_PLATFORM: Record<string, string> = {
  target: "target_search", samsclub: "samsclub_search", costco: "costco_search", walmart: "walmart_search",
};
export async function unwrangleSearch(
  retailer: "target" | "samsclub" | "costco" | "walmart",
  query: string
): Promise<{ creditsRemaining: number | null; offers: RetailOffer[]; trialExhausted: boolean }> {
  const key = process.env.UNWRANGLE_API_KEY;
  if (!key) throw new Error("UNWRANGLE_API_KEY missing");
  const platform = UNWRANGLE_PLATFORM[retailer];
  const url = `https://data.unwrangle.com/api/getter/?platform=${platform}&search=${encodeURIComponent(query)}&api_key=${key}`;
  let j: any;
  try {
    // Unwrangle search routinely takes 30-60s (it scrapes live), so the default
    // 20s cap was ABORTING every call → the enrichment thought "no product found"
    // when the request simply hadn't returned yet (root cause of the 2026-07-01
    // "Unwrangle finds nothing" symptom). Give it a real 90s budget.
    j = await getJson(url, 90000);
  } catch (e: any) {
    if (e.status === 401 || e.status === 402 || /credit|quota|limit|insufficient/i.test(e.message))
      return { creditsRemaining: 0, offers: [], trialExhausted: true };
    throw e;
  }
  if (j && j.success === false && /credit|quota|limit/i.test(JSON.stringify(j)))
    return { creditsRemaining: j.remaining_credits ?? 0, offers: [], trialExhausted: true };
  // Unwrangle returns its array under `results` (not `products`), HTML-encodes
  // names (Bush&#39;s), and uses per-platform field names. Decode + normalize.
  const decode = (s: string | null): string | null =>
    s == null ? null : s
      .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&quot;|&#34;/g, '"')
      .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d)).trim();
  const offers: RetailOffer[] = (j.results || j.products || []).map((x: any) => {
    const title = decode(x.name || x.title || null);
    const imgs: string[] = dedupImages(
      (Array.isArray(x.images) && x.images.length ? x.images : [x.image_url, x.thumbnail, x.main_image])
    );
    // Target/Sam's/Costco results ARE that retailer's own catalog → first-party.
    // Walmart-via-Unwrangle: judge by seller_name (3P if a non-Walmart seller).
    const isMkt: boolean | null = retailer === "walmart"
      ? (x.seller_name ? !/^walmart/i.test(x.seller_name) : null)
      : false;
    return {
      retailer,
      retailerProductId: String(x.id ?? x.item_id ?? x.url ?? ""),
      price: x.price ?? x.min_price ?? null,
      currency: x.currency || "USD",
      inStock: x.in_stock ?? null,
      productUrl: x.url || x.link || null,
      title,
      description: decode(x.description ?? null),
      keyFeatures: Array.isArray(x.features) ? x.features : [],
      imageUrls: imgs,
      packSizeSeen: extractPackSize(title),
      isMarketplaceItem: isMkt,
      sellerName: x.seller_name ?? (retailer === "walmart" ? null : retailer),
      sourceApi: "unwrangle",
    } as RetailOffer;
  });
  return { creditsRemaining: j.remaining_credits ?? null, offers, trialExhausted: false };
}

// Score one offer against the canonical product. Returns the offer annotated with
// gate verdicts; the orchestrator decides which to keep as the COGS source.
export type ScoredOffer = RetailOffer & {
  accepted: boolean;
  rejectReason: string | null;
  isBaseUnit: boolean;
};
export function scoreOffer(offer: RetailOffer, cp: CanonicalProduct): ScoredOffer {
  const base = { ...offer, accepted: false, rejectReason: null as string | null, isBaseUnit: false };
  if (isOwnOrReseller(offer.sellerName)) return { ...base, rejectReason: `own/reseller (${offer.sellerName})` };
  if (!isFirstParty(offer)) return { ...base, rejectReason: `not first-party (${offer.sellerName || "unknown seller"})` };
  const tg = tokenGate(offer.title, cp);
  if (!tg.ok) return { ...base, rejectReason: tg.reason };
  if (offer.price === null) return { ...base, rejectReason: "no price" };
  const isBase = (offer.packSizeSeen ?? 1) === 1;
  if (priceSuspect(offer.price, `${offer.title} ${cp.base_unit || ""}`))
    return { ...base, isBaseUnit: isBase, rejectReason: `price suspect ($${offer.price})` };
  return { ...base, accepted: true, rejectReason: null, isBaseUnit: isBase };
}
