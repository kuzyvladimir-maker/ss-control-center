// Product Sourcing Engine — pilot enrichment run (OUR engine, OUR DB).
// For each pilot SKU: take the brain's canonical identity (Stage A) → fetch price +
// content + images from MULTIPLE retailers (Stage B: BlueCart Walmart, Unwrangle
// Target/Sam's/Costco) → store EVERY offer in RetailPrice (multi-offer per SKU, with
// the gate verdict) → pick the cheapest clean base unit as the COGS source (SkuCost).
//
//   npx tsx scripts/cogs-enrich-pilot.ts            # default = 13 brain-identified SKUs
//   npx tsx scripts/cogs-enrich-pilot.ts SKU ...    # explicit SKUs
//   npx tsx scripts/cogs-enrich-pilot.ts --no-unwrangle   # Walmart-only (save trial credits)
//
// Stays within FREE trial credits: when a service reports trial exhaustion it is
// skipped for the rest of the run (those cells are flagged, not charged).
// Writes a snapshot → ../docs/sourcing/pilot-enriched.json for the Google Sheet export.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  bluecartWalmartSearch, unwrangleSearch, scoreOffer,
  type CanonicalProduct, type ScoredOffer,
} from "@/lib/sourcing/retail-fetch";

const DEFAULT_POOL = [
  "FaisalX-1241", "FaisalX-1229", "RizwanX-4597", "RizwanX-2168", "RizwanX-199",
  "FaisalX-1646", "FaisalX-1215", "FaisalX-1121", "FaisalX-1142", "FaisalX-1268",
  "FaisalX-3743", "FaisalX-1244", "RizwanX-3877",
];
const argv = process.argv.slice(2);
const NO_UNWRANGLE = argv.includes("--no-unwrangle");
const SKUS = argv.filter((a) => !a.startsWith("--"));
const POOL = SKUS.length ? SKUS : DEFAULT_POOL;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const now = new Date().toISOString();
  const eff = now.slice(0, 10);
  let unwrangleDead = NO_UNWRANGLE;
  const snapshot: any[] = [];

  for (const sku of POOL) {
    const row = await db.execute({
      sql: `SELECT productTitle, category, productIdentity, unitsInListing, baseUnitDesc FROM SkuShippingData WHERE sku=? LIMIT 1`,
      args: [sku],
    });
    if (!row.rows.length) { console.log(`\n❌ ${sku}: not in SkuShippingData`); continue; }
    const r0 = row.rows[0] as any;
    let ident: any = {};
    try { ident = r0.productIdentity ? JSON.parse(r0.productIdentity as string) : {}; } catch { /* */ }
    const cp: CanonicalProduct = {
      brand: ident.brand, product_line: ident.product_line, flavor: ident.flavor,
      size: ident.size, retail_search_query: ident.retail_search_query, base_unit: ident.base_unit,
    };
    const query = cp.retail_search_query || cp.base_unit || (r0.productTitle as string) || sku;
    const unitsInListing = (r0.unitsInListing as number) ?? ident.units_in_listing ?? 1;
    const category = (r0.category as string) || null;
    const isBundle = !!ident.is_bundle || (Array.isArray(ident.components) && ident.components.length > 0);

    console.log(`\n=== ${sku} ===  "${query}"`);
    if (!cp.brand) console.log(`  ⚠️ no brain identity — using raw title`);

    // --- Stage B: fetch across retailers (within free credits) ---
    const scored: ScoredOffer[] = [];
    const creditNote: string[] = [];

    try {
      const bc = await bluecartWalmartSearch(query);
      if (bc.trialExhausted) creditNote.push("bluecart:exhausted");
      else creditNote.push(`bluecart:${bc.creditsRemaining}`);
      for (const o of bc.offers) scored.push(scoreOffer(o, cp));
    } catch (e: any) { creditNote.push(`bluecart:ERR ${String(e.message).slice(0, 40)}`); }
    await sleep(300);

    if (!unwrangleDead) {
      for (const ret of ["target", "samsclub", "costco"] as const) {
        try {
          const uw = await unwrangleSearch(ret, query);
          if (uw.trialExhausted) { unwrangleDead = true; creditNote.push(`unwrangle:exhausted@${ret}`); break; }
          creditNote.push(`uw-${ret}:${uw.creditsRemaining}`);
          for (const o of uw.offers.slice(0, 5)) scored.push(scoreOffer(o, cp));
        } catch (e: any) { creditNote.push(`uw-${ret}:ERR ${String(e.message).slice(0, 30)}`); }
        await sleep(300);
      }
    }

    // --- persist EVERY offer to RetailPrice (multi-offer; verdict encoded in matchMethod) ---
    for (const o of scored) {
      if (!o.retailerProductId) continue;
      const unitMismatch = (o.packSizeSeen ?? 1) > 1;
      await db.execute({
        sql: `INSERT INTO "RetailPrice"
          (id, sku, upc, retailer, retailerProductId, price, currency, inStock, productUrl, title,
           description, keyFeatures, imageUrls, zip, packSizeSeen, isBaseUnit, unitMismatch,
           sourceApi, matchMethod, confidence, fetchedAt, createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(retailer, retailerProductId) DO UPDATE SET
            sku=excluded.sku, price=excluded.price, inStock=excluded.inStock, productUrl=excluded.productUrl,
            title=excluded.title, description=excluded.description, keyFeatures=excluded.keyFeatures,
            imageUrls=excluded.imageUrls, packSizeSeen=excluded.packSizeSeen, isBaseUnit=excluded.isBaseUnit,
            unitMismatch=excluded.unitMismatch, sourceApi=excluded.sourceApi, matchMethod=excluded.matchMethod,
            confidence=excluded.confidence, fetchedAt=excluded.fetchedAt, updatedAt=excluded.updatedAt`,
        args: [
          `rp:${o.retailer}:${o.retailerProductId}`, sku, null, o.retailer, o.retailerProductId,
          o.price, o.currency, o.inStock === null ? null : o.inStock ? 1 : 0, o.productUrl, o.title,
          o.description, JSON.stringify(o.keyFeatures || []), JSON.stringify(o.imageUrls || []), null,
          o.packSizeSeen, o.isBaseUnit ? 1 : 0, unitMismatch ? 1 : 0, o.sourceApi,
          o.accepted ? "title" : `rejected:${o.rejectReason}`, o.accepted ? (ident.confidence ?? null) : 0,
          now, now, now,
        ],
      });
    }

    // --- pick winner: cheapest ACCEPTED base unit; else cheapest accepted (any pack) ---
    const accepted = scored.filter((o) => o.accepted && o.price !== null);
    const bases = accepted.filter((o) => o.isBaseUnit);
    const pickFrom = bases.length ? bases : accepted;
    const winner = pickFrom.sort((a, b) => (a.price! - b.price!))[0] || null;

    let costNote = "";
    if (winner) {
      const perUnit = winner.isBaseUnit ? winner.price! : winner.price! / (winner.packSizeSeen || 1);
      const frozen = category === "Frozen";
      await db.execute({
        sql: `INSERT INTO "SkuCost"
          (id, sku, effectiveDate, productCost, totalCost, costPerUnit, packSize, includesPackaging,
           currency, source, confidence, needsReview, notes, createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(sku, source, effectiveDate) DO UPDATE SET
            productCost=excluded.productCost, totalCost=excluded.totalCost, costPerUnit=excluded.costPerUnit,
            packSize=excluded.packSize, confidence=excluded.confidence, needsReview=excluded.needsReview,
            notes=excluded.notes, updatedAt=excluded.updatedAt`,
        args: [
          `retail:${sku}:${winner.sourceApi}:${eff}`, sku, eff, perUnit, perUnit, perUnit, 1, 0, winner.currency,
          `retail:${winner.sourceApi}`, ident.confidence ?? null, frozen ? 1 : 0,
          `${winner.retailer} base @ $${winner.price}${frozen ? " (FROZEN: add cooler+ice)" : ""}`.slice(0, 180),
          now, now,
        ],
      });
      costNote = `→ COGS $${perUnit.toFixed(2)}/unit from ${winner.retailer} (${winner.sellerName || "1P"})`;
    } else {
      costNote = `→ NO clean base-unit price (needsReview)`;
    }

    const rejected = scored.filter((o) => !o.accepted);
    console.log(`  offers: ${scored.length} (accepted ${accepted.length}, rejected ${rejected.length}) | ${creditNote.join(" ")}`);
    if (rejected.length) console.log(`  rejects: ${[...new Set(rejected.map((o) => o.rejectReason))].slice(0, 4).join(" · ")}`);
    console.log(`  ${costNote}`);

    snapshot.push({
      sku, query, category, brand: cp.brand, product_line: cp.product_line, flavor: cp.flavor,
      size: cp.size, units_in_listing: unitsInListing, is_bundle: isBundle,
      offers: scored.map((o) => ({
        retailer: o.retailer, seller: o.sellerName, price: o.price, pack: o.packSizeSeen,
        accepted: o.accepted, reason: o.rejectReason, url: o.productUrl,
      })),
      winner: winner ? { retailer: winner.retailer, price: winner.price, perUnit: winner.isBaseUnit ? winner.price : winner.price! / (winner.packSizeSeen || 1) } : null,
    });
  }

  mkdirSync("../docs/sourcing", { recursive: true });
  writeFileSync("../docs/sourcing/pilot-enriched.json", JSON.stringify(snapshot, null, 2));
  const got = snapshot.filter((s) => s.winner).length;
  console.log(`\n✅ Pilot done. ${got}/${POOL.length} got a clean base-unit price. Snapshot → ../docs/sourcing/pilot-enriched.json`);
})();
