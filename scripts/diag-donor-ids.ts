import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const SKUS=["FaisalX-2272","RizwanX-3152","FaisalX-3755","RizwanX-2330","RizwanX-3011"];
async function main(){for(const sku of SKUS){const r=await db.execute({sql:`SELECT sourceApi,retailer,retailerProductId,productUrl FROM RetailPrice WHERE sku=? AND imageUrls IS NOT NULL ORDER BY confidence DESC LIMIT 1`,args:[sku]});const x=r.rows[0] as any;console.log(`${sku}: api=${x?.sourceApi} retailer=${x?.retailer} id=${x?.retailerProductId} url=${(x?.productUrl||'').slice(0,60)}`);}}
main();
