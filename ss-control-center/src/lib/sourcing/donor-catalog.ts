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
  const w = title.trim().split(/\s+/)[0]?.replace(/[^A-Za-z0-9'&.-]/g, "");
  return w && w.length >= 2 ? w : null;
}

// Remove products left with zero offers (legacy duplicate artifacts from the old
// query-derived identityKey). Safe to call anytime.
export async function cleanupOrphans(db: Client): Promise<number> {
  const r = await db.execute(`DELETE FROM "DonorProduct" WHERE id NOT IN (SELECT DISTINCT donorProductId FROM "DonorOffer" WHERE donorProductId IS NOT NULL)`);
  return r.rowsAffected || 0;
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

  for (const b of batches) {
    for (const o of b.offers) {
      if (!o.accepted) { rejected++; continue; }
      if (!o.retailerProductId) continue;
      const { size, unitMeasure, unitAmount } = parseSize(o.title);
      const offerBrand = deriveBrand(o.title) || cp.brand || null;
      const identityKey = computeIdentityKey({ brand: offerBrand, title: o.title, size });

      // Resolve the product WITHOUT orphaning: if this exact offer already exists,
      // keep it with its current product (never move an offer between products).
      // Otherwise match by identityKey; otherwise create a new product.
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
