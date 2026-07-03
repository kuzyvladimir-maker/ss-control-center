// Reference Catalog (Donor DB) enrichment core. Turns retailer SEARCH results into
// product-centric DonorProduct rows (one real product = one row, deduped by a
// normalized identityKey) + per-retailer DonorOffer rows. Reuses the retail-fetch
// gates (first-party only, brand token, price sanity) so only clean, real offers
// land. The cheapest CLEAN first-party DIRECT offer rolls up to DonorProduct.bestPrice.
// See docs/wiki/reference-catalog-engine.md.

import type { Client } from "@libsql/client";
import crypto from "crypto";
import {
  bluecartWalmartSearch,
  unwrangleSearch,
  scoreOffer,
  type CanonicalProduct,
  type ScoredOffer,
} from "./retail-fetch";
import { oxylabsSearch, oxylabsWalmartSearch, oxylabsEnabled, type OxylabsRetailer } from "./oxylabs-fetch";
import { openClawSearch, openClawEnabled, type OpenClawRetailer } from "./openclaw-fetch";
import { CLAUDE } from "@/lib/ai-models";

// Parse a size token out of a title → normalized measure + amount (for $/measure).
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(fl\s*oz|oz|ct|count|lb|g|ml|l)\b/i;
export function parseSize(title?: string | null): { size: string | null; unitMeasure: string | null; unitAmount: number | null } {
  if (!title) return { size: null, unitMeasure: null, unitAmount: null };
  const m = title.match(UNIT_RE);
  if (!m) return { size: null, unitMeasure: null, unitAmount: null };
  const amount = parseFloat(m[1]);
  let unit = m[2].toLowerCase().replace(/\s+/g, "");
  if (unit === "count") unit = "ct";
  return { size: `${m[1]} ${m[2]}`.replace(/\s+/g, " "), unitMeasure: unit, unitAmount: isFinite(amount) ? amount : null };
}

const norm = (s?: string | null) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Dedup key so the SAME real product collapses to one DonorProduct across retailers:
// brand + distinctive title words + size token. (UPC join is a later upgrade.)
export function computeIdentityKey(o: { brand?: string | null; title?: string | null; size?: string | null }): string {
  const brand = norm(o.brand);
  const title = norm(o.title);
  const sz = o.size ? norm(o.size) : norm(parseSize(o.title).size);
  const stop = new Set(["the", "and", "with", "of", "for", "an", "pack", "count", "ct", "oz", "fl", "lb", "each", "value", "size", "family", "great", "new"]);
  const brandWords = new Set(brand.split(" "));
  const words = title.split(" ").filter((w) => w.length > 2 && !stop.has(w) && !brandWords.has(w) && !/^\d+$/.test(w)).slice(0, 6);
  return [brand, ...words, sz].filter(Boolean).join("|") || title.slice(0, 60);
}

// Real MULTI-WORD grocery brands. First-token derivation truncates these
// ("Green Giant" → "Green", "Del Monte" → "Del"), which split one brand across
// two facets and read wrong in the UI. Longest match wins so "La Tortilla
// Factory" beats "La Banderita". Curated (verified against catalog titles) — a
// dictionary is reliable where a frequency heuristic isn't (it wrongly collapses
// "Campbell's Condensed" / "Cheetos Crunchy", where word 2 is a product variety).
export const KNOWN_MULTIWORD_BRANDS = [
  "Dave's Killer Bread", "La Tortilla Factory", "La Banderita", "Del Monte",
  "Coffee Mate", "Hidden Valley", "Pepperidge Farm", "Green Giant", "Chef Boyardee",
  "Sara Lee", "Nature's Own", "Minute Maid", "Snack Factory", "Hamburger Helper",
  "Vita Coco", "Good Thins", "Cape Cod", "Glory Foods", "Stove Top", "Cocoa Classics",
  "Margaret Holmes", "Le Sueur", "College Inn", "Great Value", "Stephen's Gourmet",
  "Jimmy Dean", "Hot Pockets", "Mrs. Smith's", "Marie Callender's",
];
const BRANDS_BY_LEN = [...KNOWN_MULTIWORD_BRANDS].sort((a, b) => b.length - a.length);

// Return the canonical multi-word brand a title leads with, else null.
export function canonicalMultiwordBrand(title?: string | null): string | null {
  if (!title) return null;
  const t = title.trim().toLowerCase();
  for (const b of BRANDS_BY_LEN) {
    const bl = b.toLowerCase();
    if (t === bl || t.startsWith(bl + " ") || t.startsWith(bl + ",")) return b;
  }
  return null;
}

