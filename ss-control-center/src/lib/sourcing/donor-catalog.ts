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

// Brand derived from the OFFER's OWN title (stable regardless of which search
// query surfaced it). Using the job's target as brand made the same real item
// dedup differently per query ("Maruchan" vs "Maruchan Instant") → duplicates +
// orphaned offers. First title token, original case.
export function deriveBrand(title?: string | null): string | null {
  if (!title) return null;
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
      model: "claude-haiku-4-5-20251001",
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

const stripHtml = (s?: string | null) => (s ? String(s).replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : null);

export interface HarvestResult { ok: boolean; productId: string; images: number; upc: string | null; hasIngredients: boolean; merged: number; imageFlagged?: boolean; reason?: string }

// PHASE 3 — full content harvest for ONE product (1 BlueCart credit). Pulls the
// full BlueCart product detail (gallery ≥5 incl the nutrition-label image, bullets,
// description, ingredients, specifications, UPC) and writes it onto DonorProduct.
// Selective by design — call only for products we'll actually use, not all N.
export async function harvestDonorDetail(db: Client, productId: string): Promise<HarvestResult> {
  const key = process.env.BLUECART_API_KEY;
  if (!key) return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "no bluecart key" };
  const off = await db.execute({ sql: `SELECT retailerProductId FROM "DonorOffer" WHERE donorProductId=? AND retailer='walmart' AND retailerProductId IS NOT NULL LIMIT 1`, args: [productId] });
  const itemId = off.rows[0]?.retailerProductId as string | undefined;
  if (!itemId) return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: "no walmart offer to detail" };

  let j: any;
  try {
    const res = await fetch(`https://api.bluecartapi.com/request?api_key=${key}&type=product&item_id=${encodeURIComponent(itemId)}&walmart_domain=walmart.com`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: `http ${res.status}` };
    j = await res.json();
  } catch (e: any) { return { ok: false, productId, images: 0, upc: null, hasIngredients: false, merged: 0, reason: String(e?.message || "fetch failed").slice(0, 60) }; }

  const p = j?.product || {};
  const raw: string[] = [p.main_image, ...(p.images || []).map((x: any) => (typeof x === "string" ? x : x?.link))].filter((u: any) => typeof u === "string" && u.startsWith("http"));
  const seen = new Set<string>(); const images: string[] = [];
  for (const u of raw) { if (!seen.has(u)) { seen.add(u); images.push(u); } }
  const bullets: string[] = Array.isArray(p.feature_bullets) ? p.feature_bullets.map((b: any) => String(b).trim()).filter(Boolean) : [];
  const description = stripHtml(p.description_full_html || p.description_full || p.description);
  const ingredients = typeof p.ingredients === "string" ? p.ingredients : (p.ingredients ? JSON.stringify(p.ingredients) : null);
  const specifications = Array.isArray(p.specifications) ? p.specifications : null;
  // BlueCart has no structured nutrition field — the label is a gallery image; we
  // keep nutrition-ish specs + ingredients as the textual record.
  const nutrition = p.nutrition_facts ? JSON.stringify(p.nutrition_facts)
    : (specifications ? JSON.stringify(specifications.filter((s: any) => /nutri|serving|calorie|sodium|fat|protein|carb/i.test(JSON.stringify(s)))) : null);
  const upc: string | null = p.upc || p.gtin || (Array.isArray(p.gtins) ? p.gtins[0] : null) || null;
  const now = new Date().toISOString();

  await db.execute({
    sql: `UPDATE "DonorProduct" SET mainImageUrl=COALESCE(?, mainImageUrl), imageUrls=?, bullets=?,
            description=COALESCE(NULLIF(?,''), description), ingredients=COALESCE(?, ingredients),
            nutritionFacts=COALESCE(?, nutritionFacts), attributes=?, upc=COALESCE(?, upc),
            needsReview=0, updatedAt=? WHERE id=?`,
    args: [images[0] ?? null, JSON.stringify(images), JSON.stringify(bullets), description, ingredients, nutrition,
      specifications ? JSON.stringify(specifications) : null, upc, now, productId],
  });

  // UPC is the strong cross-retailer key: fold any other product with the same UPC
  // (a per-retailer duplicate) into this one, then drop the emptied dup.
  let merged = 0;
  if (upc) merged = await mergeByUpc(db, productId, upc, now);

  // Image QC ("Qual"): pick the cleanest front shot, or flag for rework.
  let imageFlagged = false;
  try { const qc = await qcProductImage(db, productId); imageFlagged = qc.flagged; } catch { /* best-effort */ }

  return { ok: true, productId, images: images.length, upc, hasIngredients: !!ingredients, merged, imageFlagged };
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
  // Calibrated: the product's OWN packaging/label is expected and fine — reject
  // ONLY composites, multipacks, or banners/stamps ADDED on top of the photo.
  const prompt = `These ${imgs.length} images (indexes 0..${imgs.length - 1}, in order) are photos of ONE grocery product. Choose the index of the best CATALOG THUMBNAIL: a clear shot of a SINGLE unit with its own packaging facing the camera. The product's OWN label/branding is expected and totally fine. Reject an image ONLY if it is a collage/grid of several photos, shows MULTIPLE units / a multipack, or has promotional banners or price stamps ADDED on top of the photo. A plain single-unit front shot is ideal; if several qualify, pick the cleanest. Return ONLY JSON {"best": <index, or -1 ONLY if every image is a collage/multipack/overlay>, "reason": "short"}.`;
  let res: any;
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });
    const content: any[] = imgs.map((x) => ({ type: "image", source: { type: "base64", media_type: mediaType(x.b64), data: x.b64 } }));
    content.push({ type: "text", text: prompt });
    const r = await client.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content }] });
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
}

