// Reference Catalog (Donor DB) enrichment core. Turns retailer SEARCH results into
// product-centric DonorProduct candidates + per-retailer DonorOffer rows. Cross-
// source rows stay isolated until exact identity certification. Reuses retail-fetch
// gates (first-party only, brand token, price sanity) so only clean, real offers
// land. The cheapest CLEAN first-party DIRECT offer rolls up to DonorProduct.bestPrice.
// See docs/wiki/reference-catalog-engine.md.

import type { Client } from "@libsql/client";
import crypto from "crypto";
import {
  unwrangleSearch,
  scoreOffer,
  type CanonicalProduct,
  type ScoredOffer,
} from "./retail-fetch";
import {
  buildCanonicalProductVariantKey,
  type CanonicalProductVariantKey,
} from "./canonical-product-variant";
import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  matchCanonicalProductTitle,
  type CanonicalProductIdentity,
  type NormalizedCanonicalProduct,
} from "./canonical-product-match";
import { oxylabsSearch, oxylabsWalmartSearch, oxylabsEnabled, type OxylabsRetailer } from "./oxylabs-fetch";
import { openClawSearch, openClawEnabled, type OpenClawRetailer } from "./openclaw-fetch";
import { CLAUDE } from "@/lib/ai-models";
import { currentMeteredRunPermit } from "./metered-call-guard";
import {
  throwIfMeteredProviderControlError,
  withMeteredProviderCall,
  type MeteredProviderAuthorization,
} from "./metered-provider-call";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthMeteredEvidenceSchema,
} from "./product-truth-schema-gate";
import { evaluatePriceEvidenceEligibility } from "./price-evidence-policy";

type SqlExecutor = Pick<Client, "execute">;

const SOURCE_IDENTITY_EVIDENCE_VERSION =
  "donor-source-identity-evidence/1.0.0" as const;
const PRODUCT_CONTENT_OBSERVATION_VERSION =
  "product-content-observation/1.0.0" as const;

function stableJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("stable JSON numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => stableJsonValue(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort((left, right) => left.localeCompare(right, "en-US"))
        .map((key) => [key, stableJsonValue(record[key])]),
    );
  }
  throw new TypeError(`stable JSON cannot encode ${typeof value}`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactHttpUrl(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

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

// Candidate identity fingerprint: brand + distinctive title words + size token.
// It is never sufficient by itself to merge content across retailers; newly
// discovered rows append their retailer item identity until exact certification.
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
// version below is the canonical automatic path. The legacy LLM entrypoint is
// retained as a deterministic compatibility wrapper so catalog reads never hide
// an unapproved metered classification call.
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

// Legacy compatibility name. Automatic classification is deliberately free and
// deterministic; any future LLM review must be a separate owner-budgeted job.
export async function classifyTemperatureLLM(items: { title?: string | null; category?: string | null; bullets?: string[] | null }[]): Promise<Temperature[]> {
  return items.map((it) => classifyTemperature({
    title: it.title,
    bullets: it.bullets,
    retailerCats: it.category ? [it.category] : null,
  }));
}

// ── QA "qualification department" ──────────────────────────────────────────
// tier-1 (free): obvious non-grocery markers — books/media/household/HBA.
const NON_GROCERY = /\b(paperback|hardcover|board book|audiobook|kindle|notebook|diary|journal|vol\.?\s*\d|batteries?|d cell|in-wash|scent booster|detergent|fabric softener|laundry|dish soap|shampoo|conditioner|toothpaste|deodorant|paper towels?|toilet paper|napkins?|trash bags?|light bulb|recollections)\b/i;
export function looksNonGrocery(title?: string | null): boolean {
  return !!title && NON_GROCERY.test(title);
}

// Legacy tier-2 compatibility name. It is deterministic and free; uncertain
// cases stay eligible, while the explicit tier-1 denylist rejects known junk.
export async function classifyGroceryTitles(titles: string[]): Promise<boolean[]> {
  return titles.map((title) => !looksNonGrocery(title));
}

// Remove products left with zero offers (legacy duplicate artifacts from the old
// query-derived identityKey). Safe to call anytime.
export async function cleanupOrphans(db: Client): Promise<number> {
  void db;
  throw new Error("DESTRUCTIVE_CATALOG_CLEANUP_DISABLED: use an evidence-backed quarantine workflow");
}

// Collapse redundant SAME-retailer offers on one product. Unwrangle's search can
// return two Walmart listings (different us_item_ids) for the same item, which
// showed up as a "doubled" offer. We only keep first-party offers, so duplicates
// from one retailer are genuinely the same product — keep the best (in-stock,
// then cheapest per-unit, then one with a URL) and drop the rest.
export async function dedupeOffersPerRetailer(db: Client): Promise<number> {
  void db;
  throw new Error("DESTRUCTIVE_OFFER_DEDUPE_DISABLED: preserve observations and quarantine conflicts");
}

const stripHtml = (s?: string | null) => (s ? String(s).replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : null);

export interface HarvestResult {
  ok: boolean;
  productId: string;
  images: number;
  upc: string | null;
  hasIngredients: boolean;
  /** @deprecated Automatic identity merges are disabled; this is always zero. */
  merged: number;
  /** Number of other donor rows quarantined for review because they share this UPC. */
  upcConflicts?: number;
  imageFlagged?: boolean;
  reason?: string;
  blockers?: string[];
}

export interface DetailContent {
  /** Identity evidence returned by the detail endpoint itself. */
  title: string | null;
  retailerProductId: string | null;
  productUrl: string | null;
  images: string[];
  bullets: string[];
  description: string | null;
  ingredients: string | null;
  nutritionFacts: unknown;
  allergens: unknown;
  specifications: unknown[] | null;
  upc: string | null;
  category: string | null;
  storage: string | null;
  categories: string[];
  source: string;
}

function normImages(arr: unknown): string[] {
  const raw = (Array.isArray(arr) ? arr : [])
    .map((value: unknown) => {
      if (typeof value === "string") return value;
      if (!isUnknownRecord(value)) return null;
      const candidate = value.url ?? value.link;
      return typeof candidate === "string" ? candidate : null;
    })
    .filter((url): url is string => typeof url === "string" && url.startsWith("http"));
  const seen = new Set<string>(); const out: string[] = [];
  for (const u of raw) { if (!seen.has(u)) { seen.add(u); out.push(u); } }
  return out;
}
function parseIngredients(ing: unknown): string | null {
  if (!ing) return null;
  if (typeof ing === "string") return ing.trim() || null;
  if (isUnknownRecord(ing)) {
    const vals = Object.values(ing)
      .map((value: unknown) => isUnknownRecord(value) ? value.value : value)
      .filter((value): value is string => typeof value === "string" && !!value.trim());
    return vals.length ? vals.join(" | ") : null;
  }
  return null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function detailIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return nonEmptyText(value);
}

function specificationValue(
  specifications: unknown,
  namePattern: RegExp,
): unknown {
  if (!Array.isArray(specifications)) return null;
  for (const item of specifications) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = nonEmptyText(
      record.name ?? record.label ?? record.key ?? record.attribute_name ?? record.display_name,
    );
    if (!name || !namePattern.test(name)) continue;
    const value = record.value ?? record.values ?? record.text ?? record.attribute_value;
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function normalizedManufacturerCode(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return /^\d{12,14}$/.test(digits) ? digits : null;
}

// Unwrangle product detail. Reservations follow the provider's retailer tier:
// Walmart/Target 2.5 units, Sam's/Costco 10 units. Works across retailer-specific
// endpoints; field
// names differ (Walmart=key_features, Target=highlights; Target images live under
// main_image), so we read each field with cross-platform fallbacks.
const UNWRANGLE_DETAIL_PLATFORM: Record<string, string> = {
  walmart: "walmart_detail", target: "target_detail", samsclub: "samsclub_detail", costco: "costco_detail",
};
export const UNWRANGLE_DETAIL_CREDIT_UNITS = Object.freeze({
  walmart: 2.5,
  target: 2.5,
  samsclub: 10,
  costco: 10,
} as const);

export function unwrangleDetailCreditUnits(retailer: string): number | null {
  return Object.prototype.hasOwnProperty.call(UNWRANGLE_DETAIL_CREDIT_UNITS, retailer)
    ? UNWRANGLE_DETAIL_CREDIT_UNITS[retailer as keyof typeof UNWRANGLE_DETAIL_CREDIT_UNITS]
    : null;
}

/** Parse only source-observed detail facts. Provider-generated copy is not
 * Product Truth and is intentionally excluded from the exact-content path. */
export function parseUnwrangleDetailPayload(json: unknown): DetailContent | null {
  const j = isUnknownRecord(json) ? json : null;
  const d = isUnknownRecord(j?.detail)
    ? j.detail
    : isUnknownRecord(j?.product) ? j.product : null;
  if (!d || j?.success === false) return null;
  const images = normImages([d.main_image, ...(Array.isArray(d.images) ? d.images : [])]);
  if (!images.length && !d.upc) return null;
  const categories = Array.isArray(d.categories)
    ? d.categories
      .map((category: unknown) => {
        if (typeof category === "string") return category;
        if (!isUnknownRecord(category)) return null;
        return typeof category.name === "string" ? category.name : null;
      })
      .filter((category): category is string => !!category)
    : [];
  const specifications = Array.isArray(d.specifications) ? d.specifications : null;
  const rawBullets = Array.isArray(d.key_features)
    ? d.key_features
    : Array.isArray(d.highlights) ? d.highlights : [];
  return {
    title: nonEmptyText(d.title ?? d.name ?? d.product_name),
    retailerProductId: detailIdentifier(
      d.id ?? d.us_item_id ?? d.item_id ?? d.product_id ?? d.retailer_product_id,
    ),
    productUrl: nonEmptyText(d.product_url ?? d.canonical_url ?? d.url),
    images,
    bullets: rawBullets.map((bullet: unknown) => {
      const value = isUnknownRecord(bullet)
        ? bullet.value ?? bullet.text ?? ""
        : bullet;
      return String(value ?? "").trim();
    }).filter(Boolean).slice(0, 12),
    description: typeof d.description === "string" && d.description.trim()
      ? stripHtml(d.description)
      : null,
    ingredients: parseIngredients(d.ingredients),
    nutritionFacts: d.nutrition_facts ?? d.nutrition ?? specificationValue(
      specifications,
      /nutrition|serving|calorie|sodium|fat|protein|carbohydrate/i,
    ),
    allergens: d.allergens ?? d.allergen_information ?? specificationValue(
      specifications,
      /allergen/i,
    ),
    specifications,
    upc: nonEmptyText(d.upc) ?? nonEmptyText(d.gtin),
    category: categories.length ? String(categories[categories.length - 1]).slice(0, 60) : null,
    storage: nonEmptyText(
      d.storage_temperature
        ?? d.storage_instructions
        ?? specificationValue(specifications, /storage|keep frozen|keep refrigerated/i),
    ),
    categories: categories.map((category) => String(category)),
    source: "unwrangle",
  };
}

async function fetchUnwrangleDetail(
  key: string,
  url: string,
  retailer: string,
  onMeteredReservation?: (authorization: MeteredProviderAuthorization) => Promise<void>,
): Promise<DetailContent | null> {
  const platform = UNWRANGLE_DETAIL_PLATFORM[retailer];
  const units = unwrangleDetailCreditUnits(retailer);
  if (!platform || units == null) return null;
  try {
    return await withMeteredProviderCall({
      provider: "unwrangle",
      operation: "detail",
      units,
      requestFingerprint: { platform, retailer, url },
      onAuthorized: onMeteredReservation,
    }, async () => {
      const res = await fetch(`https://data.unwrangle.com/api/getter/?platform=${platform}&url=${encodeURIComponent(url)}&api_key=${key}`, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) return null;
      const json: unknown = await res.json();
      return parseUnwrangleDetailPayload(json);
    });
  } catch (error) {
    throwIfMeteredProviderControlError(error);
    return null;
  }
}

// BlueCart product detail — fallback (Walmart-specialised, 1 credit/call).
async function fetchBluecartDetail(
  key: string,
  itemId: string,
  onMeteredReservation?: (authorization: MeteredProviderAuthorization) => Promise<void>,
): Promise<DetailContent | null> {
  try {
    return await withMeteredProviderCall({
      provider: "bluecart",
      operation: "detail",
      requestFingerprint: { itemId, domain: "walmart.com" },
      onAuthorized: onMeteredReservation,
    }, async () => {
      const res = await fetch(`https://api.bluecartapi.com/request?api_key=${key}&type=product&item_id=${encodeURIComponent(itemId)}&walmart_domain=walmart.com`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      const json: unknown = await res.json();
      const j = isUnknownRecord(json) ? json : null;
      const p = isUnknownRecord(j?.product) ? j.product : null;
      if (!p || (!p.main_image && !(Array.isArray(p.images) && p.images.length))) return null;
      const html = String(p.description_full_html || p.description_html || p.description || "");
      const cb = Array.isArray(p.breadcrumbs)
        ? p.breadcrumbs
          .map((breadcrumb: unknown) => {
            if (typeof breadcrumb === "string") return breadcrumb;
            if (!isUnknownRecord(breadcrumb)) return null;
            return typeof breadcrumb.name === "string" ? breadcrumb.name : null;
          })
          .filter((breadcrumb): breadcrumb is string => !!breadcrumb)
        : [];
      const specifications = Array.isArray(p.specifications) ? p.specifications : null;
      return {
        title: nonEmptyText(p.title ?? p.product_title ?? p.name),
        retailerProductId: detailIdentifier(
          p.us_item_id ?? p.item_id ?? p.product_id ?? p.retailer_product_id,
        ),
        productUrl: nonEmptyText(p.product_url ?? p.canonical_url ?? p.link ?? p.url),
        images: normImages([p.main_image, ...(Array.isArray(p.images) ? p.images : [])]),
        bullets: [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripHtml(m[1]) || "").filter(Boolean).slice(0, 12),
        description: stripHtml(
          nonEmptyText(p.description_full_html)
            ?? nonEmptyText(p.description_full)
            ?? nonEmptyText(p.description),
        ),
        ingredients: parseIngredients(p.ingredients),
        nutritionFacts: p.nutrition_facts ?? p.nutrition ?? specificationValue(
          specifications,
          /nutrition|serving|calorie|sodium|fat|protein|carbohydrate/i,
        ),
        allergens: p.allergens ?? p.allergen_information ?? specificationValue(
          specifications,
          /allergen/i,
        ),
        specifications,
        upc: nonEmptyText(p.upc)
          ?? nonEmptyText(p.gtin)
          ?? (Array.isArray(p.gtins) ? nonEmptyText(p.gtins[0]) : null),
        category: cb.length ? String(cb[cb.length - 1]).slice(0, 60) : null,
        storage: nonEmptyText(
          p.storage_temperature
            ?? p.storage_instructions
            ?? specificationValue(specifications, /storage|keep frozen|keep refrigerated/i),
        ),
        categories: cb.map((category) => String(category)),
        source: "bluecart",
      };
    });
  } catch (error) {
    throwIfMeteredProviderControlError(error);
    return null;
  }
}

// PHASE 3 — full content harvest for ONE product. Pulls the full product detail
// (gallery ≥5 incl the nutrition-label image, bullets, description, ingredients,
// specs, UPC) onto DonorProduct, then runs image-QC. Prefers Unwrangle (richer +
// 100k-credit plan); falls back to BlueCart. Selective by design.
// Open Food Facts — FREE structured grocery record by UPC/barcode. walmart_detail
// returns nutrition only as a label IMAGE (no structured text), so we already pay the
// 2.5cr detail credit but can't book nutrition/ingredients from it. OFF fills that gap
// at $0 when its exact UPC matches. The immutable writer still blocks when any
// required exact field remains absent; the supplement never manufactures completeness.
async function fetchOpenFoodFacts(upc: string): Promise<{
  ingredients: string | null;
  nutrition: unknown;
  allergens: string[] | null;
} | null> {
  const code = String(upc).replace(/\D/g, "");
  if (code.length < 8) return null;
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
  // OFF's free read API rate-limits (~100/min) — retry a couple times on error/timeout
  // so a transient 429/timeout doesn't drop a product that IS in the DB.
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=ingredients_text,nutriments,allergens_tags`, { signal: AbortSignal.timeout(12000) });
      if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 800 * (a + 1))); continue; }
      if (!r.ok) return null;
      const json: unknown = await r.json();
      const j = isUnknownRecord(json) ? json : null;
      const p = isUnknownRecord(j?.product) ? j.product : null;
      if (j?.status !== 1 || !p) return null;
      const ing = typeof p.ingredients_text === "string" && p.ingredients_text.trim() ? decode(p.ingredients_text).slice(0, 2000) : null;
      const allg = Array.isArray(p.allergens_tags)
        ? p.allergens_tags.map((a2: string) => a2.replace(/^en:/, ""))
        : null;
      const nutObj = p.nutriments && Object.keys(p.nutriments).length
        ? p.nutriments
        : null;
      if (!ing && !nutObj && allg === null) return null;
      return { ingredients: ing, nutrition: nutObj, allergens: allg };
    } catch { await new Promise((res) => setTimeout(res, 800 * (a + 1))); }
  }
  return null;
}

export interface HarvestDonorDetailOptions {
  provider: "unwrangle" | "bluecart";
  retailer: "walmart" | "target" | "samsclub" | "costco";
  retailerProductId: string;
  productUrl?: string | null;
  /**
   * The normal catalog lane may supplement an exact retailer UPC with the free
   * Open Food Facts record. Narrow sealed lanes must set this to false when the
   * approved network surface contains only the paid retailer calls.
   */
  allowOpenFoodFactsSupplement?: boolean;
  /** Walmart new-SKU pilot only: the retailer item must itself be one base package. */
  requireBaseUnit?: boolean;
  /** Targeted lanes block/rollback instead of mutating unrelated UPC peers. */
  upcConflictPolicy?: "quarantine" | "block";
  /** Called after the provider guard reserves budget and before HTTP begins. */
  onMeteredReservation?: (authorization: MeteredProviderAuthorization) => Promise<void>;
  /** Optional sealed-lane drift/deadline fence after HTTP and before catalog
   * writes. A returned timestamp is the only clock the exact writer may use. */
  beforeCatalogWrite?: () => Promise<string | void>;
}

export async function harvestDonorDetail(
  db: Client,
  productId: string,
  options?: HarvestDonorDetailOptions,
): Promise<HarvestResult> {
  if (!options) {
    return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "explicit harvest source required" };
  }
  await assertProductTruthEvidenceSchema(db);
  await assertProductTruthMeteredEvidenceSchema(db);
  const retailer = options.retailer;
  const itemId = options.retailerProductId;
  const exactSource = (await db.execute({
    sql: `SELECT product.title, product.imageUrls, product.bullets, product.upc,
                 decision.id AS variantDecisionId,
                 decision.canonicalVariantId,
                 offer.productUrl AS storedProductUrl,
                 offer.packSizeSeen AS storedPackSizeSeen
          FROM "DonorProduct" product
          JOIN "DonorProductVariantDecision" decision
            ON decision.donorProductId=product.id
           AND decision.decisionStatus='exact_confirmed'
          JOIN "DonorOffer" offer
            ON offer.donorProductId=product.id
           AND offer.retailer=?
           AND offer.retailerProductId=?
           AND offer.via='direct'
           AND offer.isFirstParty=1
          WHERE product.id=? AND product.identityStatus='exact_confirmed'
            AND (offer.retailer<>'walmart' OR offer.sellerName='Walmart.com')
          LIMIT 1`,
    args: [retailer, itemId, productId],
  })).rows[0];
  if (!exactSource) {
    return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "exact source alias required" };
  }
  if (options.requireBaseUnit === true && Number(exactSource.storedPackSizeSeen) !== 1) {
    return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "base-unit source item required" };
  }
  const storedSourceUrl = exactHttpsUrl(exactSource.storedProductUrl);
  const requestedSourceUrl = exactHttpsUrl(options.productUrl);
  if (requestedSourceUrl && storedSourceUrl && requestedSourceUrl !== storedSourceUrl) {
    return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "harvest source URL mismatch" };
  }
  const sourceUrl = storedSourceUrl;
  if (!sourceUrl || !itemId) {
    return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "provenance product URL required" };
  }

  let c: DetailContent | null = null;
  let meteredAuthorization: MeteredProviderAuthorization | null = null;
  const captureReservation = async (authorization: MeteredProviderAuthorization) => {
    meteredAuthorization = authorization;
    await options.onMeteredReservation?.(authorization);
  };
  const uwKey = process.env.UNWRANGLE_API_KEY;
  const bcKey = process.env.BLUECART_API_KEY;
  if (options.provider === "unwrangle" && uwKey) {
    c = await fetchUnwrangleDetail(uwKey, sourceUrl, retailer, captureReservation);
  } else if (options.provider === "bluecart" && bcKey && itemId && retailer === "walmart") {
    c = await fetchBluecartDetail(bcKey, itemId, captureReservation);
  }
  if (!c) return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "detail fetch failed" };
  // The callback runs inside the awaited provider wrapper; TypeScript cannot
  // model that cross-function assignment, so re-establish its declared union.
  const authorization = meteredAuthorization as MeteredProviderAuthorization | null;
  if (!authorization) {
    throw new Error("HARVEST_METERED_RECEIPT_REQUIRED");
  }
  // Exact-UPC supplemental facts are allowed, but only when the retailer detail
  // itself supplied the UPC that binds that record to this exact retailer item.
  // Missing category/storage/allergen/nutrition evidence is never inferred.
  const upcForOff = normalizedManufacturerCode(c.upc);
  const detailNutrition = contentEvidencePresent(c.nutritionFacts)
    ? c.nutritionFacts
    : null;
  const detailIngredients = nonEmptyText(c.ingredients);
  const detailAllergens = contentEvidencePresent(c.allergens, true)
    ? c.allergens
    : null;
  const needsOffFacts = !detailIngredients || detailNutrition == null || detailAllergens == null;
  const offFacts = options.allowOpenFoodFactsSupplement !== false && upcForOff && needsOffFacts
    ? await fetchOpenFoodFacts(String(upcForOff))
    : null;
  const nutrition = detailNutrition ?? offFacts?.nutrition ?? null;
  const ingredients = detailIngredients ?? offFacts?.ingredients ?? null;
  const allergens = detailAllergens ?? offFacts?.allergens ?? null;
  const guardedWriteAt = await options.beforeCatalogWrite?.();
  const now = guardedWriteAt === undefined
    ? new Date().toISOString()
    : exactInstant(guardedWriteAt);
  if (!now) {
    throw new Error("HARVEST_GUARDED_WRITE_TIMESTAMP_INVALID");
  }
  try {
    const offSource = upcForOff ? {
      binding: "EXACT_UPC" as const,
      upc: upcForOff,
      sourceApi: "openfoodfacts",
      sourceUrl: `https://world.openfoodfacts.org/product/${upcForOff}`,
      observedAt: now,
    } : null;
    const supplementalSources: PersistCompleteExactContentObservationInput["supplementalSources"] = {};
    if (!detailIngredients && offFacts?.ingredients && offSource) {
      supplementalSources.ingredients = offSource;
    }
    if (detailNutrition == null && offFacts?.nutrition != null && offSource) {
      supplementalSources.nutritionFacts = offSource;
    }
    if (detailAllergens == null && offFacts?.allergens != null && offSource) {
      supplementalSources.allergens = offSource;
    }
    const persisted = await persistCompleteExactContentObservation(db, {
      donorProductId: productId,
      retailer,
      retailerProductId: itemId,
      sourceUrl,
      sourceApi: c.source,
      observedAt: now,
      processingNow: now,
      provenance: {
        runId: authorization.runId,
        approvalId: authorization.approvalId,
        meteredReceiptId: authorization.receiptId,
      },
      detailIdentity: {
        title: c.title ?? "",
        retailerProductId: c.retailerProductId,
        productUrl: c.productUrl,
      },
      content: {
        description: c.description,
        bullets: c.bullets,
        attributes: { specifications: c.specifications ?? [] },
        nutritionFacts: nutrition,
        ingredients,
        allergens,
        mainImageUrl: c.images[0] ?? null,
        imageUrls: c.images,
        upc: c.upc,
        category: c.category,
        storage: c.storage,
      },
      supplementalSources,
      upcConflictPolicy: options.upcConflictPolicy,
      requireBaseUnit: options.requireBaseUnit,
    });
    return {
      ok: true,
      productId,
      images: persisted.imageCount,
      upc: persisted.upc,
      hasIngredients: true,
      merged: 0,
      upcConflicts: persisted.upcConflicts,
      imageFlagged: false,
    };
  } catch (error) {
    if (error instanceof ExactContentSnapshotBlockedError) {
      return {
        ok: false,
        productId,
        images: 0,
        upc: upcForOff,
        hasIngredients: !!ingredients,
        merged: 0,
        reason: error.message,
        blockers: error.blockers,
      };
    }
    throw error;
  }
}

async function quarantineUpcConflicts(db: SqlExecutor, keepId: string, upc: string, now: string): Promise<number> {
  const dups = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM "DonorProduct" WHERE upc=? AND id != ?`,
    args: [upc, keepId],
  });
  const count = Number(dups.rows[0]?.n || 0);
  if (!count) return 0;
  await db.execute({
    sql: `UPDATE "DonorProduct" SET needsReview=1, updatedAt=? WHERE upc=?`,
    args: [now, upc],
  });
  return count;
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
  const mediaType = (
    b: string,
  ): "image/jpeg" | "image/png" | "image/gif" | "image/webp" => b.startsWith("/9j/")
    ? "image/jpeg"
    : b.startsWith("iVBOR")
      ? "image/png"
      : b.startsWith("R0lG")
        ? "image/gif"
        : b.startsWith("UklG") ? "image/webp" : "image/jpeg";
  // Pick the RETAIL PACKAGE shot — the product in its store packaging (box, bag,
  // carton, can, jar, wrapper) front-facing, as it sits on the Walmart shelf. This
  // is what the catalog thumbnail must show, NOT a plated/"prepared" photo of the
  // food removed from packaging, a lifestyle scene, an infographic, or a label.
  // Index 0 is the retailer's own primary image (usually the package) — strongly
  // prefer it unless it is clearly bad.
  const prompt = `These ${imgs.length} images (indexes 0..${imgs.length - 1}, in order) are photos of ONE grocery product sold at a retailer. Pick the index of the best CATALOG THUMBNAIL = the RETAIL PACKAGE as sold on the shelf: the product in its own box/bag/carton/can/jar/wrapper, front facing. STRONGLY PREFER the packaged-product shot. Do NOT pick: a "prepared"/plated photo of the food taken OUT of its packaging (e.g. a cooked sandwich or a bowl of the food), a lifestyle/hand/table scene, an infographic or text-heavy banner, a nutrition-facts or ingredients label image, a collage/grid, or a multipack of several units. Index 0 is the retailer's primary image — prefer it when it is a clean package front; only choose another index if 0 is one of the bad types above and another image is a clean package shot. Return ONLY JSON {"best": <index, or -1 ONLY if NONE shows the retail package>, "reason": "short"}.`;
  let res: { best?: unknown; reason?: unknown } | null = null;
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });
    const content = imgs.map((x) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: mediaType(x.b64),
        data: x.b64,
      },
    }));
    const messageContent = [
      ...content,
      { type: "text" as const, text: prompt },
    ];
    const r = await withMeteredProviderCall({
      provider: "anthropic",
      operation: "vision",
      requestFingerprint: { productId, imageUrls: imgs.map((x) => urls[x.i]) },
    }, () => client.messages.create({
      model: CLAUDE.cheap,
      max_tokens: 300,
      messages: [{ role: "user", content: messageContent }],
    }));
    const textBlock = r.content.find((block) => block.type === "text");
    const m = textBlock?.type === "text"
      ? textBlock.text.match(/\{[\s\S]*\}/)
      : null;
    res = m ? JSON.parse(m[0]) : null;
  } catch (error: unknown) {
    throwIfMeteredProviderControlError(error);
    const reason = error instanceof Error ? error.message : "vision failed";
    return { ok: false, chosen: -1, flagged: false, reason: reason.slice(0, 60) };
  }

  const best = typeof res?.best === "number" ? res.best : -1;
  const modelReason = typeof res?.reason === "string" ? res.reason : undefined;
  const now = new Date().toISOString();
  if (best >= 0 && best < imgs.length) {
    // Image selection proves only that this is a useful package photo. It cannot
    // certify brand/flavor/size identity, so the donor remains pending review.
    await db.execute({ sql: `UPDATE "DonorProduct" SET mainImageUrl=?, needsReview=1, updatedAt=? WHERE id=?`, args: [urls[imgs[best].i], now, productId] });
    return { ok: true, chosen: imgs[best].i, flagged: false, reason: modelReason };
  }
  // none clean → return for rework
  await db.execute({ sql: `UPDATE "DonorProduct" SET needsReview=1, updatedAt=? WHERE id=?`, args: [now, productId] });
  return { ok: true, chosen: -1, flagged: true, reason: modelReason ?? "no clean front image" };
}