// Brand derived from the OFFER's OWN title (stable regardless of which search
// query surfaced it). Using the job's target as brand made the same real item
// dedup differently per query ("Maruchan" vs "Maruchan Instant") → duplicates +
// orphaned offers. Known multi-word brand first, else the first title token.
export function deriveBrand(title?: string | null): string | null {
  if (!title) return null;
  const known = canonicalMultiwordBrand(title);
  if (known) return known;
  const t = title.trim()
    .replace(/^\(?\s*\d+\s*(?:-|\s)?\s*(?:pack|pk|count|ct)\s*\)?\s*/i, "") // strip "(4 pack) "
    .replace(/^\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|lb|ct|count|g|ml|l)\b\s*/i, ""); // strip "3.25 oz "
  const w = t.split(/\s+/)[0]?.replace(/[^A-Za-z0-9'&.-]/g, "");
  return w && w.length >= 2 && !/^\d+$/.test(w) ? w : null;
}

// Prefer the (clean) searched brand for display/identity; reject junk like
// "(4 pack)" or a bare number that the title sometimes leads with.
function cleanBrand(b?: string | null): string | null {
  const s = (b || "").trim();
  if (!s || /^\(?\d/.test(s) || /^pack\b/i.test(s)) return null;
  return s;
}

// Normalize brand CASING so a vector typed "uncrustables" and "Uncrustables" don't
// become two brands. Only fixes all-lowercase input (→ Title Case); leaves
// deliberate ALLCAPS / mixed-case brands (BODYARMOR, OREO, SKIPPY, Cheez-It) alone.
export function normalizeBrandCase(b?: string | null): string | null {
  if (!b) return b ?? null;
  const s = b.trim();
  if (!s) return null;
  if (s === s.toLowerCase()) return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return s;
}

// ── Temperature classification (Frozen | Dry) ───────────────────────────────
// TWO operational buckets. "Frozen" = anything that needs a COLD CHAIN — natively
// frozen items AND refrigerated/perishable ones (raw/fresh meat, poultry, seafood,
// fresh sausage, bacon, deli, fresh dairy, eggs, refrigerated dough) — because we
// FREEZE and ship them with ice (Vladimir's rule: chilled ≡ frozen for us). "Dry"
// = shelf-stable / ambient. Stored on DonorProduct.category. The deterministic
// version below is the fast fallback; classifyTemperatureLLM is the accurate path
// (regex can't tell raw "sausage roll" from shelf-stable "Vienna sausage").
export type Temperature = "Frozen" | "Dry";

// Perishable product types that ship cold even when the title doesn't say "frozen".
const PERISHABLE_RE = /\b(sausage roll|breakfast sausage|pork sausage|italian sausage|ground (beef|pork|turkey|chicken)|raw |fresh |deli |lunch ?meat|cold cuts|sliced (ham|turkey|chicken|beef)|hot ?dog|bratwurst|bacon|fresh mozzarella|biscuit dough|cookie dough|pie crust|tofu|eggs?\b)/i;
const COLD_AISLE_RE = /\b(frozen|refrigerated|deli|fresh meat|meat & seafood|seafood|dairy)\b/i;
// Shelf-stable markers that override a perishable-looking name (canned corn, bread,
// vacuum-packed, jarred) — these ship DRY regardless of contents.
const SHELF_STABLE_RE = /\b(canned|can|jarred|jar|vacuum|pouch|bottle|bread|buns?|rolls?|bagels?|tortillas?|loaf|crackers?|chips?|cereal)\b/i;

// Warehouse / membership clubs. Their native bulk pack (12-count box, #10 can) is a
// legitimate purchase unit and a real sourcing lever — we keep it whole rather than
// rejecting it as a multipack, and don't divide its price (the pack IS the unit;
// cross-size comparison happens via $/measure).
const CLUB_RETAILERS = new Set(["costco", "samsclub", "bjs", "restaurantdepot"]);

// Instacart prices carry a delivery markup (~15%). When an offer is sourced via
// Instacart we store the RAW price in `price` but the de-marked-up ESTIMATE in
// `pricePerUnit` (flagged via="instacart"), so the rolled-up "real" cost approximates
// the in-store shelf price. Calibrate per-retailer later from dual-priced products.
const INSTACART_MARKUP = 1.15;

export function classifyTemperature(parts: {
  title?: string | null; bullets?: string[] | null; description?: string | null; retailerCats?: string[] | null;
}): Temperature {
  const title = (parts.title || "").toLowerCase();
  const cats = (parts.retailerCats || []).join(" ").toLowerCase();
  const instr = [title, cats, ...(parts.bullets || []), parts.description].filter(Boolean).join(" \n ").toLowerCase();

  // Natively frozen: word in TITLE / frozen aisle / unmistakable item / keep-frozen.
  if (/\bfrozen\b/.test(title) || /\bfrozen\b/.test(cats)
    || /\b(ice cream|gelato|sherbet|sorbet|popsicle|ice pop|freeze pop)\b/.test(title)
    || /frozen (pizza|vegetabl|fruit|meal|dinner|entr|waffle|breakfast|novelt|treat|yogurt|dessert)/.test(title)
    || /keep\s+frozen|store\s+frozen|keep at 0\s*°?\s*f\b/.test(instr))
    return "Frozen";
  // Canned / jarred / vacuum / bread → shelf-stable, even if the contents (corn,
  // tuna) would otherwise be perishable. Overrides the perishable check below.
  if (SHELF_STABLE_RE.test(title)) return "Dry";
  // Refrigerated / perishable → also Frozen for us (we ship it frozen with ice).
  if (COLD_AISLE_RE.test(cats) || PERISHABLE_RE.test(title)) return "Frozen";
  // A real "keep refrigerated" requirement (exclude "...after opening / for best
  // taste / for freshness", which marks shelf-stable items like ketchup or UHT juice).
  if (/(keep|must be (kept )?|sold)\s+refrigerated(?!\s+(after|once|when|upon|for))/.test(instr)) return "Frozen";
  return "Dry";
}

// LLM temperature classifier — batched Haiku with the cold-chain rule baked in.
// Applies food knowledge the regex can't (raw sausage = cold, canned Vienna
// sausage = dry). Fail-OPEN to the deterministic classifier so a hiccup never
// blanks a run. Returns one verdict per input, in order.
export async function classifyTemperatureLLM(items: { title?: string | null; category?: string | null; bullets?: string[] | null }[]): Promise<Temperature[]> {
  const fallback = () => items.map((it) => classifyTemperature({ title: it.title, bullets: it.bullets, retailerCats: it.category ? [it.category] : null }));
  if (!items.length) return [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "<api_key>") return fallback();
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });
    const list = items.map((it, i) => `${i}. ${(it.title || "").slice(0, 150)}${it.category ? ` [aisle: ${it.category}]` : ""}`).join("\n");
    const res = await client.messages.create({
      model: CLAUDE.cheap,
      max_tokens: 3500,
      messages: [{ role: "user", content:
        `Classify each grocery product as FROZEN or DRY for a fulfillment operation that FREEZES and ships cold items with ice. Decide by HOW THE STORE SELLS IT: from a freezer/refrigerator → FROZEN; from a shelf at room temperature → DRY.\n` +
        `FROZEN = sold cold (freezer or fridge): natively frozen foods; raw or fresh meat, poultry, seafood; fresh/raw sausage, bacon, hot dogs, deli & lunch meats; fresh dairy (milk, yogurt, fresh cheese), eggs, butter; refrigerated dough/biscuits; tofu; FRESH (refrigerated) pasta.\n` +
        `DRY = shelf-stable / ambient, even if the contents would otherwise be perishable: ANY canned, jarred, vacuum-packed, pouched, or boxed shelf-stable item (e.g. canned/vacuum corn, canned tuna, Vienna sausage, boxed shelf tortellini); ALL bread, buns, rolls, bagels, tortillas and bakery loaves; chips, crackers, snacks; dry pasta & rice; condiments & jarred sauces; drinks; candy; baking; coffee; cereal.\n` +
        `Key rule: canned/jarred/vacuum/pouched = DRY regardless of contents. Bread & bakery = DRY. Only mark FROZEN when the item genuinely lives in a freezer or refrigerator case.\n` +
        `If unsure, lean DRY.\n` +
        `Return ONLY a JSON array [{"i":0,"frozen":true},...] covering EVERY item.\n\n${list}` }],
    });
    const tb = res.content.find((b: any) => b.type === "text") as any;
    const m = tb?.text?.match(/\[[\s\S]*\]/);
    if (!m) return fallback();
    const arr = JSON.parse(m[0]) as { i: number; frozen: boolean }[];
    const out = fallback(); // deterministic default, LLM overrides per index
    for (const v of arr) if (typeof v.i === "number" && v.i >= 0 && v.i < items.length) out[v.i] = v.frozen ? "Frozen" : "Dry";
    return out;
  } catch { return fallback(); }
}