// Enrich the catalog for one target (brand or free-text query). Searches the
// retailers whose paid service is live, gates each offer, and upserts the survivors
// into DonorProduct/DonorOffer. BlueCart=Walmart is always on; Unwrangle retailers
// run only when `unwrangleRetailers` is passed (i.e. when that sub is paid).
export async function enrichTarget(
  db: Client,
  opts: { target: string; brand?: string | null; zip?: string | null; unwrangleRetailers?: ("target" | "samsclub" | "costco")[] },
): Promise<EnrichTargetResult> {
  const cp: CanonicalProduct = { brand: (opts.brand || opts.target.split(/\s+/).slice(0, 2).join(" ")) || undefined };
  const now = new Date().toISOString();
  const retailersHit: string[] = [];
  let productsCreated = 0, offersUpserted = 0, rejected = 0;
  let creditsRemaining: number | null = null;

  // Collect (sourceApi, scoredOffers) from every live retailer.
  const batches: { offers: ScoredOffer[] }[] = [];
  try {
    const bc = await bluecartWalmartSearch(opts.target);
    creditsRemaining = bc.creditsRemaining;
    if (!bc.trialExhausted) { retailersHit.push("walmart"); batches.push({ offers: bc.offers.map((o) => scoreOffer(o, cp)) }); }
  } catch { /* skip walmart on error */ }

  for (const r of opts.unwrangleRetailers ?? []) {
    try {
      const uw = await unwrangleSearch(r, opts.target);
      if (!uw.trialExhausted) { retailersHit.push(r); batches.push({ offers: uw.offers.map((o) => scoreOffer(o, cp)) }); }
    } catch { /* skip this retailer on error */ }
  }

  // QA "qualification dept": tier-1 deterministic non-grocery reject (free) +
  // tier-2 batched LLM grocery judge (1 cheap Haiku call). Only survivors are
  // written — keeps books / batteries / laundry out of the catalog.
  const candidates: ScoredOffer[] = [];
  for (const b of batches) for (const o of b.offers) {
    if (!o.accepted) { rejected++; continue; }
    if (!o.retailerProductId) continue;
    if (looksNonGrocery(o.title)) { rejected++; continue; }
    candidates.push(o);
  }
  const verdicts = await classifyGroceryTitles(candidates.map((o) => o.title || ""));
  const survivors = candidates.filter((_, i) => verdicts[i]);
  rejected += candidates.length - survivors.length;

  const brandHint = cleanBrand(cp.brand);
  for (const o of survivors) {
    const { size, unitMeasure, unitAmount } = parseSize(o.title);
    const offerBrand = brandHint || deriveBrand(o.title) || null;
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
        await db.execute({
          sql: `INSERT INTO "DonorProduct" (id, brand, title, size, unitMeasure, unitAmount, mainImageUrl, imageUrls, identityKey, createdAt, updatedAt)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          args: [productId, offerBrand, o.title ?? null, size, unitMeasure, unitAmount, (o.imageUrls || [])[0] ?? null, JSON.stringify(o.imageUrls || []), identityKey, now, now],
        });
        productsCreated++;
      }
    }

    const pack = o.packSizeSeen ?? 1;
    const perUnit = o.price != null ? Math.round((o.price / (pack || 1)) * 100) / 100 : null;
    await db.execute({
      sql: `INSERT INTO "DonorOffer" (id, donorProductId, retailer, retailerProductId, via, price, packSizeSeen, pricePerUnit, currency, zip, inStock, productUrl, sellerName, isFirstParty, sourceApi, fetchedAt, createdAt, updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(retailer, retailerProductId) DO UPDATE SET
              donorProductId=excluded.donorProductId, price=excluded.price, packSizeSeen=excluded.packSizeSeen,
              pricePerUnit=excluded.pricePerUnit, inStock=excluded.inStock, productUrl=excluded.productUrl,
              sellerName=excluded.sellerName, isFirstParty=excluded.isFirstParty, fetchedAt=excluded.fetchedAt, updatedAt=excluded.updatedAt`,
      args: [
        `do:${o.retailer}:${o.retailerProductId}`, productId, o.retailer, o.retailerProductId, "direct",
        o.price ?? null, pack, perUnit, o.currency || "USD", opts.zip ?? null,
        o.inStock === null ? null : o.inStock ? 1 : 0, o.productUrl ?? null, o.sellerName ?? null, 1, o.sourceApi ?? null, now, now, now,
      ],
    });
    offersUpserted++;
    await rollupProduct(db, productId, now);
  }

  return { query: opts.target, retailersHit, productsCreated, offersUpserted, rejected, creditsRemaining };
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
