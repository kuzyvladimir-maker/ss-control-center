// On-demand catalog enrichment — the bridge from the Listing Optimizer to the
// Product Sourcing Engine. When the optimizer needs a clean donor product photo
// for a SKU and our catalog (RetailPrice) doesn't have one, it calls here: we
// hit BlueCart (Walmart data) by UPC, and persist every offer to RetailPrice in
// the exact shape the multipack pipeline reads. One BlueCart credit per miss.

import type { Client } from "@libsql/client";
import { bluecartWalmartSearch, unwrangleSearch, isOwnOrReseller, type RetailOffer } from "./retail-fetch";
import { normUrl, htmlToText, liItems } from "../walmart/multipack/donor";

export interface DetailResult { title: string; images: string[]; bullets: string[]; description: string; }

/**
 * Knowledge-base capture: pull the FULL BlueCart product detail (gallery, bullets,
 * full description, specifications, ingredients, raw blob) and persist it to the
 * RetailPrice row. ONE detail call (1 credit) that both feeds the listing content
 * and permanently enriches our catalog. Returns the content for the caller's feed.
 *
 * Note: BlueCart has no structured nutrition_facts field — the nutrition label is
 * usually one of the gallery images, and `ingredients`/`specifications` carry the
 * rest. We store everything in `detailJson` so nothing is lost.
 */