// ── QA "qualification department" ──────────────────────────────────────────
// tier-1 (free): obvious non-grocery markers — books/media/household/HBA.
const NON_GROCERY = /\b(paperback|hardcover|board book|audiobook|kindle|notebook|diary|journal|vol\.?\s*\d|batteries?|d cell|in-wash|scent booster|detergent|fabric softener|laundry|dish soap|shampoo|conditioner|toothpaste|deodorant|paper towels?|toilet paper|napkins?|trash bags?|light bulb|recollections)\b/i;
export function looksNonGrocery(title?: string | null): boolean {
  return !!title && NON_GROCERY.test(title);
}

// tier-2 (cheap): one batched Haiku call classifies many titles grocery/not.
// Fail-OPEN (all true) if the LLM is unavailable so a hiccup never wipes a run —
// tier-1 + the first-party/brand/price gates still apply.
export async function classifyGroceryTitles(titles: string[]): Promise<boolean[]> {
  if (!titles.length) return [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "<api_key>") return titles.map(() => true);
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });
    const list = titles.map((t, i) => `${i}. ${(t || "").slice(0, 140)}`).join("\n");
    const res = await client.messages.create({
      model: CLAUDE.cheap,
      max_tokens: 3000,
      messages: [{ role: "user", content:
        `You are a grocery-catalog QA filter. For EACH numbered title decide if it is a GROCERY product — food, beverage, or edible consumable sold in a supermarket. Answer false for books, media, batteries, cleaning/laundry, health & beauty, toys, electronics, apparel, kitchenware, office, pet non-food.\nReturn ONLY a JSON array: [{"i":0,"food":true},...] covering every item.\n\n${list}` }],
    });
    const tb = res.content.find((b: any) => b.type === "text") as any;
    const m = tb?.text?.match(/\[[\s\S]*\]/);
    if (!m) return titles.map(() => true);
    const arr = JSON.parse(m[0]) as { i: number; food: boolean }[];
    const verdict = titles.map(() => true);
    for (const v of arr) if (typeof v.i === "number" && v.i >= 0 && v.i < titles.length) verdict[v.i] = v.food !== false;
    return verdict;
  } catch { return titles.map(() => true); }
}

// Remove products left with zero offers (legacy duplicate artifacts from the old
// query-derived identityKey). Safe to call anytime.
export async function cleanupOrphans(db: Client): Promise<number> {
  const r = await db.execute(`DELETE FROM "DonorProduct" WHERE id NOT IN (SELECT DISTINCT donorProductId FROM "DonorOffer" WHERE donorProductId IS NOT NULL)`);
  return r.rowsAffected || 0;
}

