// On-demand catalog enrichment — the bridge from the Listing Optimizer to the
// Product Sourcing Engine. When the optimizer needs a clean donor product photo
// for a SKU and our catalog (RetailPrice) doesn't have one, it calls here: we
// hit BlueCart (Walmart data) by UPC, and persist every offer to RetailPrice in
// the exact shape the multipack pipeline reads. One BlueCart credit per miss.

import type { Client } from "@libsql/client";
import { bluecartWalmartSearch } from "./retail-fetch";

export interface EnrichResult { found: boolean; alreadyHad: boolean; creditsRemaining: number | null; offers: number; reason?: string; }

/** Ensure a bluecart donor image exists in RetailPrice for `sku`. No-op (and no
 *  credit spent) if one already exists. */
export async function ensureDonorImage(db: Client, opts: { sku: string; upc?: string | null; title?: string | null }): Promise<EnrichResult> {
  const have = await db.execute({
    sql: `SELECT 1 FROM RetailPrice WHERE sku=? AND sourceApi='bluecart' AND imageUrls IS NOT NULL AND imageUrls!='' LIMIT 1`,
    args: [opts.sku],
  });
  if (have.rows.length) return { found: true, alreadyHad: true, creditsRemaining: null, offers: 0 };

  // BlueCart search works on TITLE (UPC search returns nothing for these items).
  const title = String(opts.title || "").trim();
  const query = title || String(opts.upc || "").trim();
  if (!query) return { found: false, alreadyHad: false, creditsRemaining: null, offers: 0, reason: "no upc/title to search" };

  const res = await bluecartWalmartSearch(query);
  if (res.trialExhausted) return { found: false, alreadyHad: false, creditsRemaining: 0, offers: 0, reason: "bluecart credits exhausted" };

  // Keep only offers that plausibly match this product (share the first two
  // title tokens, e.g. the brand) — title search returns many loosely-related
  // items, and we must not tile an unrelated product's photo. Fall back to all
  // if the filter leaves nothing.
  const toks = title.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 2);
  const matches = toks.length
    ? res.offers.filter((o) => { const t = (o.title || "").toLowerCase(); return toks.every((tk) => t.includes(tk)); })
    : res.offers;
  const offers = matches.length ? matches : res.offers;

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
        `rp:${o.retailer}:${o.retailerProductId}`, opts.sku, opts.upc ?? null, o.retailer, o.retailerProductId,
        o.price, o.currency, o.inStock === null ? null : o.inStock ? 1 : 0, o.productUrl, o.title,
        o.description, JSON.stringify(o.keyFeatures || []), JSON.stringify(imgs), null,
        packSeen, packSeen <= 1 ? 1 : 0, packSeen > 1 ? 1 : 0, "bluecart",
        "ondemand", 0.5, now, now, now,
      ],
    });
    inserted++;
  }
  return { found, alreadyHad: false, creditsRemaining: res.creditsRemaining, offers: inserted, reason: found ? undefined : "no usable image in results" };
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
