import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  for(const sku of ["FaisalX-2272","RizwanX-3152"]){
    const w=await db.execute({sql:`SELECT sku,storeIndex,title FROM WalmartCatalogItem WHERE sku=?`,args:[sku]});
    console.log(sku, "WCI rows:", w.rows.length, JSON.stringify(w.rows[0]||{}).slice(0,90));
    const sc=await db.execute({sql:`SELECT sku,packSize FROM SkuCost WHERE sku=?`,args:[sku]});
    const ss=await db.execute({sql:`SELECT sku,unitsInListing FROM SkuShippingData WHERE sku=?`,args:[sku]});
    console.log("   SkuCost:",JSON.stringify(sc.rows[0]||{}),"SkuShippingData:",JSON.stringify(ss.rows[0]||{}));
  }
}
main();