// Collapse redundant SAME-retailer offers on one product. Unwrangle's search can
// return two Walmart listings (different us_item_ids) for the same item, which
// showed up as a "doubled" offer. We only keep first-party offers, so duplicates
// from one retailer are genuinely the same product — keep the best (in-stock,
// then cheapest per-unit, then one with a URL) and drop the rest.
export async function dedupeOffersPerRetailer(db: Client): Promise<number> {
  const dups = await db.execute(`SELECT donorProductId, retailer FROM "DonorOffer" GROUP BY donorProductId, retailer HAVING COUNT(*) > 1`);
  let removed = 0;
  for (const d of dups.rows as any[]) {
    const offs = await db.execute({ sql: `SELECT id, pricePerUnit, inStock, productUrl FROM "DonorOffer" WHERE donorProductId=? AND retailer=?`, args: [d.donorProductId, d.retailer] });
    const list = (offs.rows as any[]).slice().sort((a, b) => {
      const ia = a.inStock === 0 ? 1 : 0, ib = b.inStock === 0 ? 1 : 0; if (ia !== ib) return ia - ib;
      const pa = a.pricePerUnit ?? Infinity, pb = b.pricePerUnit ?? Infinity; if (pa !== pb) return pa - pb;
      return (a.productUrl ? 0 : 1) - (b.productUrl ? 0 : 1);
    });
    for (const extra of list.slice(1)) { await db.execute({ sql: `DELETE FROM "DonorOffer" WHERE id=?`, args: [extra.id] }); removed++; }
  }
  return removed;
}

const stripHtml = (s?: string | null) => (s ? String(s).replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : null);

export interface HarvestResult { ok: boolean; productId: string; images: number; upc: string | null; hasIngredients: boolean; merged: number; imageFlagged?: boolean; reason?: string }

interface DetailContent { images: string[]; bullets: string[]; description: string | null; ingredients: string | null; specifications: any[] | null; upc: string | null; category: string | null; categories: string[]; source: string }

function normImages(arr: any): string[] {
  const raw = (Array.isArray(arr) ? arr : []).map((x: any) => (typeof x === "string" ? x : x?.url || x?.link)).filter((u: any) => typeof u === "string" && u.startsWith("http"));
  const seen = new Set<string>(); const out: string[] = [];
  for (const u of raw) { if (!seen.has(u)) { seen.add(u); out.push(u); } }
  return out;
}
function parseIngredients(ing: any): string | null {
  if (!ing) return null;
  if (typeof ing === "string") return ing.trim() || null;
  if (typeof ing === "object") { const vals = Object.values(ing).map((v: any) => (v && typeof v === "object" ? v.value : v)).filter((x: any) => typeof x === "string" && x.trim()); return vals.length ? vals.join(" | ") : null; }
  return null;
}