type SourceVariantIdentity = {
  input: CanonicalProductIdentity;
  brand: string;
  productLine: string | null;
  flavor: string | null;
  containerType: string | null;
  size: string;
  unitMeasure: string;
  unitAmount: number;
  outerPackCount: number;
  canonical: CanonicalProductVariantKey;
};

type ExactSourceAlias = {
  canonicalVariantId: string;
  variantDecisionId: string;
};

function joinedTokens(tokens: readonly string[]): string | null {
  return tokens.length ? tokens.join(" ") : null;
}

function canonicalModifierInput(modifierKeys: readonly string[]): string[] {
  return modifierKeys.map((key) =>
    key.startsWith("token:") ? key.slice("token:".length) : key.replace(/_/g, " "),
  );
}

function compactAmount(value: number): string {
  return Number(value.toPrecision(15)).toString();
}

/**
 * Derive the source record's own complete identity from matcher output. The
 * target is never used as package-size material: CROSS_SIZE therefore creates
 * a different source variant, while SIZE_UNKNOWN stays an unlinked candidate.
 */
function sourceVariantIdentity(offer: ScoredOffer): SourceVariantIdentity | null {
  const match = offer.identityMatch;
  if (!match || !["EXACT_IDENTITY", "CROSS_SIZE_ESTIMATE"].includes(match.verdict)) return null;
  const candidate: NormalizedCanonicalProduct = match.normalized.candidate;
  if (
    candidate.sizeStatus !== "PARSED"
    || !candidate.size
    || !candidate.brandTokens.length
    || !Number.isInteger(candidate.outerPackCount)
    || Number(candidate.outerPackCount) < 1
  ) return null;

  const brand = joinedTokens(candidate.brandTokens);
  const productLine = joinedTokens(candidate.productLineTokens);
  const flavor = joinedTokens(candidate.flavorTokens);
  const containerType = joinedTokens(candidate.formTokens);
  if (!brand || (!productLine && !flavor && !containerType)) return null;

  const size = `${compactAmount(candidate.size.amount)} ${candidate.size.unit}`;
  const input: CanonicalProductIdentity = {
    brand,
    productLine,
    flavor,
    modifiers: canonicalModifierInput(candidate.modifierKeys),
    form: containerType,
    size,
    outerPackCount: Number(candidate.outerPackCount),
  };
  try {
    return {
      input,
      brand,
      productLine,
      flavor,
      containerType,
      size,
      unitMeasure: candidate.size.unit,
      unitAmount: candidate.size.amount,
      outerPackCount: Number(candidate.outerPackCount),
      canonical: buildCanonicalProductVariantKey(input),
    };
  } catch {
    // A matcher/build-contract disagreement is uncertainty, never permission to
    // manufacture an alias from the target identity.
    return null;
  }
}

/** Pure pre-write alias preview used by exact-one sealed lanes. */
export function scoredDonorOfferCanonicalVariantId(
  offer: ScoredOffer,
): string | null {
  return sourceVariantIdentity(offer)?.canonical.canonicalVariantId ?? null;
}

function sameNullableText(actual: unknown, expected: string | null): boolean {
  return actual == null ? expected === null : String(actual) === expected;
}

async function ensureCanonicalVariant(
  db: SqlExecutor,
  canonical: CanonicalProductVariantKey,
  now: string,
): Promise<void> {
  const row = canonical.db;
  const selectStored = () => db.execute({
    sql: `SELECT id, variantKey, identityHash, keyVersion, normalizedBrand,
                 normalizedProductLine, normalizedFlavor, normalizedModifiersJson,
                 normalizedForm, sizeDimension, sizeBaseAmount, sizeBaseUnit,
                 outerPackCount, identityJson
          FROM "CanonicalProductVariant"
          WHERE id=? OR variantKey=? OR identityHash=?`,
    args: [row.id, row.variantKey, row.identityHash],
  });
  const verify = (storedRows: Awaited<ReturnType<typeof selectStored>>["rows"]): boolean => {
    if (storedRows.length !== 1) return false;
    const stored = storedRows[0];
    return String(stored.id) === row.id
      && String(stored.variantKey) === row.variantKey
      && String(stored.identityHash) === row.identityHash
      && String(stored.keyVersion) === row.keyVersion
      && String(stored.normalizedBrand) === row.normalizedBrand
      && sameNullableText(stored.normalizedProductLine, row.normalizedProductLine)
      && sameNullableText(stored.normalizedFlavor, row.normalizedFlavor)
      && String(stored.normalizedModifiersJson) === row.normalizedModifiersJson
      && sameNullableText(stored.normalizedForm, row.normalizedForm)
      && String(stored.sizeDimension) === row.sizeDimension
      && Number(stored.sizeBaseAmount) === row.sizeBaseAmount
      && String(stored.sizeBaseUnit) === row.sizeBaseUnit
      && Number(stored.outerPackCount) === row.outerPackCount
      && String(stored.identityJson) === row.identityJson;
  };
  const before = await selectStored();
  if (before.rows.length) {
    if (verify(before.rows)) return;
    throw new Error(`CANONICAL_PRODUCT_VARIANT_COLLISION: ${row.id}`);
  }
  await db.execute({
    sql: `INSERT INTO "CanonicalProductVariant"
      (id, variantKey, identityHash, keyVersion, normalizedBrand,
       normalizedProductLine, normalizedFlavor, normalizedModifiersJson,
       normalizedForm, sizeDimension, sizeBaseAmount, sizeBaseUnit,
       outerPackCount, identityJson, createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      row.id, row.variantKey, row.identityHash, row.keyVersion,
      row.normalizedBrand, row.normalizedProductLine, row.normalizedFlavor,
      row.normalizedModifiersJson, row.normalizedForm, row.sizeDimension,
      row.sizeBaseAmount, row.sizeBaseUnit, row.outerPackCount,
      row.identityJson, now,
    ],
  });
  if (!verify((await selectStored()).rows)) {
    throw new Error(`CANONICAL_PRODUCT_VARIANT_WRITE_MISMATCH: ${row.id}`);
  }
}

function sourceIdentityEvidence(input: {
  offer: ScoredOffer;
  sourceIdentity: SourceVariantIdentity;
  target: CanonicalProduct;
}): Record<string, unknown> {
  const match = input.offer.identityMatch!;
  return {
    schemaVersion: SOURCE_IDENTITY_EVIDENCE_VERSION,
    certification: "EXACT_SOURCE_IDENTITY",
    targetComparisonVerdict: match.verdict,
    matcherVersion: match.matcherVersion,
    reasonCodes: match.reasonCodes,
    titleEvidence: match.titleEvidence ?? null,
    source: {
      retailer: input.offer.retailer,
      retailerProductId: input.offer.retailerProductId,
      title: input.offer.title ?? null,
      productUrl: exactHttpUrl(input.offer.productUrl),
      sourceApi: input.offer.sourceApi,
      observedAt: input.offer.observedAt,
    },
    sourceCanonicalIdentity: input.sourceIdentity.canonical.normalized,
    target: input.target,
  };
}

async function insertRejectedAliasConflict(
  db: SqlExecutor,
  input: {
    donorProductId: string;
    proposedVariantId: string;
    existingVariantId: string | null;
    matcherVersion: string;
    evidence: Record<string, unknown>;
    decidedAt: string;
    now: string;
    runId: string | null;
    approvalId: string | null;
  },
): Promise<void> {
  const evidenceJson = stableJson({
    ...input.evidence,
    rejection: "EXACT_ALIAS_CONFLICT",
    existingCanonicalVariantId: input.existingVariantId,
    proposedCanonicalVariantId: input.proposedVariantId,
  });
  const evidenceHash = sha256(evidenceJson);
  const decisionKey = `dpvd-rejected:${evidenceHash}`;
  const readDecision = () => db.execute({
    sql: `SELECT id, decisionKey, donorProductId, canonicalVariantId,
                 decisionStatus, matcherVersion, evidenceHash, evidenceJson,
                 decidedAt, runId, approvalId
          FROM "DonorProductVariantDecision"
          WHERE id=? OR decisionKey=?`,
    args: [decisionKey, decisionKey],
  });
  const matches = (rows: Awaited<ReturnType<typeof readDecision>>["rows"]): boolean => {
    if (rows.length !== 1) return false;
    const stored = rows[0];
    return String(stored.id) === decisionKey
      && String(stored.decisionKey) === decisionKey
      && String(stored.donorProductId) === input.donorProductId
      && String(stored.canonicalVariantId) === input.proposedVariantId
      && String(stored.decisionStatus) === "rejected"
      && String(stored.matcherVersion) === input.matcherVersion
      && String(stored.evidenceHash) === evidenceHash
      && String(stored.evidenceJson) === evidenceJson
      && String(stored.decidedAt) === input.decidedAt
      && sameNullableText(stored.runId, input.runId)
      && sameNullableText(stored.approvalId, input.approvalId);
  };
  const before = await readDecision();
  if (before.rows.length && !matches(before.rows)) {
    throw new Error(`DONOR_PRODUCT_VARIANT_DECISION_COLLISION: ${decisionKey}`);
  }
  if (!before.rows.length) await db.execute({
    sql: `INSERT INTO "DonorProductVariantDecision"
      (id, decisionKey, donorProductId, canonicalVariantId, decisionStatus,
       matcherVersion, evidenceHash, evidenceJson, decidedAt, runId,
       approvalId, createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      decisionKey, decisionKey, input.donorProductId, input.proposedVariantId,
      "rejected", input.matcherVersion, evidenceHash, evidenceJson,
      input.decidedAt, input.runId, input.approvalId, input.now,
    ],
  });
  if (!matches((await readDecision()).rows)) {
    throw new Error(`DONOR_PRODUCT_VARIANT_DECISION_WRITE_MISMATCH: ${decisionKey}`);
  }
  await db.execute({
    sql: `UPDATE "DonorProduct" SET needsReview=1, updatedAt=? WHERE id=?`,
    args: [input.now, input.donorProductId],
  });
}

