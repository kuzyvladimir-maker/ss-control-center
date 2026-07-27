// Ingest retail price/content findings from the sourcing engine (Jackie's
// services) into RetailPrice, and feed base-unit prices into SkuCost as the
// product cost. Jackie drops results as a JSON array on his box; we scp it
// local and run this:
//
//   set -a; . ./.env; . ./.env.local; set +a;  (or dotenv-loaded below)
//   npx tsx scripts/cogs-ingest-retail.ts <results.json> [--dry-run]
//
// Record shape (agreed write-back payload):
//   { sku, upc, retailer, retailer_product_id, price, currency, in_stock,
//     product_url, title, description, key_features[], image_urls[], zip,
//     pack_size_seen, is_base_unit, unit_mismatch, source_api, match_method,
//     confidence, fetched_at }

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

throw new Error("LEGACY_COGS_MUTATION_SCRIPT_DISABLED: unversioned RetailPrice/SkuCost upserts are forbidden");

const FILE = process.argv[2];
const DRY = process.argv.includes("--dry-run");
if (!FILE) { console.error("usage: cogs-ingest-retail.ts <results.json> [--dry-run]"); process.exit(1); }

const J = (v: any) => (v === undefined || v === null ? null : JSON.stringify(v));
const num = (v: any) => (v === undefined || v === null || v === "" ? null : Number(v));

(async () => {
  const recs: any[] = JSON.parse(readFileSync(FILE, "utf8"));
  console.log(`Records: ${recs.length}${DRY ? " (DRY RUN)" : ""}`);
  const c = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const now = new Date().toISOString();
  let priced = 0, baseUnits = 0, costUpserts = 0;

  for (const r of recs) {
    const retailer = String(r.retailer ?? "").toLowerCase();
    const rpid = String(r.retailer_product_id ?? r.retailerProductId ?? "");
    if (!retailer || !rpid) continue;
    const price = num(r.price);
    const packSize = num(r.pack_size_seen ?? r.packSizeSeen);
    const isBase = r.is_base_unit ?? r.isBaseUnit ?? (packSize === 1 ? true : null);
    const unitMismatch = !!(r.unit_mismatch ?? r.unitMismatch ?? (packSize && packSize > 1));
    if (price !== null) priced++;
    if (isBase) baseUnits++;

    if (!DRY) {
      await c.execute({
        sql: `INSERT INTO "RetailPrice"
          (id, sku, upc, retailer, retailerProductId, price, currency, inStock, productUrl, title,
           description, keyFeatures, imageUrls, zip, packSizeSeen, isBaseUnit, unitMismatch,
           sourceApi, matchMethod, confidence, fetchedAt, createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(retailer, retailerProductId) DO UPDATE SET
            sku=excluded.sku, upc=excluded.upc, price=excluded.price, inStock=excluded.inStock,
            productUrl=excluded.productUrl, title=excluded.title, description=excluded.description,
            keyFeatures=excluded.keyFeatures, imageUrls=excluded.imageUrls, zip=excluded.zip,
            packSizeSeen=excluded.packSizeSeen, isBaseUnit=excluded.isBaseUnit,
            unitMismatch=excluded.unitMismatch, sourceApi=excluded.sourceApi,
            matchMethod=excluded.matchMethod, confidence=excluded.confidence,
            fetchedAt=excluded.fetchedAt, updatedAt=excluded.updatedAt`,
        args: [
          `rp:${retailer}:${rpid}`, r.sku ?? null, r.upc ?? null, retailer, rpid, price,
          r.currency ?? "USD", r.in_stock ?? r.inStock ?? null, r.product_url ?? r.productUrl ?? null,
          r.title ?? null, r.description ?? null, J(r.key_features ?? r.keyFeatures),
          J(r.image_urls ?? r.imageUrls), r.zip ?? null, packSize, isBase, unitMismatch ? 1 : 0,
          r.source_api ?? r.sourceApi ?? null, r.match_method ?? r.matchMethod ?? null,
          num(r.confidence), r.fetched_at ?? r.fetchedAt ?? now, now, now,
        ],
      });

      // Base-unit price with a resolved SKU → feed COGS (productCost).
      if (isBase && r.sku && price !== null) {
        const eff = (r.fetched_at ?? r.fetchedAt ?? now).slice(0, 10);
        await c.execute({
          sql: `INSERT INTO "SkuCost"
            (id, sku, effectiveDate, productCost, totalCost, costPerUnit, packSize,
             includesPackaging, currency, source, confidence, needsReview, notes, createdAt, updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(sku, source, effectiveDate) DO UPDATE SET
              productCost=excluded.productCost, totalCost=excluded.totalCost,
              costPerUnit=excluded.costPerUnit, packSize=excluded.packSize,
              confidence=excluded.confidence, updatedAt=excluded.updatedAt`,
          args: [
            `retail:${r.sku}:${eff}`, r.sku, eff, price, price, price, 1, 0, r.currency ?? "USD",
            `retail:${r.source_api ?? r.sourceApi ?? "engine"}`, num(r.confidence), 0,
            `${retailer} base unit @ ${r.product_url ?? ""}`.slice(0, 180), now, now,
          ],
        });
        costUpserts++;
      }
    }
  }
  console.log(`priced ${priced}, base-units ${baseUnits}, SkuCost upserts ${costUpserts}`);
  if (!DRY) {
    const rp = await c.execute("SELECT COUNT(*) n FROM RetailPrice");
    console.log("RetailPrice total:", rp.rows[0].n);
  }
})();