// Unwrangle product detail — RICHER than BlueCart and on our 100k-credit plan
// (~2.5 credits/call). Works across retailers via per-platform endpoints; field
// names differ (Walmart=key_features, Target=highlights; Target images live under
// main_image), so we read each field with cross-platform fallbacks.
const UNWRANGLE_DETAIL_PLATFORM: Record<string, string> = {
  walmart: "walmart_detail", target: "target_detail", samsclub: "samsclub_detail", costco: "costco_detail",
};
async function fetchUnwrangleDetail(key: string, url: string, retailer: string): Promise<DetailContent | null> {
  const platform = UNWRANGLE_DETAIL_PLATFORM[retailer];
  if (!platform) return null;
  try {
    const res = await fetch(`https://data.unwrangle.com/api/getter/?platform=${platform}&url=${encodeURIComponent(url)}&api_key=${key}`, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const d = j?.detail || j?.product;
    if (!d || j?.success === false) return null;
    // Images: some platforms put the primary in main_image and gallery in images.
    const images = normImages([d.main_image, ...(Array.isArray(d.images) ? d.images : [])]);
    if (!images.length && !d.upc) return null;
    const cats = Array.isArray(d.categories) ? d.categories.map((c: any) => (typeof c === "string" ? c : c?.name)).filter(Boolean) : [];
    // Bullets: Walmart→key_features, Target→highlights.
    const rawBullets = Array.isArray(d.key_features) ? d.key_features : Array.isArray(d.highlights) ? d.highlights : [];
    return {
      images,
      bullets: rawBullets.map((b: any) => String(typeof b === "object" ? (b?.value ?? b?.text ?? "") : b).trim()).filter(Boolean).slice(0, 12),
      description: (typeof d.description === "string" && d.description.trim()) ? stripHtml(d.description) : (typeof d.gen_ai_description === "string" ? d.gen_ai_description : null),
      ingredients: parseIngredients(d.ingredients),
      specifications: Array.isArray(d.specifications) ? d.specifications : null,
      upc: d.upc || d.gtin || null,
      category: cats.length ? String(cats[cats.length - 1]).slice(0, 60) : null,
      categories: cats.map((c: any) => String(c)),
      source: "unwrangle",
    };
  } catch { return null; }
}

// BlueCart product detail — fallback (Walmart-specialised, 1 credit/call).
async function fetchBluecartDetail(key: string, itemId: string): Promise<DetailContent | null> {
  try {
    const res = await fetch(`https://api.bluecartapi.com/request?api_key=${key}&type=product&item_id=${encodeURIComponent(itemId)}&walmart_domain=walmart.com`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const p = j?.product;
    if (!p || (!p.main_image && !(p.images || []).length)) return null;
    const html = String(p.description_full_html || p.description_html || p.description || "");
    const cb = Array.isArray(p.breadcrumbs) ? p.breadcrumbs.map((b: any) => (typeof b === "string" ? b : b?.name)).filter(Boolean) : [];
    return {
      images: normImages([p.main_image, ...(p.images || [])]),
      bullets: [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripHtml(m[1]) || "").filter(Boolean).slice(0, 12),
      description: stripHtml(p.description_full_html || p.description_full || p.description),
      ingredients: parseIngredients(p.ingredients),
      specifications: Array.isArray(p.specifications) ? p.specifications : null,
      upc: p.upc || p.gtin || (Array.isArray(p.gtins) ? p.gtins[0] : null) || null,
      category: cb.length ? String(cb[cb.length - 1]).slice(0, 60) : null,
      categories: cb.map((c: any) => String(c)),
      source: "bluecart",
    };
  } catch { return null; }
}

// PHASE 3 — full content harvest for ONE product. Pulls the full product detail
// (gallery ≥5 incl the nutrition-label image, bullets, description, ingredients,
// specs, UPC) onto DonorProduct, then runs image-QC. Prefers Unwrangle (richer +
// 100k-credit plan); falls back to BlueCart. Selective by design.
export async function harvestDonorDetail(db: Client, productId: string): Promise<HarvestResult> {
  // Detail ANY retailer Unwrangle supports, preferring the richest source
  // (Walmart > Target > Sam's > Costco). Pick that retailer's offer that has a URL.
  const off = await db.execute({
    sql: `SELECT retailer, productUrl, retailerProductId FROM "DonorOffer"
          WHERE donorProductId=? AND retailer IN ('walmart','target','samsclub','costco')
          ORDER BY CASE retailer WHEN 'walmart' THEN 0 WHEN 'target' THEN 1 WHEN 'samsclub' THEN 2 ELSE 3 END,
                   (productUrl IS NOT NULL) DESC
          LIMIT 1`,
    args: [productId],
  });
  const row: any = off.rows[0];
  const retailer = row?.retailer as string | undefined;
  const url = row?.productUrl as string | undefined;
  const itemId = row?.retailerProductId as string | undefined;
  if (!url && !itemId) return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "no detailable offer" };

  let c: DetailContent | null = null;
  const uwKey = process.env.UNWRANGLE_API_KEY;
  const bcKey = process.env.BLUECART_API_KEY;
  if (uwKey && url && retailer) c = await fetchUnwrangleDetail(uwKey, url, retailer);
  if (!c && bcKey && itemId && retailer === "walmart") c = await fetchBluecartDetail(bcKey, itemId);
  if (!c) return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "detail fetch failed" };

  // nutrition: no structured field anywhere (it's a gallery image) — keep nutrition-ish specs as the textual record.
  const nutrition = c.specifications ? JSON.stringify(c.specifications.filter((s: any) => /nutri|serving|calorie|sodium|fat|protein|carb/i.test(JSON.stringify(s)))) : null;

  // Storage class (Frozen | Dry) from the full harvested content — LLM cold-chain
  // classifier (refrigerated/perishable ≡ Frozen for us), now that we have the
  // retailer aisle + bullets. Falls back to deterministic on any LLM hiccup.
  const cur = await db.execute({ sql: `SELECT title, imageUrls, bullets FROM "DonorProduct" WHERE id=? LIMIT 1`, args: [productId] });
  const [temperature] = await classifyTemperatureLLM([{ title: cur.rows[0]?.title as string | null, category: c.category, bullets: c.bullets }]);

  // MERGE images (union, detail first) rather than overwrite — some retailers'
  // detail returns fewer photos than their search gallery (Target), so a plain
  // overwrite would shrink the gallery. Keep bullets only when detail has them.
  let existingImgs: string[] = [];
  try { existingImgs = JSON.parse((cur.rows[0]?.imageUrls as string) || "[]"); } catch { /* */ }
  const mergedImgs = normImages([...c.images, ...existingImgs]);
  const bulletsJson = c.bullets.length ? JSON.stringify(c.bullets) : null; // null → keep existing

  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE "DonorProduct" SET mainImageUrl=COALESCE(?, mainImageUrl), imageUrls=?, bullets=COALESCE(?, bullets),
            description=COALESCE(NULLIF(?,''), description), ingredients=COALESCE(?, ingredients),
            nutritionFacts=COALESCE(NULLIF(?,'[]'), nutritionFacts), attributes=?, upc=COALESCE(?, upc),
            category=?, needsReview=0, updatedAt=? WHERE id=?`,
    args: [mergedImgs[0] ?? null, JSON.stringify(mergedImgs), bulletsJson, c.description, c.ingredients, nutrition,
      c.specifications ? JSON.stringify(c.specifications) : null, c.upc, temperature, now, productId],
  });

  let merged = 0;
  if (c.upc) merged = await mergeByUpc(db, productId, c.upc, now);
  let imageFlagged = false;
  try { const qc = await qcProductImage(db, productId); imageFlagged = qc.flagged; } catch { /* best-effort */ }
  return { ok: true, productId, images: mergedImgs.length, upc: c.upc, hasIngredients: !!c.ingredients, merged, imageFlagged };
}

// Move offers from any OTHER product sharing this UPC into `keepId`, then delete the
// emptied duplicates. Activates cross-retailer merge once both sides carry the UPC.
async function mergeByUpc(db: Client, keepId: string, upc: string, now: string): Promise<number> {
  const dups = await db.execute({ sql: `SELECT id FROM "DonorProduct" WHERE upc=? AND id != ?`, args: [upc, keepId] });
  let moved = 0;
  for (const r of dups.rows as any[]) {
    const m = await db.execute({ sql: `UPDATE "DonorOffer" SET donorProductId=?, updatedAt=? WHERE donorProductId=?`, args: [keepId, now, r.id] });
    moved += m.rowsAffected || 0;
    await db.execute({ sql: `DELETE FROM "DonorProduct" WHERE id=?`, args: [r.id] });
  }
  if (moved) await rollupProductExport(db, keepId, now);
  return moved;
}

// Public re-roll (after a merge changes a product's offer set).
async function rollupProductExport(db: Client, productId: string, now: string) {
  const offers = await db.execute({ sql: `SELECT retailer, pricePerUnit, isFirstParty, via FROM "DonorOffer" WHERE donorProductId=?`, args: [productId] });
  const clean = offers.rows.filter((r: any) => r.isFirstParty && r.via === "direct" && r.pricePerUnit != null) as any[];
  if (!clean.length) return;
  clean.sort((a, b) => a.pricePerUnit - b.pricePerUnit);
  const best = clean[0];
  const prod = await db.execute({ sql: `SELECT unitAmount FROM "DonorProduct" WHERE id=?`, args: [productId] });
  const unitAmount = (prod.rows[0]?.unitAmount as number | null) ?? null;
  const ppm = unitAmount && best.pricePerUnit ? Math.round((best.pricePerUnit / unitAmount) * 1000) / 1000 : null;
  await db.execute({ sql: `UPDATE "DonorProduct" SET bestPrice=?, bestRetailer=?, pricePerMeasure=?, updatedAt=? WHERE id=?`, args: [best.pricePerUnit, best.retailer, ppm, now, productId] });
}

async function toBase64(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer()).toString("base64");
  } catch { return null; }
}

export interface ImageQcResult { ok: boolean; chosen: number; flagged: boolean; reason?: string }

// IMAGE QC ("Qual") — vision-inspect the harvested gallery, pick the CLEANEST
// single-product front shot (no collage / multipack / badge overlays) and set it
// as mainImageUrl. If none qualifies → flag needsReview (returned for rework).
// One vision call per product (selective — run after harvest).
export async function qcProductImage(db: Client, productId: string): Promise<ImageQcResult> {
  const row = await db.execute({ sql: `SELECT imageUrls FROM "DonorProduct" WHERE id=? LIMIT 1`, args: [productId] });
  let urls: string[] = [];
  try { urls = JSON.parse((row.rows[0]?.imageUrls as string) || "[]"); } catch { /* */ }
  urls = urls.filter((u) => typeof u === "string" && u.startsWith("http")).slice(0, 6);
  if (!urls.length) return { ok: false, chosen: -1, flagged: false, reason: "no images" };

  const imgs: { i: number; b64: string }[] = [];
  for (let i = 0; i < urls.length; i++) { const b = await toBase64(urls[i]); if (b) imgs.push({ i, b64: b }); }
  if (!imgs.length) return { ok: false, chosen: -1, flagged: false, reason: "no fetchable images" };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "<api_key>") return { ok: false, chosen: -1, flagged: false, reason: "no anthropic key" };
  const mediaType = (b: string) => b.startsWith("/9j/") ? "image/jpeg" : b.startsWith("iVBOR") ? "image/png" : b.startsWith("R0lG") ? "image/gif" : b.startsWith("UklG") ? "image/webp" : "image/jpeg";
  // Pick the RETAIL PACKAGE shot — the product in its store packaging (box, bag,
  // carton, can, jar, wrapper) front-facing, as it sits on the Walmart shelf. This
  // is what the catalog thumbnail must show, NOT a plated/"prepared" photo of the
  // food removed from packaging, a lifestyle scene, an infographic, or a label.
  // Index 0 is the retailer's own primary image (usually the package) — strongly
  // prefer it unless it is clearly bad.
  const prompt = `These ${imgs.length} images (indexes 0..${imgs.length - 1}, in order) are photos of ONE grocery product sold at a retailer. Pick the index of the best CATALOG THUMBNAIL = the RETAIL PACKAGE as sold on the shelf: the product in its own box/bag/carton/can/jar/wrapper, front facing. STRONGLY PREFER the packaged-product shot. Do NOT pick: a "prepared"/plated photo of the food taken OUT of its packaging (e.g. a cooked sandwich or a bowl of the food), a lifestyle/hand/table scene, an infographic or text-heavy banner, a nutrition-facts or ingredients label image, a collage/grid, or a multipack of several units. Index 0 is the retailer's primary image — prefer it when it is a clean package front; only choose another index if 0 is one of the bad types above and another image is a clean package shot. Return ONLY JSON {"best": <index, or -1 ONLY if NONE shows the retail package>, "reason": "short"}.`;
  let res: any;
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });
    const content: any[] = imgs.map((x) => ({ type: "image", source: { type: "base64", media_type: mediaType(x.b64), data: x.b64 } }));
    content.push({ type: "text", text: prompt });
    const r = await client.messages.create({ model: CLAUDE.cheap, max_tokens: 300, messages: [{ role: "user", content }] });
    const tb = r.content.find((b: any) => b.type === "text") as any;
    const m = tb?.text?.match(/\{[\s\S]*\}/);
    res = m ? JSON.parse(m[0]) : null;
  } catch (e: any) { return { ok: false, chosen: -1, flagged: false, reason: String(e?.message || "vision failed").slice(0, 60) }; }

  const best = typeof res?.best === "number" ? res.best : -1;
  const now = new Date().toISOString();
  if (best >= 0 && best < imgs.length) {
    await db.execute({ sql: `UPDATE "DonorProduct" SET mainImageUrl=?, needsReview=0, updatedAt=? WHERE id=?`, args: [urls[imgs[best].i], now, productId] });
    return { ok: true, chosen: imgs[best].i, flagged: false, reason: res?.reason };
  }
  // none clean → return for rework
  await db.execute({ sql: `UPDATE "DonorProduct" SET needsReview=1, updatedAt=? WHERE id=?`, args: [now, productId] });
  return { ok: true, chosen: -1, flagged: true, reason: res?.reason || "no clean front image" };
}