async function certifyExactSourceAlias(
  db: SqlExecutor,
  input: {
    donorProductId: string;
    offer: ScoredOffer;
    target: CanonicalProduct;
    sourceIdentity: SourceVariantIdentity;
    observedAt: string;
    now: string;
    runId: string | null;
    approvalId: string | null;
  },
): Promise<{ alias: ExactSourceAlias | null; conflict: boolean }> {
  const evidence = sourceIdentityEvidence({
    offer: input.offer,
    sourceIdentity: input.sourceIdentity,
    target: input.target,
  });
  const evidenceJson = stableJson(evidence);
  const evidenceHash = sha256(evidenceJson);
  const matcherVersion = input.offer.identityMatch!.matcherVersion;
  const product = (await db.execute({
    sql: `SELECT identityStatus FROM "DonorProduct" WHERE id=? LIMIT 1`,
    args: [input.donorProductId],
  })).rows[0];
  if (!product) throw new Error(`DONOR_PRODUCT_MISSING: ${input.donorProductId}`);

  const existing = (await db.execute({
    sql: `SELECT id, canonicalVariantId, matcherVersion, evidenceJson, decidedAt
          FROM "DonorProductVariantDecision"
          WHERE donorProductId=? AND decisionStatus='exact_confirmed' LIMIT 1`,
    args: [input.donorProductId],
  })).rows[0];
  if (existing && String(existing.canonicalVariantId) !== input.sourceIdentity.canonical.canonicalVariantId) {
    await insertRejectedAliasConflict(db, {
      donorProductId: input.donorProductId,
      proposedVariantId: input.sourceIdentity.canonical.canonicalVariantId,
      existingVariantId: String(existing.canonicalVariantId),
      matcherVersion,
      evidence,
      decidedAt: input.observedAt,
      now: input.now,
      runId: input.runId,
      approvalId: input.approvalId,
    });
    return { alias: null, conflict: true };
  }
  if (
    !existing
    && ["rejected", "exact_confirmed"].includes(String(product.identityStatus))
  ) {
    await insertRejectedAliasConflict(db, {
      donorProductId: input.donorProductId,
      proposedVariantId: input.sourceIdentity.canonical.canonicalVariantId,
      existingVariantId: null,
      matcherVersion,
      evidence,
      decidedAt: input.observedAt,
      now: input.now,
      runId: input.runId,
      approvalId: input.approvalId,
    });
    return { alias: null, conflict: true };
  }

  let decisionId: string;
  let projectionMatcherVersion: string;
  let projectionEvidenceJson: string;
  let projectionDecidedAt: string;
  if (existing) {
    decisionId = String(existing.id);
    projectionMatcherVersion = String(existing.matcherVersion);
    projectionEvidenceJson = String(existing.evidenceJson);
    projectionDecidedAt = String(existing.decidedAt);
  } else {
    const decisionKey = `dpvd-exact:${evidenceHash}`;
    decisionId = decisionKey;
    const readDecision = () => db.execute({
      sql: `SELECT id, decisionKey, donorProductId, canonicalVariantId,
                   decisionStatus, matcherVersion, evidenceHash, evidenceJson,
                   decidedAt, runId, approvalId
            FROM "DonorProductVariantDecision"
            WHERE id=? OR decisionKey=?`,
      args: [decisionId, decisionKey],
    });
    const matches = (rows: Awaited<ReturnType<typeof readDecision>>["rows"]): boolean => {
      if (rows.length !== 1) return false;
      const stored = rows[0];
      return String(stored.id) === decisionId
        && String(stored.decisionKey) === decisionKey
        && String(stored.donorProductId) === input.donorProductId
        && String(stored.canonicalVariantId) === input.sourceIdentity.canonical.canonicalVariantId
        && String(stored.decisionStatus) === "exact_confirmed"
        && String(stored.matcherVersion) === matcherVersion
        && String(stored.evidenceHash) === evidenceHash
        && String(stored.evidenceJson) === evidenceJson
        && String(stored.decidedAt) === input.observedAt
        && sameNullableText(stored.runId, input.runId)
        && sameNullableText(stored.approvalId, input.approvalId);
    };
    const before = await readDecision();
    if (before.rows.length && !matches(before.rows)) {
      throw new Error(`DONOR_PRODUCT_VARIANT_DECISION_COLLISION: ${decisionKey}`);
    }
    if (!before.rows.length) await db.execute({
      sql: `INSERT INTO "DonorProductVariantDecision"
        (id, decisionKey, donorProductId, canonicalVariantId, decisionStatus,
         matcherVersion, evidenceHash, evidenceJson, decidedAt, runId,
         approvalId, createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        decisionId, decisionKey, input.donorProductId,
        input.sourceIdentity.canonical.canonicalVariantId, "exact_confirmed",
        matcherVersion, evidenceHash, evidenceJson, input.observedAt,
        input.runId, input.approvalId, input.now,
      ],
    });
    if (!matches((await readDecision()).rows)) {
      throw new Error(`DONOR_PRODUCT_VARIANT_DECISION_WRITE_MISMATCH: ${decisionKey}`);
    }
    projectionMatcherVersion = matcherVersion;
    projectionEvidenceJson = evidenceJson;
    projectionDecidedAt = input.observedAt;
  }

  if (String(product.identityStatus) !== "exact_confirmed") {
    await db.execute({
      sql: `UPDATE "DonorProduct" SET
              brand=?, productLine=?, flavor=?, containerType=?, size=?,
              unitMeasure=?, unitAmount=?, identityStatus='exact_confirmed',
              identityMatcherVersion=?, identityEvidenceJson=?,
              identityConfirmedAt=?, needsReview=1, updatedAt=?
            WHERE id=? AND identityStatus IN ('candidate','legacy_unverified')`,
      args: [
        input.sourceIdentity.brand, input.sourceIdentity.productLine,
        input.sourceIdentity.flavor, input.sourceIdentity.containerType,
        input.sourceIdentity.size, input.sourceIdentity.unitMeasure,
        input.sourceIdentity.unitAmount, projectionMatcherVersion,
        projectionEvidenceJson, projectionDecidedAt, input.now,
        input.donorProductId,
      ],
    });
  }
  const confirmed = (await db.execute({
    sql: `SELECT identityStatus FROM "DonorProduct" WHERE id=? LIMIT 1`,
    args: [input.donorProductId],
  })).rows[0];
  if (String(confirmed?.identityStatus) !== "exact_confirmed") {
    throw new Error(`DONOR_PRODUCT_EXACT_PROJECTION_FAILED: ${input.donorProductId}`);
  }
  return {
    alias: {
      canonicalVariantId: input.sourceIdentity.canonical.canonicalVariantId,
      variantDecisionId: decisionId,
    },
    conflict: false,
  };
}

type ContentObservationProvenance = {
  runId: string | null;
  approvalId: string | null;
  meteredReceiptId: string | null;
};

async function appendExactContentObservation(
  db: SqlExecutor,
  input: {
    donorProductId: string;
    alias: ExactSourceAlias;
    sourceUrl: string;
    sourceApi: string;
    content: Record<string, unknown>;
    observedAt: string;
    now: string;
    provenance: ContentObservationProvenance;
  },
): Promise<string> {
  const factualFields = Object.fromEntries(
    Object.entries(input.content).filter(([key]) => !key.startsWith("_")),
  );
  const fieldHashes = Object.fromEntries(
    Object.entries(factualFields)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([field, value]) => [field, sha256(stableJson(value))]),
  );
  const contentJson = stableJson({
    ...input.content,
    _schemaVersion: PRODUCT_CONTENT_OBSERVATION_VERSION,
  });
  const fieldHashesJson = stableJson(fieldHashes);
  const contentHash = sha256(contentJson);
  const observationKey = sha256(stableJson({
    donorProductId: input.donorProductId,
    canonicalVariantId: input.alias.canonicalVariantId,
    variantDecisionId: input.alias.variantDecisionId,
    sourceUrl: input.sourceUrl,
    sourceApi: input.sourceApi,
    contentHash,
    observedAt: input.observedAt,
    ...input.provenance,
  }));
  const id = `pco:${observationKey}`;
  const readObservation = () => db.execute({
    sql: `SELECT id, observationKey, donorProductId, canonicalVariantId,
                 variantDecisionId, sourceUrl, sourceApi, contentHash,
                 fieldHashesJson, contentJson, observedAt, runId, approvalId,
                 meteredReceiptId
          FROM "ProductContentObservation"
          WHERE id=? OR observationKey=?`,
    args: [id, observationKey],
  });
  const matches = (rows: Awaited<ReturnType<typeof readObservation>>["rows"]): boolean => {
    if (rows.length !== 1) return false;
    const stored = rows[0];
    return String(stored.id) === id
      && String(stored.observationKey) === observationKey
      && String(stored.donorProductId) === input.donorProductId
      && String(stored.canonicalVariantId) === input.alias.canonicalVariantId
      && String(stored.variantDecisionId) === input.alias.variantDecisionId
      && String(stored.sourceUrl) === input.sourceUrl
      && String(stored.sourceApi) === input.sourceApi
      && String(stored.contentHash) === contentHash
      && String(stored.fieldHashesJson) === fieldHashesJson
      && String(stored.contentJson) === contentJson
      && String(stored.observedAt) === input.observedAt
      && sameNullableText(stored.runId, input.provenance.runId)
      && sameNullableText(stored.approvalId, input.provenance.approvalId)
      && sameNullableText(stored.meteredReceiptId, input.provenance.meteredReceiptId);
  };
  const before = await readObservation();
  if (before.rows.length && !matches(before.rows)) {
    throw new Error(`PRODUCT_CONTENT_OBSERVATION_COLLISION: ${observationKey}`);
  }
  if (!before.rows.length) await db.execute({
    sql: `INSERT INTO "ProductContentObservation"
      (id, observationKey, donorProductId, canonicalVariantId,
       variantDecisionId, sourceUrl, sourceApi, contentHash, fieldHashesJson,
       contentJson, observedAt, runId, approvalId, meteredReceiptId, createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, observationKey, input.donorProductId,
      input.alias.canonicalVariantId, input.alias.variantDecisionId,
      input.sourceUrl, input.sourceApi, contentHash, fieldHashesJson,
      contentJson, input.observedAt, input.provenance.runId,
      input.provenance.approvalId, input.provenance.meteredReceiptId,
      input.now,
    ],
  });
  if (!matches((await readObservation()).rows)) {
    throw new Error(`PRODUCT_CONTENT_OBSERVATION_WRITE_MISMATCH: ${observationKey}`);
  }
  return id;
}

export type CompleteExactContentSupplementalField =
  | "ingredients"
  | "nutritionFacts"
  | "allergens";

export interface ExactUpcSupplementalContentSource {
  binding: "EXACT_UPC";
  upc: string;
  sourceApi: string;
  sourceUrl: string;
  observedAt: string;
}

export interface PersistCompleteExactContentObservationInput {
  donorProductId: string;
  retailer: string;
  retailerProductId: string;
  /** Exact retailer item URL used for the captured detail response. */
  sourceUrl: string;
  sourceApi: string;
  observedAt: string;
  processingNow?: string;
  provenance?: ContentObservationProvenance;
  /** Independent identity echoed by the paid retailer-detail response. Search
   * copy cannot stand in for this proof. */
  detailIdentity: {
    title: string;
    retailerProductId: string | null;
    productUrl: string | null;
  };
  content: {
    description?: string | null;
    bullets?: string[] | null;
    attributes?: Record<string, unknown> | null;
    nutritionFacts: unknown;
    ingredients: string | null;
    /** An empty array is valid evidence that the exact source declared no allergens. */
    allergens: unknown;
    mainImageUrl?: string | null;
    imageUrls: string[];
    upc: string | null;
    category: string | null;
    storage: string | null;
  };
  /** Only exact-UPC sources may supplement these three factual fields. */
  supplementalSources?: Partial<
    Record<CompleteExactContentSupplementalField, ExactUpcSupplementalContentSource>
  >;
  /** Narrow Walmart pilot fence; generic Product Truth may contain exact multipacks. */
  requireBaseUnit?: boolean;
  /** Legacy default quarantines peers; sealed exact-one lanes must use block. */
  upcConflictPolicy?: "quarantine" | "block";
}

export interface PersistCompleteExactContentObservationResult {
  contentObservationId: string;
  donorProductId: string;
  canonicalVariantId: string;
  variantDecisionId: string;
  title: string;
  upc: string;
  imageCount: number;
  upcConflicts: number;
}

export class ExactContentSnapshotBlockedError extends Error {
  readonly code = "EXACT_CONTENT_SNAPSHOT_BLOCKED" as const;
  readonly blockers: string[];

  constructor(blockers: Iterable<string>) {
    const unique = [...new Set(blockers)].sort((left, right) =>
      left.localeCompare(right, "en-US"),
    );
    super(`Exact content snapshot blocked: ${unique.join("; ")}`);
    this.name = "ExactContentSnapshotBlockedError";
    this.blockers = unique;
  }
}

function exactHttpsUrl(value: unknown): string | null {
  const raw = nonEmptyText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function exactWalmartItemIdFromUrl(value: unknown): string | null {
  const raw = nonEmptyText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:"
      || !["walmart.com", "www.walmart.com"].includes(url.hostname.toLowerCase())
      || url.username
      || url.password
      || !parts.some((part) => part.toLowerCase() === "ip")
    ) return null;
    return parts.at(-1) ?? null;
  } catch {
    return null;
  }
}

function canonicalIdentityFromStoredVariant(
  identityJson: unknown,
  expectedCanonicalVariantId: string,
): CanonicalProductIdentity | null {
  if (typeof identityJson !== "string" || !identityJson.trim()) return null;
  try {
    const parsed = JSON.parse(identityJson) as unknown;
    if (!isUnknownRecord(parsed) || !isUnknownRecord(parsed.size)) return null;
    const brand = nonEmptyText(parsed.brand);
    const baseAmount = parsed.size.baseAmount;
    const baseUnit = parsed.size.baseUnit;
    const outerPackCount = parsed.outerPackCount;
    const modifiers = parsed.modifiers;
    if (
      !brand
      || typeof baseAmount !== "number"
      || !Number.isFinite(baseAmount)
      || baseAmount <= 0
      || !["g", "ml", "count"].includes(String(baseUnit))
      || !Number.isInteger(outerPackCount)
      || !Array.isArray(modifiers)
      || modifiers.some((modifier) => typeof modifier !== "string" || !modifier.trim())
    ) return null;
    const identity: CanonicalProductIdentity = {
      brand,
      productLine: nonEmptyText(parsed.productLine),
      flavor: nonEmptyText(parsed.flavor),
      modifiers: canonicalModifierInput(modifiers as string[]),
      form: nonEmptyText(parsed.form),
      size: `${baseAmount} ${String(baseUnit)}`,
      outerPackCount: Number(outerPackCount),
    };
    const rebuilt = buildCanonicalProductVariantKey(identity);
    return rebuilt.canonicalVariantId === expectedCanonicalVariantId
      && rebuilt.identityJson === identityJson
      ? identity
      : null;
  } catch {
    return null;
  }
}

function exactInstant(value: unknown): string | null {
  const raw = nonEmptyText(value);
  if (!raw || !/(?:z|[+-]\d{2}:\d{2})$/i.test(raw)) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function contentEvidencePresent(
  value: unknown,
  allowExplicitEmptyArray = false,
  insideStructuredEvidence = false,
): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  // A bare scalar is not a nutrition/allergen document. Numbers and booleans
  // are meaningful only as values inside a non-empty structured record (for
  // example `{ calories: 0 }` or `{ containsMilk: false }`). This prevents
  // provider sentinels such as `nutrition_facts: false` from becoming truth.
  if (typeof value === "number") return insideStructuredEvidence && Number.isFinite(value);
  if (typeof value === "boolean") return insideStructuredEvidence;
  if (Array.isArray(value)) {
    return (allowExplicitEmptyArray && value.length === 0)
      || value.some((entry) => contentEvidencePresent(entry, false, true));
  }
  return !!value
    && typeof value === "object"
    && Object.values(value as Record<string, unknown>)
      .some((entry) => contentEvidencePresent(entry, false, true));
}

function parseRecordJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Production persistence boundary for one candidate-readable content snapshot.
 * It performs no provider/network calls. The exact retailer detail response is
 * supplied by the caller, while title identity is inherited only from the same
 * immutable retailer-search observation. No price row or other donor can become
 * a content donor.
 */
export async function persistCompleteExactContentObservation(
  db: Client,
  input: PersistCompleteExactContentObservationInput,
): Promise<PersistCompleteExactContentObservationResult> {
  await assertProductTruthEvidenceSchema(db);
  const blockers: string[] = [];
  const donorProductId = nonEmptyText(input.donorProductId);
  const retailer = nonEmptyText(input.retailer)?.toLowerCase() ?? null;
  const retailerProductId = nonEmptyText(input.retailerProductId);
  const sourceUrl = exactHttpsUrl(input.sourceUrl);
  const sourceApi = nonEmptyText(input.sourceApi);
  const observedAt = exactInstant(input.observedAt);
  const processingNow = exactInstant(input.processingNow ?? new Date().toISOString());
  const provenance = input.provenance ?? {
    runId: null,
    approvalId: null,
    meteredReceiptId: null,
  };
  const runId = nonEmptyText(provenance.runId);
  const approvalId = nonEmptyText(provenance.approvalId);
  const meteredReceiptId = nonEmptyText(provenance.meteredReceiptId);
  const detailTitle = nonEmptyText(input.detailIdentity?.title);
  const detailRetailerProductId = detailIdentifier(input.detailIdentity?.retailerProductId);
  const detailProductUrl = input.detailIdentity?.productUrl == null
    ? null
    : exactHttpsUrl(input.detailIdentity.productUrl);
  const upc = normalizedManufacturerCode(input.content?.upc);
  const ingredients = nonEmptyText(input.content?.ingredients);
  const category = nonEmptyText(input.content?.category);
  const storage = nonEmptyText(input.content?.storage);
  const attributes = input.content?.attributes;

  if (!donorProductId) blockers.push("DONOR_PRODUCT_ID_REQUIRED");
  if (!retailer) blockers.push("RETAILER_REQUIRED");
  if (!retailerProductId) blockers.push("RETAILER_PRODUCT_ID_REQUIRED");
  if (!sourceUrl) blockers.push("SOURCE_URL_HTTPS_REQUIRED");
  if (!sourceApi) blockers.push("SOURCE_API_REQUIRED");
  if (!observedAt) blockers.push("OBSERVED_AT_INVALID");
  if (!processingNow) blockers.push("PROCESSING_NOW_INVALID");
  if (observedAt && processingNow && Date.parse(observedAt) > Date.parse(processingNow)) {
    blockers.push("OBSERVED_AT_AFTER_PROCESSING_NOW");
  }
  if ((runId === null) !== (approvalId === null)) {
    blockers.push("RUN_APPROVAL_PROVENANCE_INCOMPLETE");
  }
  if (meteredReceiptId && (!runId || !approvalId)) {
    blockers.push("METERED_RECEIPT_REQUIRES_RUN_APPROVAL");
  }
  if (!detailTitle) blockers.push("DETAIL_RESPONSE_TITLE_REQUIRED");
  if (!detailRetailerProductId && !detailProductUrl) {
    blockers.push("DETAIL_RESPONSE_ITEM_BINDING_REQUIRED");
  }
  if (input.detailIdentity?.productUrl != null && !detailProductUrl) {
    blockers.push("DETAIL_RESPONSE_URL_INVALID");
  }
  if (!upc) blockers.push("MANUFACTURER_UPC_MISSING_OR_INVALID");
  if (!ingredients) blockers.push("INGREDIENTS_MISSING");
  if (!contentEvidencePresent(input.content?.nutritionFacts)) {
    blockers.push("NUTRITION_MISSING");
  }
  if (!contentEvidencePresent(input.content?.allergens, true)) {
    blockers.push("ALLERGENS_MISSING");
  }
  if (!category) blockers.push("CATEGORY_MISSING");
  if (!storage) blockers.push("STORAGE_MISSING");
  if (
    attributes !== undefined
    && attributes !== null
    && (typeof attributes !== "object" || Array.isArray(attributes))
  ) {
    blockers.push("ATTRIBUTES_INVALID");
  }

  const rawImages = Array.isArray(input.content?.imageUrls)
    ? input.content.imageUrls
    : [];
  const normalizedImages = rawImages.map(exactHttpsUrl);
  if (rawImages.length === 0) blockers.push("MAIN_IMAGE_MISSING");
  if (normalizedImages.some((url) => url === null)) blockers.push("IMAGE_URL_INVALID");
  const imageUrls = Array.from(new Set(
    normalizedImages.filter((url): url is string => url !== null),
  ));
  const requestedMainImage = input.content?.mainImageUrl
    ? exactHttpsUrl(input.content.mainImageUrl)
    : imageUrls[0] ?? null;
  if (!requestedMainImage) blockers.push("MAIN_IMAGE_MISSING");
  if (input.content?.mainImageUrl && !exactHttpsUrl(input.content.mainImageUrl)) {
    blockers.push("MAIN_IMAGE_URL_INVALID");
  }
  if (requestedMainImage && !imageUrls.includes(requestedMainImage)) {
    blockers.push("MAIN_IMAGE_NOT_IN_DETAIL_GALLERY");
  }

  try {
    stableJson({
      attributes: attributes ?? {},
      nutritionFacts: input.content?.nutritionFacts,
      allergens: input.content?.allergens,
    });
  } catch {
    blockers.push("CONTENT_NOT_CANONICAL_JSON");
  }

  const supplementalSources = input.supplementalSources ?? {};
  const normalizedSupplemental = new Map<
    CompleteExactContentSupplementalField,
    ExactUpcSupplementalContentSource & { sourceUrl: string; observedAt: string; upc: string }
  >();
  for (const field of ["ingredients", "nutritionFacts", "allergens"] as const) {
    const supplemental = supplementalSources[field];
    if (!supplemental) continue;
    const supplementalUrl = exactHttpsUrl(supplemental.sourceUrl);
    const supplementalAt = exactInstant(supplemental.observedAt);
    const supplementalUpc = normalizedManufacturerCode(supplemental.upc);
    const supplementalApi = nonEmptyText(supplemental.sourceApi);
    if (supplemental.binding !== "EXACT_UPC") {
      blockers.push(`SUPPLEMENTAL_${field.toUpperCase()}_BINDING_INVALID`);
    }
    if (!supplementalUrl) blockers.push(`SUPPLEMENTAL_${field.toUpperCase()}_URL_INVALID`);
    if (!supplementalAt) blockers.push(`SUPPLEMENTAL_${field.toUpperCase()}_OBSERVED_AT_INVALID`);
    if (!supplementalApi) blockers.push(`SUPPLEMENTAL_${field.toUpperCase()}_SOURCE_API_MISSING`);
    if (!supplementalUpc || !upc || supplementalUpc !== upc) {
      blockers.push(`SUPPLEMENTAL_${field.toUpperCase()}_UPC_MISMATCH`);
    }
    if (supplementalAt && observedAt && Date.parse(supplementalAt) > Date.parse(observedAt)) {
      blockers.push(`SUPPLEMENTAL_${field.toUpperCase()}_AFTER_DETAIL_OBSERVATION`);
    }
    if (supplementalUrl && supplementalAt && supplementalUpc && supplementalApi) {
      normalizedSupplemental.set(field, {
        ...supplemental,
        sourceApi: supplementalApi,
        sourceUrl: supplementalUrl,
        observedAt: supplementalAt,
        upc: supplementalUpc,
      });
    }
  }

  if (blockers.length) throw new ExactContentSnapshotBlockedError(blockers);

  const transaction = await db.transaction("write");
  try {
    const exactSource = (await transaction.execute({
      sql: `SELECT decision.id AS variantDecisionId,
                   decision.canonicalVariantId,
                   variant.identityJson AS canonicalIdentityJson,
                   offer.productUrl AS storedProductUrl,
                   offer.packSizeSeen AS storedPackSizeSeen
            FROM "DonorProduct" product
            JOIN "DonorProductVariantDecision" decision
              ON decision.donorProductId=product.id
             AND decision.decisionStatus='exact_confirmed'
            JOIN "CanonicalProductVariant" variant
              ON variant.id=decision.canonicalVariantId
            JOIN "DonorOffer" offer
              ON offer.donorProductId=product.id
             AND offer.retailer=?
             AND offer.retailerProductId=?
             AND offer.via='direct'
             AND offer.isFirstParty=1
            WHERE product.id=? AND product.identityStatus='exact_confirmed'
              AND (offer.retailer<>'walmart' OR offer.sellerName='Walmart.com')
              AND julianday(decision.decidedAt)<=julianday(?)
              AND julianday(decision.createdAt)<=julianday(?)
            LIMIT 1`,
      args: [
        retailer!, retailerProductId!, donorProductId!, processingNow!, processingNow!,
      ],
    })).rows[0];
    if (!exactSource) {
      throw new ExactContentSnapshotBlockedError(["EXACT_SOURCE_ALIAS_MISSING"]);
    }
    const storedSourceUrl = exactHttpsUrl(exactSource.storedProductUrl);
    if (!storedSourceUrl) {
      throw new ExactContentSnapshotBlockedError(["STORED_SOURCE_URL_HTTPS_REQUIRED"]);
    }
    if (storedSourceUrl !== sourceUrl) {
      throw new ExactContentSnapshotBlockedError(["SOURCE_URL_MISMATCH"]);
    }
    if (input.requireBaseUnit === true && Number(exactSource.storedPackSizeSeen) !== 1) {
      throw new ExactContentSnapshotBlockedError(["SOURCE_ITEM_NOT_BASE_UNIT"]);
    }
    const alias: ExactSourceAlias = {
      canonicalVariantId: String(exactSource.canonicalVariantId),
      variantDecisionId: String(exactSource.variantDecisionId),
    };
    const canonicalIdentity = canonicalIdentityFromStoredVariant(
      exactSource.canonicalIdentityJson,
      alias.canonicalVariantId,
    );
    const detailIdentityBlockers: string[] = [];
    if (!canonicalIdentity) {
      detailIdentityBlockers.push("CANONICAL_VARIANT_IDENTITY_INVALID");
    } else if (
      matchCanonicalProductTitle(canonicalIdentity, { title: detailTitle }).verdict
      !== "EXACT_IDENTITY"
    ) {
      detailIdentityBlockers.push("DETAIL_RESPONSE_TITLE_IDENTITY_MISMATCH");
    }
    if (detailRetailerProductId && detailRetailerProductId !== retailerProductId) {
      detailIdentityBlockers.push("DETAIL_RESPONSE_ITEM_ID_MISMATCH");
    }
    if (detailProductUrl) {
      const responseUrlMatches = retailer === "walmart"
        ? exactWalmartItemIdFromUrl(detailProductUrl) === retailerProductId
        : detailProductUrl === storedSourceUrl;
      if (!responseUrlMatches) detailIdentityBlockers.push("DETAIL_RESPONSE_URL_MISMATCH");
    }
    if (detailIdentityBlockers.length) {
      throw new ExactContentSnapshotBlockedError(detailIdentityBlockers);
    }
    if (input.upcConflictPolicy === "block") {
      const conflicts = await transaction.execute({
        sql: `SELECT "id" FROM "DonorProduct" WHERE "upc"=? AND "id"<>? ORDER BY "id"`,
        args: [upc!, donorProductId!],
      });
      if (conflicts.rows.length > 0) {
        throw new ExactContentSnapshotBlockedError(["UPC_CONFLICT_REQUIRES_REVIEW"]);
      }
    }

    const searchRows = (await transaction.execute({
      sql: `SELECT id, observationKey, sourceUrl, sourceApi, contentHash,
                   fieldHashesJson, contentJson, observedAt
            FROM "ProductContentObservation"
            WHERE donorProductId=?
              AND canonicalVariantId=?
              AND variantDecisionId=?
              AND sourceUrl=?
              AND julianday(observedAt)<=julianday(?)
              AND julianday(createdAt)<=julianday(?)
            ORDER BY julianday(observedAt) DESC, observedAt DESC,
                     julianday(createdAt) DESC, createdAt DESC, id DESC`,
      args: [
        donorProductId!, alias.canonicalVariantId, alias.variantDecisionId,
        sourceUrl!, observedAt!, processingNow!,
      ],
    })).rows;
    const searchEvidence = searchRows
      .map((row) => {
        const content = parseRecordJson(row.contentJson);
        const fieldHashes = parseRecordJson(row.fieldHashesJson);
        const title = nonEmptyText(content?.title);
        const valid = content?._capture === "retailer_search_partial"
          && !!title
          && sha256(String(row.contentJson)) === String(row.contentHash)
          && fieldHashes?.title === sha256(stableJson(title));
        return valid ? { row, content: content!, title: title! } : null;
      })
      .find((candidate) => candidate !== null);
    if (!searchEvidence) {
      throw new ExactContentSnapshotBlockedError([
        searchRows.length
          ? "SEARCH_CONTENT_EVIDENCE_INVALID"
          : "SEARCH_CONTENT_OBSERVATION_MISSING",
      ]);
    }

    const detailFieldSource = {
      binding: "EXACT_RETAILER_ITEM",
      retailer,
      retailerProductId,
      canonicalVariantId: alias.canonicalVariantId,
      variantDecisionId: alias.variantDecisionId,
      sourceApi,
      sourceUrl,
      observedAt,
      responseIdentity: {
        title: detailTitle,
        retailerProductId: detailRetailerProductId,
        productUrl: detailProductUrl,
        matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
        verdict: "EXACT_IDENTITY",
      },
    };
    const searchFieldSource = {
      binding: "EXACT_VARIANT_SEARCH",
      canonicalVariantId: alias.canonicalVariantId,
      variantDecisionId: alias.variantDecisionId,
      observationId: String(searchEvidence.row.id),
      observationKey: String(searchEvidence.row.observationKey),
      sourceApi: String(searchEvidence.row.sourceApi),
      sourceUrl: String(searchEvidence.row.sourceUrl),
      observedAt: String(searchEvidence.row.observedAt),
    };
    const supplementalFieldSource = (field: CompleteExactContentSupplementalField) => {
      const supplemental = normalizedSupplemental.get(field);
      return supplemental
        ? {
            binding: supplemental.binding,
            upc: supplemental.upc,
            canonicalVariantId: alias.canonicalVariantId,
            variantDecisionId: alias.variantDecisionId,
            sourceApi: supplemental.sourceApi,
            sourceUrl: supplemental.sourceUrl,
            observedAt: supplemental.observedAt,
          }
        : detailFieldSource;
    };
    const detailDescription = nonEmptyText(input.content.description);
    const searchDescription = nonEmptyText(searchEvidence.content.description);
    const description = detailDescription ?? searchDescription;
    const detailBullets = Array.isArray(input.content.bullets)
      ? input.content.bullets.map(nonEmptyText).filter((value): value is string => !!value)
      : [];
    const searchBullets = Array.isArray(searchEvidence.content.bullets)
      ? searchEvidence.content.bullets.map(nonEmptyText).filter((value): value is string => !!value)
      : [];
    const bullets = detailBullets.length ? detailBullets : searchBullets;
    const fieldSources: Record<string, unknown> = {
      title: searchFieldSource,
      description: detailDescription ? detailFieldSource : searchFieldSource,
      bullets: detailBullets.length ? detailFieldSource : searchFieldSource,
      attributes: detailFieldSource,
      nutritionFacts: supplementalFieldSource("nutritionFacts"),
      ingredients: supplementalFieldSource("ingredients"),
      allergens: supplementalFieldSource("allergens"),
      mainImageUrl: detailFieldSource,
      imageUrls: detailFieldSource,
      upc: detailFieldSource,
      gtin: detailFieldSource,
      category: detailFieldSource,
      storageTemp: detailFieldSource,
    };
    const fullContent: Record<string, unknown> = {
      title: searchEvidence.title,
      description,
      bullets,
      attributes: attributes ?? {},
      nutritionFacts: input.content.nutritionFacts,
      ingredients,
      allergens: input.content.allergens,
      mainImageUrl: requestedMainImage,
      imageUrls,
      upc,
      gtin: upc,
      category,
      storageTemp: storage,
      _capture: "exact_complete_v1",
      _fieldSources: fieldSources,
    };
    const contentObservationId = await appendExactContentObservation(transaction, {
      donorProductId: donorProductId!,
      alias,
      sourceUrl: sourceUrl!,
      sourceApi: sourceApi!,
      content: fullContent,
      observedAt: observedAt!,
      now: processingNow!,
      provenance: { runId, approvalId, meteredReceiptId },
    });

    // Transitional projection is written only after immutable exact evidence is
    // sealed. Candidate/new-SKU readers above consume the observation, not this row.
    await transaction.execute({
      sql: `UPDATE "DonorProduct" SET
              title=?, description=?, bullets=?, attributes=?,
              nutritionFacts=?, ingredients=?, mainImageUrl=?, imageUrls=?,
              upc=?, needsReview=1, updatedAt=?
            WHERE id=? AND identityStatus='exact_confirmed'`,
      args: [
        searchEvidence.title, description, stableJson(bullets),
        stableJson(attributes ?? {}), stableJson(input.content.nutritionFacts),
        ingredients, requestedMainImage, stableJson(imageUrls), upc,
        processingNow!, donorProductId!,
      ],
    });
    const upcConflicts = input.upcConflictPolicy === "block"
      ? 0
      : await quarantineUpcConflicts(
        transaction,
        donorProductId!,
        upc!,
        processingNow!,
      );
    await transaction.commit();
    return {
      contentObservationId,
      donorProductId: donorProductId!,
      canonicalVariantId: alias.canonicalVariantId,
      variantDecisionId: alias.variantDecisionId,
      title: searchEvidence.title,
      upc: upc!,
      imageCount: imageUrls.length,
      upcConflicts,
    };
  } catch (error) {
    if (!transaction.closed) await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

function searchContentSnapshot(offer: ScoredOffer): Record<string, unknown> {
  const images = normImages(offer.imageUrls);
  return {
    title: offer.title ?? null,
    description: offer.description ?? null,
    bullets: [...(offer.keyFeatures || [])],
    attributes: null,
    nutritionFacts: null,
    ingredients: null,
    mainImageUrl: images[0] ?? null,
    imageUrls: images,
    upc: null,
    gtin: null,
    _capture: "retailer_search_partial",
  };
}

export interface PersistScoredDonorOfferResult {
  donorProductId: string;
  donorOfferId: string;
  productCreated: boolean;
  canonicalVariantId: string | null;
  variantDecisionId: string | null;
  aliasConflict: boolean;
  contentObservationId: string | null;
  offerObservationId: string;
}

/** Fail-closed write boundary for sealed exact-one donor lanes. */
export interface PersistScoredDonorOfferExactScope {
  donorProductId: string;
  donorOfferId: string;
  retailer: "walmart";
  retailerProductId: string;
  canonicalVariantId: string;
  /** Existing exact decision ID, or null when this call is the authorized
   * owner-attested first certification for the selected legacy donor. */
  variantDecisionId: string | null;
  canonicalVariantMustBeAbsent: boolean;
  normalizedProductUrl: string;
  expectedLegacyRows: null | {
    donorProductRowJson: string;
    donorOfferRowJson: string;
  };
}

export interface PersistScoredDonorOfferOptions {
  exactScope?: PersistScoredDonorOfferExactScope;
}

/** Offline-testable persistence boundary; performs no provider/network calls. */
export async function persistScoredDonorOffer(
  db: Client,
  offer: ScoredOffer,
  target: CanonicalProduct,
  processingNow = new Date().toISOString(),
  options: PersistScoredDonorOfferOptions = {},
): Promise<PersistScoredDonorOfferResult> {
  if (!offer.accepted || !offer.retailerProductId) {
    throw new Error("DONOR_SOURCE_OFFER_NOT_ACCEPTED");
  }
  const observedAt = offer.observedAt || processingNow;
  const permit = currentMeteredRunPermit(undefined, Date.parse(processingNow));
  const capturedReceiptId = String(offer.meteredReceiptId ?? "").trim() || null;
  const capturedRunId = String(offer.meteredRunId ?? "").trim() || null;
  const capturedApprovalId = String(offer.meteredApprovalId ?? "").trim() || null;
  const capturedParts = [capturedReceiptId, capturedRunId, capturedApprovalId]
    .filter((value) => value !== null).length;
  if (capturedParts !== 0 && capturedParts !== 3) {
    throw new Error("DONOR_SOURCE_METERED_PROVENANCE_INCOMPLETE");
  }
  if (capturedReceiptId && permit && (
    capturedRunId !== permit.runId || capturedApprovalId !== permit.approvalId
  )) {
    throw new Error("DONOR_SOURCE_METERED_PROVENANCE_PERMIT_MISMATCH");
  }
  const runId = capturedRunId ?? permit?.runId ?? null;
  const approvalId = capturedApprovalId ?? permit?.approvalId ?? null;
  const meteredReceiptId = capturedReceiptId;
  const brandHint = normalizeBrandCase(cleanBrand(target.brand));
  const parsed = parseSize(offer.title);
  const offerBrand = canonicalMultiwordBrand(offer.title)
    || brandHint
    || normalizeBrandCase(deriveBrand(offer.title))
    || null;
  const sourceIdentity = sourceVariantIdentity(offer);
  const exactScope = options.exactScope;
  if (exactScope) {
    const bootstrap = exactScope.variantDecisionId === null;
    if (
      bootstrap !== exactScope.canonicalVariantMustBeAbsent
      || (bootstrap && exactScope.expectedLegacyRows === null)
    ) {
      throw new Error("DONOR_EXACT_SCOPE_BOOTSTRAP_BINDING_INVALID");
    }
    let normalizedOfferUrl: string | null = null;
    try {
      const parsedUrl = new URL(String(offer.productUrl ?? ""));
      const parts = parsedUrl.pathname.split("/").filter(Boolean);
      const itemId = parts.at(-1) ?? "";
      normalizedOfferUrl = parsedUrl.protocol === "https:"
        && ["walmart.com", "www.walmart.com"].includes(parsedUrl.hostname.toLowerCase())
        && !parsedUrl.username
        && !parsedUrl.password
        && parts.some((part) => part.toLowerCase() === "ip")
        && itemId === exactScope.retailerProductId
        ? `https://www.walmart.com/ip/${itemId}`
        : null;
    } catch {
      normalizedOfferUrl = null;
    }
    if (
      offer.retailer !== exactScope.retailer
      || offer.retailerProductId !== exactScope.retailerProductId
      || normalizedOfferUrl !== exactScope.normalizedProductUrl
      || sourceIdentity?.canonical.canonicalVariantId !== exactScope.canonicalVariantId
      || (offer.via ?? "direct") !== "direct"
      || offer.sellerName !== "Walmart.com"
      || offer.isMarketplaceItem !== false
      || offer.sourceApi !== "oxylabs"
      || offer.zip !== "33765"
      || offer.localityEvidence !== "zip_scoped"
      || offer.inStock !== true
      || offer.packSizeSeen !== 1
      || offer.isBaseUnit !== true
      || offer.currency !== "USD"
      || typeof offer.price !== "number"
      || !Number.isFinite(offer.price)
      || offer.price <= 0
      || !capturedReceiptId
      || !capturedRunId
      || !capturedApprovalId
      || !permit
    ) {
      throw new Error("DONOR_EXACT_SCOPE_SOURCE_MISMATCH");
    }
  }
  const sourceSize = sourceIdentity?.size ?? parsed.size;
  const proposedIdentityKey = computeIdentityKey({
    brand: offerBrand,
    title: offer.title,
    size: sourceSize,
  });

  const transaction = await db.transaction("write");
  try {
    const existingOffer = (await transaction.execute({
      sql: `SELECT *
            FROM "DonorOffer"
            WHERE retailer=? AND retailerProductId=? LIMIT 1`,
      args: [offer.retailer, offer.retailerProductId],
    })).rows[0];
    let normalizedExistingUrl: string | null = null;
    try {
      const parsedUrl = new URL(String(existingOffer?.productUrl ?? ""));
      const itemId = parsedUrl.pathname.split("/").filter(Boolean).at(-1) ?? "";
      normalizedExistingUrl = parsedUrl.protocol === "https:"
        && ["walmart.com", "www.walmart.com"].includes(parsedUrl.hostname.toLowerCase())
        && !parsedUrl.username
        && !parsedUrl.password
        && parsedUrl.pathname.split("/").some((part) => part.toLowerCase() === "ip")
        && itemId === exactScope?.retailerProductId
        ? `https://www.walmart.com/ip/${itemId}`
        : null;
    } catch {
      normalizedExistingUrl = null;
    }
    if (exactScope && (
      !existingOffer
      || String(existingOffer.id) !== exactScope.donorOfferId
      || String(existingOffer.donorProductId) !== exactScope.donorProductId
      || String(existingOffer.retailer) !== exactScope.retailer
      || String(existingOffer.retailerProductId) !== exactScope.retailerProductId
      || String(existingOffer.via) !== "direct"
      || Number(existingOffer.isFirstParty) !== 1
      || String(existingOffer.sellerName) !== "Walmart.com"
      || Number(existingOffer.packSizeSeen) !== 1
      || normalizedExistingUrl !== exactScope.normalizedProductUrl
    )) {
      throw new Error("DONOR_EXACT_SCOPE_EXISTING_ALIAS_MISMATCH");
    }
    if (exactScope) {
      const existingProduct = (await transaction.execute({
        sql: `SELECT * FROM "DonorProduct" WHERE id=?`,
        args: [exactScope.donorProductId],
      })).rows;
      const canonicalDbRowJson = (row: Record<string, unknown>): string => stableJson(
        Object.fromEntries(Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "bigint"
            ? Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
            : value,
        ])),
      );
      if (
        existingProduct.length !== 1
        || (exactScope.expectedLegacyRows !== null && (
          canonicalDbRowJson(existingProduct[0] as Record<string, unknown>)
            !== stableJson(JSON.parse(exactScope.expectedLegacyRows.donorProductRowJson))
          || canonicalDbRowJson(existingOffer as Record<string, unknown>)
            !== stableJson(JSON.parse(exactScope.expectedLegacyRows.donorOfferRowJson))
        ))
      ) {
        throw new Error("DONOR_EXACT_SCOPE_SEALED_ROW_BYTES_MISMATCH");
      }
      const variants = await transaction.execute({
        sql: `SELECT id FROM "CanonicalProductVariant"
              WHERE id=? OR variantKey=? OR identityHash=?`,
        args: [
          exactScope.canonicalVariantId,
          exactScope.canonicalVariantId,
          exactScope.canonicalVariantId.replace(/^cpv1:/, ""),
        ],
      });
      if (
        (exactScope.canonicalVariantMustBeAbsent && variants.rows.length !== 0)
        || (!exactScope.canonicalVariantMustBeAbsent && variants.rows.length !== 1)
      ) {
        throw new Error("DONOR_EXACT_SCOPE_CANONICAL_VARIANT_STATE_MISMATCH");
      }
      const decisions = await transaction.execute({
        sql: `SELECT id,canonicalVariantId,decisionStatus
              FROM "DonorProductVariantDecision" WHERE donorProductId=? ORDER BY id`,
        args: [exactScope.donorProductId],
      });
      if (exactScope.variantDecisionId === null) {
        if (decisions.rows.length !== 0) {
          throw new Error("DONOR_EXACT_SCOPE_BOOTSTRAP_DECISION_NOT_ABSENT");
        }
      } else if (
        decisions.rows.length !== 1
        || String(decisions.rows[0]?.id) !== exactScope.variantDecisionId
        || String(decisions.rows[0]?.canonicalVariantId) !== exactScope.canonicalVariantId
        || String(decisions.rows[0]?.decisionStatus) !== "exact_confirmed"
      ) {
        throw new Error("DONOR_EXACT_SCOPE_EXISTING_DECISION_MISMATCH");
      }
    }
    let donorProductId: string;
    let productCreated = false;
    if (existingOffer) {
      donorProductId = String(existingOffer.donorProductId);
    } else {
      donorProductId = crypto.randomUUID();
      const candidateIdentityKey = `${proposedIdentityKey}|candidate:${offer.retailer}:${offer.retailerProductId}`;
      const temperature = classifyTemperature({
        title: offer.title,
        description: offer.description,
        bullets: offer.keyFeatures,
      });
      // Staging is deliberate: the DB trigger forbids direct exact inserts.
      // The immutable decision is inserted below before this projection moves.
      await transaction.execute({
        sql: `INSERT INTO "DonorProduct"
          (id, brand, title, size, unitMeasure, unitAmount, category,
           mainImageUrl, imageUrls, identityKey, productLine, flavor,
           containerType, identityStatus, identityMatcherVersion,
           identityEvidenceJson, identityConfirmedAt, needsReview,
           createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'candidate',NULL,NULL,NULL,?,?,?)`,
        args: [
          donorProductId, sourceIdentity?.brand ?? offerBrand,
          offer.title ?? null, sourceSize,
          sourceIdentity?.unitMeasure ?? parsed.unitMeasure,
          sourceIdentity?.unitAmount ?? parsed.unitAmount,
          temperature, (offer.imageUrls || [])[0] ?? null,
          JSON.stringify(offer.imageUrls || []), candidateIdentityKey,
          sourceIdentity?.productLine ?? null, sourceIdentity?.flavor ?? null,
          sourceIdentity?.containerType ?? null, 1, processingNow,
          processingNow,
        ],
      });
      productCreated = true;
    }

    let alias: ExactSourceAlias | null = null;
    let aliasConflict = false;
    if (sourceIdentity) {
      await ensureCanonicalVariant(transaction, sourceIdentity.canonical, processingNow);
      const certification = await certifyExactSourceAlias(transaction, {
        donorProductId,
        offer,
        target,
        sourceIdentity,
        observedAt,
        now: processingNow,
        runId,
        approvalId,
      });
      alias = certification.alias;
      aliasConflict = certification.conflict;
    }

    const via: "direct" | "instacart" = offer.via === "instacart" ? "instacart" : "direct";
    const realPack = offer.packSizeSeen ?? 1;
    const divisor = CLUB_RETAILERS.has(offer.retailer) ? 1 : realPack;
    let pricePerUnit = offer.price != null
      ? Math.round((offer.price / (divisor || 1)) * 100) / 100
      : null;
    if (via === "instacart" && pricePerUnit != null) {
      pricePerUnit = Math.round((pricePerUnit / INSTACART_MARKUP) * 100) / 100;
    }

    let donorOfferId: string;
    if (aliasConflict && existingOffer) {
      // A changed retailer item must not rewrite the current materialized offer
      // under the old exact alias. Its new immutable observation is unlinked.
      donorOfferId = String(existingOffer.id);
    } else if (existingOffer) {
      if (
        String(existingOffer.donorProductId) !== donorProductId
        || String(existingOffer.retailer) !== offer.retailer
        || String(existingOffer.retailerProductId) !== offer.retailerProductId
        || String(existingOffer.via) !== via
      ) {
        throw new Error(`DONOR_OFFER_SOURCE_IDENTITY_CONFLICT: ${String(existingOffer.id)}`);
      }
      const offerWrite = await transaction.execute({
        sql: `UPDATE "DonorOffer" SET
                price=?, packSizeSeen=?, pricePerUnit=?, currency=?, zip=?,
                localityEvidence=?, inStock=?, productUrl=?, sellerName=?,
                isFirstParty=?, sourceApi=?, fetchedAt=?, updatedAt=?
              WHERE id=? AND donorProductId=?
              RETURNING id, donorProductId`,
        args: [
          offer.price ?? null, realPack, pricePerUnit, offer.currency || "USD",
          offer.zip, offer.localityEvidence,
          offer.inStock === null ? null : offer.inStock ? 1 : 0,
          offer.productUrl ?? null, offer.sellerName ?? null, 1,
          offer.sourceApi ?? null, observedAt, processingNow,
          String(existingOffer.id), donorProductId,
        ],
      });
      const materialized = offerWrite.rows[0];
      donorOfferId = String(materialized?.id || "");
      if (!donorOfferId || String(materialized?.donorProductId) !== donorProductId) {
        throw new Error(`DONOR_OFFER_WRITE_MISMATCH: ${String(existingOffer.id)}`);
      }
    } else {
      const offerWrite = await transaction.execute({
        sql: `INSERT INTO "DonorOffer"
          (id, donorProductId, retailer, retailerProductId, via, price,
           packSizeSeen, pricePerUnit, currency, zip, localityEvidence,
           inStock, productUrl, sellerName, isFirstParty, sourceApi, fetchedAt,
           createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          RETURNING id, donorProductId`,
        args: [
          `do:${offer.retailer}:${offer.retailerProductId}`, donorProductId,
          offer.retailer, offer.retailerProductId, via, offer.price ?? null,
          realPack, pricePerUnit, offer.currency || "USD", offer.zip,
          offer.localityEvidence,
          offer.inStock === null ? null : offer.inStock ? 1 : 0,
          offer.productUrl ?? null, offer.sellerName ?? null, 1,
          offer.sourceApi ?? null, observedAt, processingNow, processingNow,
        ],
      });
      const materialized = offerWrite.rows[0];
      donorOfferId = String(materialized?.id || "");
      if (!donorOfferId) throw new Error("DONOR_OFFER_WRITE_MISSING_ID");
      if (String(materialized?.donorProductId) !== donorProductId) {
        throw new Error(`DONOR_OFFER_SOURCE_IDENTITY_IMMUTABLE: ${donorOfferId}`);
      }
    }

    const observationPayload = stableJson({
      donorProductId,
      canonicalVariantId: alias?.canonicalVariantId ?? null,
      variantDecisionId: alias?.variantDecisionId ?? null,
      retailer: offer.retailer,
      retailerProductId: offer.retailerProductId,
      via,
      title: offer.title ?? null,
      price: offer.price ?? null,
      packSizeSeen: realPack,
      pricePerUnit,
      currency: offer.currency || "USD",
      zip: offer.zip,
      localityEvidence: offer.localityEvidence,
      inStock: offer.inStock,
      productUrl: offer.productUrl,
      sellerName: offer.sellerName,
      sourceApi: offer.sourceApi,
      observedAt,
      meteredReceiptId,
    });
    const offerObservationHash = sha256(observationPayload);
    const offerObservationId = `doo:${offerObservationHash}`;
    const observedStock = offer.inStock === null ? null : offer.inStock ? 1 : 0;
    const readOfferObservation = () => transaction.execute({
      sql: `SELECT id, observationKey, donorOfferId, donorProductId,
                   canonicalVariantId, variantDecisionId, retailer,
                   retailerProductId, via, title, price, packSizeSeen,
                   pricePerUnit, currency, zip, localityEvidence, inStock,
                   productUrl, sellerName, isFirstParty, sourceApi, observedAt,
                   runId, approvalId, meteredReceiptId
            FROM "DonorOfferObservation"
            WHERE id=? OR observationKey=?`,
      args: [offerObservationId, offerObservationHash],
    });
    const offerObservationMatches = (
      rows: Awaited<ReturnType<typeof readOfferObservation>>["rows"],
    ): boolean => {
      if (rows.length !== 1) return false;
      const stored = rows[0];
      const sameNumber = (actual: unknown, expected: number | null) =>
        actual == null ? expected === null : expected !== null && Number(actual) === expected;
      return String(stored.id) === offerObservationId
        && String(stored.observationKey) === offerObservationHash
        && String(stored.donorOfferId) === donorOfferId
        && String(stored.donorProductId) === donorProductId
        && sameNullableText(stored.canonicalVariantId, alias?.canonicalVariantId ?? null)
        && sameNullableText(stored.variantDecisionId, alias?.variantDecisionId ?? null)
        && String(stored.retailer) === offer.retailer
        && String(stored.retailerProductId) === offer.retailerProductId
        && String(stored.via) === via
        && sameNullableText(stored.title, offer.title ?? null)
        && sameNumber(stored.price, offer.price ?? null)
        && sameNumber(stored.packSizeSeen, realPack)
        && sameNumber(stored.pricePerUnit, pricePerUnit)
        && String(stored.currency) === (offer.currency || "USD")
        && sameNullableText(stored.zip, offer.zip)
        && sameNullableText(stored.localityEvidence, offer.localityEvidence)
        && sameNumber(stored.inStock, observedStock)
        && sameNullableText(stored.productUrl, offer.productUrl)
        && sameNullableText(stored.sellerName, offer.sellerName)
        && Number(stored.isFirstParty) === 1
        && sameNullableText(stored.sourceApi, offer.sourceApi ?? null)
        && String(stored.observedAt) === observedAt
        && sameNullableText(stored.runId, runId)
        && sameNullableText(stored.approvalId, approvalId)
        && sameNullableText(stored.meteredReceiptId, meteredReceiptId);
    };
    const priorOfferObservation = await readOfferObservation();
    if (priorOfferObservation.rows.length && !offerObservationMatches(priorOfferObservation.rows)) {
      throw new Error(`DONOR_OFFER_OBSERVATION_COLLISION: ${offerObservationHash}`);
    }
    if (!priorOfferObservation.rows.length) await transaction.execute({
      sql: `INSERT INTO "DonorOfferObservation"
        (id, observationKey, donorOfferId, donorProductId,
         canonicalVariantId, variantDecisionId, retailer, retailerProductId,
         via, title, price, packSizeSeen, pricePerUnit, currency, zip,
         localityEvidence, inStock, productUrl, sellerName, isFirstParty,
         sourceApi, observedAt, runId, approvalId, meteredReceiptId, createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        offerObservationId, offerObservationHash, donorOfferId, donorProductId,
        alias?.canonicalVariantId ?? null, alias?.variantDecisionId ?? null,
        offer.retailer, offer.retailerProductId, via, offer.title ?? null,
        offer.price ?? null, realPack, pricePerUnit, offer.currency || "USD",
        offer.zip, offer.localityEvidence,
        observedStock,
        offer.productUrl ?? null, offer.sellerName ?? null, 1,
        offer.sourceApi ?? null, observedAt, runId, approvalId,
        meteredReceiptId,
        processingNow,
      ],
    });
    if (!offerObservationMatches((await readOfferObservation()).rows)) {
      throw new Error(`DONOR_OFFER_OBSERVATION_WRITE_MISMATCH: ${offerObservationHash}`);
    }

    let contentObservationId: string | null = null;
    const sourceUrl = exactHttpUrl(offer.productUrl);
    const sourceApi = String(offer.sourceApi ?? "").trim();
    if (alias && sourceUrl && sourceApi) {
      contentObservationId = await appendExactContentObservation(transaction, {
        donorProductId,
        alias,
        sourceUrl,
        sourceApi,
        content: searchContentSnapshot(offer),
        observedAt,
        now: processingNow,
        provenance: { runId, approvalId, meteredReceiptId },
      });
    }
    if (alias && !aliasConflict) {
      await rollupProduct(transaction, donorProductId, processingNow);
    }
    const result: PersistScoredDonorOfferResult = {
      donorProductId,
      donorOfferId,
      productCreated,
      canonicalVariantId: alias?.canonicalVariantId ?? null,
      variantDecisionId: alias?.variantDecisionId ?? null,
      aliasConflict,
      contentObservationId,
      offerObservationId,
    };
    if (exactScope && (
      result.productCreated
      || result.aliasConflict
      || result.donorProductId !== exactScope.donorProductId
      || result.donorOfferId !== exactScope.donorOfferId
      || result.canonicalVariantId !== exactScope.canonicalVariantId
      || !result.variantDecisionId
      || (
        exactScope.variantDecisionId !== null
        && result.variantDecisionId !== exactScope.variantDecisionId
      )
    )) {
      throw new Error("DONOR_EXACT_SCOPE_POST_WRITE_MISMATCH");
    }
    await transaction.commit();
    return result;
  } catch (error) {
    if (!transaction.closed) await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

export interface EnrichTargetResult {
  query: string;
  retailersHit: string[];
  productsCreated: number;
  offersUpserted: number;
  rejected: number;
  creditsRemaining: number | null;
  createdProductIds: string[]; // freshly-created products → harvest them right away
  sourceAttempts: {
    source: string;
    /** Transport succeeded, but price/stock locality was not proven. */
    status: "completed" | "content_only" | "unavailable" | "failed";
    detail?: string;
  }[];
}

// Enrich the catalog for one target (brand or free-text query). Searches only the
// explicitly routed live sources, gates each offer, and upserts the survivors.
// BlueCart is unavailable and has no route here; Unwrangle retailers run only when
// `unwrangleRetailers` is passed by an owner-budgeted caller.
export async function enrichTarget(
  db: Client,
  opts: { target: string; brand?: string | null; zip?: string | null; unwrangleRetailers?: ("walmart" | "target" | "samsclub" | "costco")[]; oxylabsRetailers?: OxylabsRetailer[]; openClawRetailers?: OpenClawRetailer[]; allowNonGrocery?: boolean; canonicalProduct?: CanonicalProduct; matchSpec?: { brandToks: string[]; tokens: string[]; sizeAmount?: number | null } },
): Promise<EnrichTargetResult> {
  // Code may deploy before its additive Turso migration. Never spend on a
  // retailer observation that cannot be preserved with locality/provenance.
  await assertProductTruthEvidenceSchema(db);
  await assertProductTruthMeteredEvidenceSchema(db);
  const cp: CanonicalProduct = opts.canonicalProduct || {
    brand: (opts.brand || opts.target.split(/\s+/).slice(0, 2).join(" ")) || undefined,
  };
  const evaluationNow = new Date().toISOString();

  // A tier "hits" ONLY when it returns an offer that TIGHTLY matches the product —
  // the same brand+variant test the cost readback (cheapestCostForTarget) applies.
  // Before this, a loose QA-accepted near-miss (Target's "Jimmy Dean DELIGHTS Turkey
  // Sausage" for our "English Muffin Sausage Egg & Cheese") short-circuited the
  // escalation, so Publix — which HAS the frozen item at $7.75 — was never asked, and
  // the strict cost match then rejected the near-miss → a false UNSOURCEABLE. Frozen
  // (never sold 1P online) was the biggest victim.
  // The predicate MUST mirror what the cost readback will accept, or a tier "hits" on
  // an offer the cost step later rejects → escalation stopped for nothing → false
  // UNSOURCEABLE. Cost needs: accepted + FIRST-PARTY + brand + variant tokens + a size
  // within the cross-size band (0.25x–4x). Frozen was the biggest victim: a same-brand
  // Walmart near-miss stopped the walk before Publix (which stocks it).
  const strictHit = (scored: ScoredOffer[]): boolean => {
    return scored.some((o) => {
      if (!o.accepted) return false;
      if (!o.identityMatch || o.identityMatch.verdict === "REJECT") return false;
      return evaluatePriceEvidenceEligibility({
        retailer: o.retailer,
        via: o.via || "direct",
        price: o.price,
        isFirstParty: o.isMarketplaceItem === false ? true : null,
        inStock: o.inStock,
        zip: o.zip,
        localityEvidence: o.localityEvidence,
        fetchedAt: o.observedAt,
        matchVerdict: o.identityMatch.verdict,
      }, { now: evaluationNow, maxAgeMs: 48 * 60 * 60 * 1000 }).eligibility !== "REJECT";
    });
  };
  const now = evaluationNow;
  const retailersHit: string[] = [];
  const createdProductIds: string[] = [];
  const sourceAttempts: EnrichTargetResult["sourceAttempts"] = [];
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
    if (ox.trialExhausted) {
      sourceAttempts.push({ source: "oxylabs:walmart", status: "unavailable", detail: "trial exhausted" });
    } else if (ox.localityProven) {
      sourceAttempts.push({
        source: "oxylabs:walmart",
        status: "completed",
        detail: `ZIP_SCOPED:${ox.responseZip}`,
      });
    } else {
      sourceAttempts.push({
        source: "oxylabs:walmart",
        status: "content_only",
        detail: ox.responseZip
          ? `LOCALITY_PROOF_MISMATCH: requested 33765, response ${ox.responseZip}`
          : "LOCALITY_PROOF_UNAVAILABLE: response did not confirm ZIP 33765",
      });
    }
    if (!ox.trialExhausted && ox.offers.length) {
      const scored = ox.offers.map((o) => scoreOffer(o, cp));
      retailersHit.push("walmart");
      batches.push({ offers: scored });
      // Covered ONLY if Walmart returned a TIGHTLY-MATCHING accepted 1P offer. A 3P-only
      // listing (incl our own STARFITSTORE) or a near-miss variant → NOT covered →
      // escalate to Target/Publix where the real shelf price is.
      if (strictHit(scored)) walmartCovered = true;
    }
  } catch (error) {
    throwIfMeteredProviderControlError(error);
    sourceAttempts.push({ source: "oxylabs:walmart", status: "failed", detail: String(error).slice(0, 160) });
    /* Oxylabs unavailable — escalation below */
  }
  // ESCALATION — only when Walmart 1P MISSED (cheapest-first, stop-on-hit). This is
  // what stops us fanning out to every paid service on every SKU (the fan-out that
  // burned 100k Unwrangle credits). Route order follows source-capabilities PRICE_TIERS.
  if (!walmartCovered) {
    let escalationHit = false;
    const uwList = (opts.unwrangleRetailers ?? []).filter((r) => r !== "walmart"); // Oxylabs owns Walmart 1P
    // "hit" = a retailer returned a USABLE (accepted, 1P) offer. A tier returning only
    // 3P junk must NOT block the next tier (Target 3P must not skip Publix).
    const runUnwrangle = async (r: "target" | "samsclub" | "costco") => {
      try {
        const uw = await unwrangleSearch(r, opts.target);
        if (uw.trialExhausted) {
          sourceAttempts.push({ source: `unwrangle:${r}`, status: "unavailable", detail: "trial exhausted" });
        } else {
          sourceAttempts.push({
            source: `unwrangle:${r}`,
            status: "content_only",
            detail: "LOCALITY_PROOF_UNAVAILABLE: retailer search is not ZIP/store scoped",
          });
          if (uw.creditsRemaining != null) creditsRemaining = uw.creditsRemaining;
          if (uw.offers.length) {
            const scored = uw.offers.map((o) => scoreOffer(o, cp));
            if (!retailersHit.includes(r)) retailersHit.push(r);
            batches.push({ offers: scored });
            if (strictHit(scored)) escalationHit = true;
          }
        }
      } catch (error) {
        throwIfMeteredProviderControlError(error);
        sourceAttempts.push({ source: `unwrangle:${r}`, status: "failed", detail: String(error).slice(0, 160) });
        /* skip this retailer on source error */
      }
    };
    // CHEAPEST-FIRST tiers. Tier 2: Target (Unwrangle, 1 credit).
    if (uwList.includes("target")) await runUnwrangle("target");
    // Tier 3: Publix / BJ's (browser → Instacart, ~free) — local grocers, BEFORE the
    // expensive clubs. Where much of the not-online-1P grocery actually lives.
    if (!escalationHit && openClawEnabled()) {
      for (const r of opts.openClawRetailers ?? []) {
        try {
          const oc = await openClawSearch(r, opts.target, opts.zip ?? "33765");
          if (oc.trialExhausted) sourceAttempts.push({ source: `openclaw:${r}`, status: "unavailable", detail: "source unavailable" });
          else sourceAttempts.push({ source: `openclaw:${r}`, status: "completed" });
          if (!oc.trialExhausted && oc.offers.length) { const scored = oc.offers.map((o) => scoreOffer(o, cp)); if (!retailersHit.includes(r)) retailersHit.push(r); batches.push({ offers: scored }); if (strictHit(scored)) escalationHit = true; }
        } catch (error) {
          throwIfMeteredProviderControlError(error);
          sourceAttempts.push({ source: `openclaw:${r}`, status: "failed", detail: String(error).slice(0, 160) });
          /* skip this source on error */
        }
      }
    } else if (!escalationHit) {
      for (const r of opts.openClawRetailers ?? []) {
        sourceAttempts.push({ source: `openclaw:${r}`, status: "unavailable", detail: "source disabled" });
      }
    }
    // Tier 4: Sam's / Costco (Unwrangle, 10 credits EACH) — only if nothing cheaper hit.
    if (!escalationHit) for (const r of uwList) { if (!escalationHit && (r === "samsclub" || r === "costco")) await runUnwrangle(r); }
    // Tier 5: Oxylabs open-site retailers (rarely wired) — last.
    if (!escalationHit && oxylabsEnabled()) {
      for (const r of opts.oxylabsRetailers ?? []) {
        try {
          const ox = await oxylabsSearch(r, opts.target);
          if (ox.trialExhausted) sourceAttempts.push({ source: `oxylabs:${r}`, status: "unavailable", detail: "trial exhausted" });
          else sourceAttempts.push({
            source: `oxylabs:${r}`,
            status: "content_only",
            detail: "LOCALITY_PROOF_UNAVAILABLE: retailer search is not ZIP/store scoped",
          });
          if (!ox.trialExhausted && ox.offers.length) { if (!retailersHit.includes(r)) retailersHit.push(r); batches.push({ offers: ox.offers.map((o) => scoreOffer(o, cp)) }); }
        } catch (error) {
          throwIfMeteredProviderControlError(error);
          sourceAttempts.push({ source: `oxylabs:${r}`, status: "failed", detail: String(error).slice(0, 160) });
          /* skip this source on error */
        }
      }
    } else if (!escalationHit && (opts.oxylabsRetailers ?? []).length) {
      for (const r of opts.oxylabsRetailers ?? []) {
        sourceAttempts.push({ source: `oxylabs:${r}`, status: "unavailable", detail: "source disabled" });
      }
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
    if (!opts.allowNonGrocery && looksNonGrocery(o.title)) { rejected++; continue; }
    candidates.push(o);
  }
  // Non-grocery allowed (household/cleaning resale niche) → skip the grocery judge; the
  // tight brand+size cost match downstream keeps unrelated junk out anyway.
  let survivors = candidates;
  if (!opts.allowNonGrocery) {
    const verdicts = await classifyGroceryTitles(candidates.map((o) => o.title || ""));
    survivors = candidates.filter((_, i) => verdicts[i]);
  }
  rejected += candidates.length - survivors.length;

  for (const o of survivors) {
    if (["unwrangle", "bluecart", "oxylabs", "oxylabs-google"].includes(o.sourceApi)) {
      if (!o.meteredReceiptId || !o.meteredRunId || !o.meteredApprovalId) {
        throw new Error(`METERED_SOURCE_RECEIPT_REQUIRED: ${o.sourceApi}`);
      }
    }
    const persisted = await persistScoredDonorOffer(db, o, cp, now);
    if (persisted.productCreated) {
      productsCreated++;
      createdProductIds.push(persisted.donorProductId);
    }
    offersUpserted++;
  }

  return { query: opts.target, retailersHit, productsCreated, offersUpserted, rejected, creditsRemaining, createdProductIds, sourceAttempts };
}

// Roll the cheapest CLEAN first-party DIRECT offer up to the product (bestPrice +
// $/measure) so the Reference Catalog table can sort/filter without a join.
async function rollupProduct(db: SqlExecutor, productId: string, now: string) {
  const prod = await db.execute({
    sql: `SELECT product.unitAmount, product.identityStatus,
                 decision.canonicalVariantId
          FROM "DonorProduct" product
          JOIN "DonorProductVariantDecision" decision
            ON decision.donorProductId=product.id
           AND decision.decisionStatus='exact_confirmed'
          WHERE product.id=? LIMIT 1`,
    args: [productId],
  });
  if (prod.rows[0]?.identityStatus !== "exact_confirmed") return;
  const offers = await db.execute({
    sql: `SELECT retailer, pricePerUnit, isFirstParty, via, inStock, zip,
                 localityEvidence, fetchedAt
          FROM "DonorOffer" WHERE donorProductId=?`,
    args: [productId],
  });
  const clean = offers.rows.flatMap((row) => {
    const pricePerUnit = typeof row.pricePerUnit === "number"
      ? row.pricePerUnit
      : null;
    const retailer = typeof row.retailer === "string" ? row.retailer : null;
    const via = typeof row.via === "string" ? row.via : null;
    const zip = typeof row.zip === "string" ? row.zip : null;
    const localityEvidence = typeof row.localityEvidence === "string"
      ? row.localityEvidence
      : null;
    const fetchedAt = typeof row.fetchedAt === "string" ? row.fetchedAt : null;
    const inStock = row.inStock === 1
      ? true
      : row.inStock === 0 ? false : null;
    const eligibility = evaluatePriceEvidenceEligibility({
      retailer,
      via,
      price: pricePerUnit,
      isFirstParty: row.isFirstParty === 1,
      inStock,
      zip,
      localityEvidence,
      fetchedAt,
      matchVerdict: "EXACT_IDENTITY",
    }, { now, maxAgeMs: 48 * 60 * 60 * 1000 }).eligibility;
    return eligibility === "FACT" && pricePerUnit !== null
      ? [{ retailer, pricePerUnit }]
      : [];
  });
  if (!clean.length) {
    await db.execute({
      sql: `UPDATE "DonorProduct" SET bestPrice=NULL, bestRetailer=NULL, pricePerMeasure=NULL, updatedAt=? WHERE id=?`,
      args: [now, productId],
    });
    return;
  }
  clean.sort((a, b) => a.pricePerUnit - b.pricePerUnit);
  const best = clean[0];
  const unitAmount = (prod.rows[0]?.unitAmount as number | null) ?? null;
  const ppm = unitAmount && best.pricePerUnit ? Math.round((best.pricePerUnit / unitAmount) * 1000) / 1000 : null;
  await db.execute({
    sql: `UPDATE "DonorProduct" SET bestPrice=?, bestRetailer=?, pricePerMeasure=?, updatedAt=? WHERE id=?`,
    args: [best.pricePerUnit, best.retailer, ppm, now, productId],
  });
}