export async function fetchAndStoreDetail(db: Client, sku: string, itemId: string): Promise<DetailResult | null> {
  const key = process.env.BLUECART_API_KEY;
  if (!key || !itemId) return null;

  // Already captured this product's detail? Reconstruct from our DB — no paid
  // call (critical for re-runs over thousands of listings).
  try {
    const cached = await db.execute({ sql: `SELECT imageUrls, keyFeatures, description FROM RetailPrice WHERE retailer='walmart' AND retailerProductId=? AND detailJson IS NOT NULL LIMIT 1`, args: [itemId] });
    if (cached.rows.length) {
      const r: any = cached.rows[0];
      let images: string[] = []; try { images = JSON.parse(r.imageUrls || "[]"); } catch {}
      let bullets: string[] = []; try { bullets = JSON.parse(r.keyFeatures || "[]"); } catch {}
      return { title: "", images, bullets, description: r.description || "" };
    }
  } catch {}
  let j: any;
  try {
    const res = await fetch(`https://api.bluecartapi.com/request?api_key=${key}&type=product&item_id=${encodeURIComponent(itemId)}&walmart_domain=walmart.com`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    j = await res.json();
  } catch { return null; }
  const p = j?.product || {};
  if (!p || (!p.main_image && !(p.images || []).length)) return null;

  const raw: string[] = [p.main_image, ...(p.images || []).map((x: any) => (typeof x === "string" ? x : x?.link))]
    .filter((u): u is string => typeof u === "string" && u.startsWith("http"));
  const seen = new Set<string>(); const images: string[] = [];
  for (const u of raw) { const n = normUrl(u); if (!seen.has(n)) { seen.add(n); images.push(n); } }

  let bullets: string[] = Array.isArray(p.feature_bullets) ? p.feature_bullets.map((b: any) => String(b).trim()).filter(Boolean) : [];
  if (!bullets.length) bullets = liItems(p.description || "");
  const description = htmlToText(p.description_full_html || p.description_full || p.description || "");
  const specifications = Array.isArray(p.specifications) ? p.specifications : null;
  const ingredients = typeof p.ingredients === "string" ? p.ingredients : (p.ingredients ? JSON.stringify(p.ingredients) : null);
  const now = new Date().toISOString();

  try {
    await db.execute({
      sql: `UPDATE RetailPrice SET imageUrls=?, keyFeatures=?, description=COALESCE(NULLIF(?,''),description), specifications=?, ingredients=?, detailJson=?, detailCapturedAt=?, updatedAt=?
            WHERE retailer='walmart' AND retailerProductId=?`,
      args: [JSON.stringify(images), JSON.stringify(bullets), description, specifications ? JSON.stringify(specifications) : null, ingredients, JSON.stringify(p).slice(0, 60000), now, now, itemId],
    });
  } catch { /* keep going — feed still works from the returned data */ }

  return { title: p.title || "", images, bullets, description };
}

export interface EnrichResult { found: boolean; alreadyHad: boolean; creditsRemaining: number | null; offers: number; reason?: string; }

/** Persist a batch of retailer offers to RetailPrice (the shape the multipack
 *  pipeline reads). Preserves each offer's own retailer/sourceApi so the pool
 *  query can surface Target/Sam's/Costco photos too, not just BlueCart. */
async function storeOffers(db: Client, sku: string, upc: string | null | undefined, offers: RetailOffer[], matchMethod: string): Promise<{ inserted: number; found: boolean }> {
  const now = new Date().toISOString();
  let inserted = 0, found = false;
  for (const o of offers) {
    if (!o.retailerProductId) continue;
    const imgs = (o.imageUrls || []).filter((u) => typeof u === "string" && u.startsWith("http"));
    if (imgs.length) found = true;
    const packSeen = o.packSizeSeen ?? 1;
    await db.execute({
      sql: `INSERT INTO "RetailPrice"
        (id, sku, upc, retailer, retailerProductId, price, currency, inStock, productUrl, title,
         description, keyFeatures, imageUrls, zip, packSizeSeen, isBaseUnit, unitMismatch,
         sourceApi, matchMethod, confidence, fetchedAt, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(retailer, retailerProductId) DO UPDATE SET
          sku=excluded.sku, price=excluded.price, inStock=excluded.inStock, productUrl=excluded.productUrl,
          title=excluded.title, description=excluded.description, keyFeatures=excluded.keyFeatures,
          imageUrls=excluded.imageUrls, packSizeSeen=excluded.packSizeSeen, sourceApi=excluded.sourceApi,
          confidence=excluded.confidence, fetchedAt=excluded.fetchedAt, updatedAt=excluded.updatedAt`,
      args: [
        `rp:${o.retailer}:${o.retailerProductId}`, sku, upc ?? null, o.retailer, o.retailerProductId,
        o.price, o.currency, o.inStock === null ? null : o.inStock ? 1 : 0, o.productUrl, o.title,
        o.description, JSON.stringify(o.keyFeatures || []), JSON.stringify(imgs), null,
        packSeen, packSeen <= 1 ? 1 : 0, packSeen > 1 ? 1 : 0, o.sourceApi || "bluecart",
        matchMethod, 0.5, now, now, now,
      ],
    });
    inserted++;
  }
  return { inserted, found };
}

/** Ensure a donor image exists in RetailPrice for `sku`. No-op (no credit spent)
 *  if one already exists. Tries BlueCart (Walmart 1P) FIRST, then falls back to
 *  the other paid retailers (Target → Sam's → Costco via Unwrangle) so a product
 *  BlueCart doesn't index still gets a real photo (Vladimir Step 3, 2026-06-30). */
export async function ensureDonorImage(db: Client, opts: { sku: string; upc?: string | null; title?: string | null }): Promise<EnrichResult> {
  // Already have a usable donor image from ANY source? Then we're done.
  const have = await db.execute({
    sql: `SELECT 1 FROM RetailPrice WHERE sku=? AND imageUrls IS NOT NULL AND imageUrls!='' AND imageUrls!='[]' LIMIT 1`,
    args: [opts.sku],
  });
  if (have.rows.length) return { found: true, alreadyHad: true, creditsRemaining: null, offers: 0 };

  const title = String(opts.title || "").trim();
  const query = title || String(opts.upc || "").trim();
  if (!query) return { found: false, alreadyHad: false, creditsRemaining: null, offers: 0, reason: "no upc/title to search" };

  // Brand/title token gate — search returns loosely-related items; we must not
  // tile an unrelated product. Fall back to all if the filter leaves nothing.
  const toks = title.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 2);
  const gate = (offers: RetailOffer[]) => {
    // FIRST-PARTY ONLY (Vladimir's rule #8): the card must be sold by the retailer
    // ITSELF, never a third-party reseller or one of our own storefronts — their
    // photos are often repackaged bundles or our own bad listing. HARD filter.
    // (Target/Sam's/Costco via Unwrangle are the retailer's own catalog → 1P.)
    const fp = offers.filter((o) => o.isMarketplaceItem !== true && !isOwnOrReseller(o.sellerName));
    if (!toks.length) return fp;
    const m = fp.filter((o) => { const t = (o.title || "").toLowerCase(); return toks.every((tk) => t.includes(tk)); });
    return m.length ? m : fp;
  };

  let creditsRemaining: number | null = null;

  // 1) BlueCart (Walmart 1P) — cheapest, first.
  try {
    const res = await bluecartWalmartSearch(query);
    creditsRemaining = res.creditsRemaining;
    if (!res.trialExhausted) {
      const { inserted, found } = await storeOffers(db, opts.sku, opts.upc, gate(res.offers), "ondemand");
      if (found) return { found: true, alreadyHad: false, creditsRemaining, offers: inserted };
    }
  } catch { /* fall through to other retailers */ }

  // 2) Fallback — other paid retailers (Target / Sam's / Costco) via Unwrangle.
  //    Stops at the first that yields a usable photo.
  for (const retailer of ["target", "samsclub", "costco"] as const) {
    try {
      const res = await unwrangleSearch(retailer, query);
      if (res.trialExhausted) continue;
      const { inserted, found } = await storeOffers(db, opts.sku, opts.upc, gate(res.offers), `ondemand-${retailer}`);
      if (found) return { found: true, alreadyHad: false, creditsRemaining, offers: inserted, reason: `via ${retailer}` };
    } catch { /* try next retailer */ }
  }

  return { found: false, alreadyHad: false, creditsRemaining, offers: 0, reason: "no usable image on walmart/target/sams/costco" };
}

/** Live BlueCart credits (free /account endpoint). Used as a budget guard before
 *  spending credits on a batch of enrichments. */
export async function bluecartCreditsRemaining(): Promise<number | null> {
  const key = process.env.BLUECART_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`https://api.bluecartapi.com/account?api_key=${key}`, { signal: AbortSignal.timeout(10000) });
    const j: any = await r.json();
    return j?.account_info?.credits_remaining ?? null;
  } catch { return null; }
}
