import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const sku="FaisalX-2272";
  const w=await db.execute({sql:`SELECT w.title AS wtitle, COALESCE(s.unitsInListing,c.packSize) AS pack FROM WalmartCatalogItem w LEFT JOIN SkuShippingData s ON s.sku=w.sku LEFT JOIN SkuCost c ON c.sku=w.sku WHERE w.sku=? LIMIT 1`,args:[sku]});
  console.log("pack row:", JSON.stringify(w.rows[0]));
  const r=await db.execute({sql:`SELECT retailerProductId, sourceApi, length(imageUrls) dl FROM RetailPrice WHERE sku=? AND imageUrls IS NOT NULL AND imageUrls != '' AND sourceApi='bluecart' ORDER BY (CASE WHEN COALESCE(packSizeSeen,1)=1 THEN 0 ELSE 1 END), confidence DESC LIMIT 1`,args:[sku]});
  console.log("retail row:", JSON.stringify(r.rows[0]));
  const r2=await db.execute({sql:`SELECT DISTINCT sourceApi FROM RetailPrice WHERE sku=?`,args:[sku]});
  console.log("all sourceApis:", JSON.stringify(r2.rows));
}
main();
