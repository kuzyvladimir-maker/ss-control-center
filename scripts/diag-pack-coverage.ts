import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const total = await db.execute(`SELECT COUNT(*) c FROM WalmartListingQualityItem WHERE storeIndex=1`);
  console.log("catalog items:", (total.rows[0] as any).c);
  // recorded pack>=2 (what the filter uses now)
  const rec = await db.execute(`SELECT COUNT(*) c FROM WalmartListingQualityItem q WHERE storeIndex=1 AND COALESCE((SELECT unitsInListing FROM SkuShippingData WHERE sku=q.sku LIMIT 1),(SELECT packSize FROM SkuCost WHERE sku=q.sku LIMIT 1),1) >= 2`);
  console.log("recorded packCount>=2 (DB):", (rec.rows[0] as any).c);
  // titles that LOOK like multipacks
  const titlePat = await db.execute(`SELECT COUNT(*) c FROM WalmartListingQualityItem WHERE storeIndex=1 AND (LOWER(productName) LIKE '%pack of %' OR LOWER(productName) LIKE '%-pack%' OR productName LIKE '% Count%' OR LOWER(productName) LIKE '% ct %' OR LOWER(productName) LIKE '%count)%')`);
  console.log("titles that look like multipacks:", (titlePat.rows[0] as any).c);
  // sample titles with pack words but NO recorded pack
  const sample = await db.execute(`SELECT productName, sku FROM WalmartListingQualityItem q WHERE storeIndex=1 AND (LOWER(productName) LIKE '%pack of %' OR LOWER(productName) LIKE '%-pack%') AND COALESCE((SELECT unitsInListing FROM SkuShippingData WHERE sku=q.sku LIMIT 1),(SELECT packSize FROM SkuCost WHERE sku=q.sku LIMIT 1),1) < 2 LIMIT 8`);
  console.log("\nmultipack-by-title but NO recorded pack (sample):");
  for(const r of sample.rows as any[]) console.log("  -", (r.productName||'').slice(0,70));
}
main();