export interface EnrichTargetResult {
  query: string;
  retailersHit: string[];
  productsCreated: number;
  offersUpserted: number;
  rejected: number;
  creditsRemaining: number | null;
  createdProductIds: string[]; // freshly-created products → harvest them right away
}

// Enrich the catalog for one target (brand or free-text query). Searches the
// retailers whose paid service is live, gates each offer, and upserts the survivors
// into DonorProduct/DonorOffer. BlueCart=Walmart is always on; Unwrangle retailers
// run only when `unwrangleRetailers` is passed (i.e. when that sub is paid).
export async function enrichTarget(
  db: Client,
  opts: { target: string; brand?: string | null; zip?: string | null; unwrangleRetailers?: ("walmart" | "target" | "samsclub" | "costco")[]; oxylabsRetailers?: OxylabsRetailer[]; openClawRetailers?: OpenClawRetailer[] },
): Promise<EnrichTargetResult> {
  const cp: CanonicalProduct = { brand: (opts.brand || opts.target.split(/\s+/).slice(0, 2).join(" ")) || undefined };
  const now = new Date().toISOString();
  const retailersHit: string[] = [];
  const createdProductIds: string[] = [];
  let productsCreated = 0, offersUpserted = 0, rejected = 0;
  let creditsRemaining: number | null = null;

  // Collect (sourceApi, scoredOffers) from every live retailer.
  const batches: { offers: ScoredOffer[] }[] = [];

  // Walmart (our #1 buying source): Oxylabs' structured walmart_search reads
  // walmart.com DIRECTLY and returns clean 1P (seller "Walmart.com") — it recovers
  // niche/local grocery (Klass, Arnold bread) that Unwrangle's public search only
  // surfaces as inflated 3P/reseller. So Oxylabs is the PRIMARY Walmart source;
  // Unwrangle-walmart is the fallback, then dead BlueCart last (if ever revived).
  let walmartCovered = false;
  try {
    const ox = await oxylabsWalmartSearch(opts.target);
    if (!ox.trialExhausted && ox.offers.length) { retailersHit.push("walmart"); batches.push({ offers: ox.offers.map((o) => scoreOffer(o, cp)) }); walmartCovered = true; }
  } catch { /* Oxylabs unavailable — Unwrangle walmart fallback below */ }
  for (const r of opts.unwrangleRetailers ?? []) {
    if (r === "walmart" && walmartCovered) continue; // Oxylabs already gave clean 1P Walmart
    try {
      const uw = await unwrangleSearch(r, opts.target);
      if (!uw.trialExhausted) {
        if (uw.creditsRemaining != null) creditsRemaining = uw.creditsRemaining;
        if (!retailersHit.includes(r)) retailersHit.push(r);
        batches.push({ offers: uw.offers.map((o) => scoreOffer(o, cp)) });
        if (r === "walmart" && uw.offers.length) walmartCovered = true;
      }
    } catch { /* skip this retailer on error */ }
  }
  if (!walmartCovered && process.env.BLUECART_API_KEY) {
    try {
      const bc = await bluecartWalmartSearch(opts.target);
      if (bc.creditsRemaining != null) creditsRemaining = bc.creditsRemaining;
      if (!bc.trialExhausted && bc.offers.length) { if (!retailersHit.includes("walmart")) retailersHit.push("walmart"); batches.push({ offers: bc.offers.map((o) => scoreOffer(o, cp)) }); }
    } catch { /* BlueCart unavailable */ }
  }

  // Oxylabs retailers (open sites: Aldi, + Instacart fallback). Inert until
  // OXYLABS_USERNAME/PASSWORD exist, so this is safe before the sub is paid.
  if (oxylabsEnabled()) {
    for (const r of opts.oxylabsRetailers ?? []) {
      try {
        const ox = await oxylabsSearch(r, opts.target);
        if (!ox.trialExhausted && ox.offers.length) { if (!retailersHit.includes(r)) retailersHit.push(r); batches.push({ offers: ox.offers.map((o) => scoreOffer(o, cp)) }); }
      } catch { /* skip this source on error */ }
    }
  }

  // OpenClaw retailers (member-gated: BJ's club, Publix store) — a logged-in browser
  // on the OpenClaw box does the search. Inert until OPENCLAW_GROCERY_URL/TOKEN exist.
  if (openClawEnabled()) {
    for (const r of opts.openClawRetailers ?? []) {
      try {
        const oc = await openClawSearch(r, opts.target, opts.zip ?? "33765");
        if (!oc.trialExhausted && oc.offers.length) { if (!retailersHit.includes(r)) retailersHit.push(r); batches.push({ offers: oc.offers.map((o) => scoreOffer(o, cp)) }); }
      } catch { /* skip this source on error */ }
    }
  }

  // QA "qualification dept": tier-1 deterministic non-grocery reject (free) +
  // tier-2 batched LLM grocery judge (1 cheap Haiku call). Only survivors are
  // written — keeps books / batteries / laundry out of the catalog.
  const candidates: ScoredOffer[] = [];
  for (const b of batches) for (const o of b.offers) {
    if (!o.accepted) { rejected++; continue; }
    if (!o.retailerProductId) continue;
    // Supermarkets (Walmart/Target): single retail unit only — no 2/4/6-pack bundles.
    // Warehouse clubs (Costco/Sam's/BJ's/Restaurant Depot): their native bulk format
    // IS a valid purchase unit (a 12-count box, a #10 can) and a real sourcing lever,
    // so we keep it even when packSizeSeen > 1.
    if (!o.isBaseUnit && !CLUB_RETAILERS.has(o.retailer)) { rejected++; continue; }
    if (looksNonGrocery(o.title)) { rejected++; continue; }
    candidates.push(o);
  }
  const verdicts = await classifyGroceryTitles(candidates.map((o) => o.title || ""));
  const survivors = candidates.filter((_, i) => verdicts[i]);
  rejected += candidates.length - survivors.length;

  const brandHint = normalizeBrandCase(cleanBrand(cp.brand));
  for (const o of survivors) {
    const { size, unitMeasure, unitAmount } = parseSize(o.title);
    const offerBrand = canonicalMultiwordBrand(o.title) || brandHint || normalizeBrandCase(deriveBrand(o.title)) || null;
    const identityKey = computeIdentityKey({ brand: offerBrand, title: o.title, size });

    // Resolve the product WITHOUT orphaning: if this exact offer already exists,
    // keep it with its current product. Otherwise match by identityKey; else create.
    let productId: string;
    const existingOffer = await db.execute({ sql: `SELECT donorProductId FROM "DonorOffer" WHERE retailer=? AND retailerProductId=? LIMIT 1`, args: [o.retailer, o.retailerProductId] });
    if (existingOffer.rows.length) {
      productId = existingOffer.rows[0].donorProductId as string;
    } else {
      const found = await db.execute({ sql: `SELECT id FROM "DonorProduct" WHERE identityKey=? LIMIT 1`, args: [identityKey] });
      if (found.rows.length) {
        productId = found.rows[0].id as string;
      } else {
        productId = crypto.randomUUID();
        const temp0 = classifyTemperature({ title: o.title, description: o.description, bullets: o.keyFeatures });
        await db.execute({
          sql: `INSERT INTO "DonorProduct" (id, brand, title, size, unitMeasure, unitAmount, category, mainImageUrl, imageUrls, identityKey, createdAt, updatedAt)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [productId, offerBrand, o.title ?? null, size, unitMeasure, unitAmount, temp0, (o.imageUrls || [])[0] ?? null, JSON.stringify(o.imageUrls || []), identityKey, now, now],
        });
        productsCreated++;
        createdProductIds.push(productId);
      }
    }

    // Clubs: the bulk pack is the buy unit → don't divide. Supermarkets: divide a
    // true N-pack bundle down to the per-unit price.
    const via: "direct" | "instacart" = o.via === "instacart" ? "instacart" : "direct";
    const realPack = o.packSizeSeen ?? 1;            // recorded for display
    const divisor = CLUB_RETAILERS.has(o.retailer) ? 1 : realPack; // clubs: pack IS the buy unit
    let perUnit = o.price != null ? Math.round((o.price / (divisor || 1)) * 100) / 100 : null;
    // Instacart: store the estimated in-store price (raw ÷ markup); raw stays in `price`.
    if (via === "instacart" && perUnit != null) perUnit = Math.round((perUnit / INSTACART_MARKUP) * 100) / 100;
    await db.execute({
      sql: `INSERT INTO "DonorOffer" (id, donorProductId, retailer, retailerProductId, via, price, packSizeSeen, pricePerUnit, currency, zip, inStock, productUrl, sellerName, isFirstParty, sourceApi, fetchedAt, createdAt, updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(retailer, retailerProductId) DO UPDATE SET
              donorProductId=excluded.donorProductId, price=excluded.price, packSizeSeen=excluded.packSizeSeen,
              pricePerUnit=excluded.pricePerUnit, inStock=excluded.inStock, productUrl=excluded.productUrl,
              sellerName=excluded.sellerName, isFirstParty=excluded.isFirstParty, fetchedAt=excluded.fetchedAt, updatedAt=excluded.updatedAt`,
      args: [
        `do:${o.retailer}:${o.retailerProductId}`, productId, o.retailer, o.retailerProductId, via,
        o.price ?? null, realPack, perUnit, o.currency || "USD", opts.zip ?? null,
        o.inStock === null ? null : o.inStock ? 1 : 0, o.productUrl ?? null, o.sellerName ?? null, 1, o.sourceApi ?? null, now, now, now,
      ],
    });
    offersUpserted++;
    await rollupProduct(db, productId, now);
  }

  return { query: opts.target, retailersHit, productsCreated, offersUpserted, rejected, creditsRemaining, createdProductIds };
}

// Roll the cheapest CLEAN first-party DIRECT offer up to the product (bestPrice +
// $/measure) so the Reference Catalog table can sort/filter without a join.
async function rollupProduct(db: Client, productId: string, now: string) {
  const offers = await db.execute({ sql: `SELECT retailer, pricePerUnit, isFirstParty, via FROM "DonorOffer" WHERE donorProductId=?`, args: [productId] });
  const clean = offers.rows.filter((r: any) => r.isFirstParty && r.via === "direct" && r.pricePerUnit != null) as any[];
  if (!clean.length) return;
  clean.sort((a, b) => a.pricePerUnit - b.pricePerUnit);
  const best = clean[0];
  const prod = await db.execute({ sql: `SELECT unitAmount FROM "DonorProduct" WHERE id=?`, args: [productId] });
  const unitAmount = (prod.rows[0]?.unitAmount as number | null) ?? null;
  const ppm = unitAmount && best.pricePerUnit ? Math.round((best.pricePerUnit / unitAmount) * 1000) / 1000 : null;
  await db.execute({
    sql: `UPDATE "DonorProduct" SET bestPrice=?, bestRetailer=?, pricePerMeasure=?, updatedAt=? WHERE id=?`,
    args: [best.pricePerUnit, best.retailer, ppm, now, productId],
  });
}
