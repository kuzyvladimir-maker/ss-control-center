import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const pack = `COALESCE((SELECT unitsInListing FROM SkuShippingData WHERE sku=q.sku LIMIT 1),(SELECT packSize FROM SkuCost WHERE sku=q.sku LIMIT 1),q.titlePackCount,1)`;
async function main(){
  for(const [lbl, cond] of [["multipacks pack>=2", `${pack}>=2`],["pack>=4", `${pack}>=4`],["pack>=2 + has gaps", `${pack}>=2 AND q.issueCount>0`]]){
    const r = await db.execute(`SELECT COUNT(*) c FROM WalmartListingQualityItem q WHERE storeIndex=1 AND ${cond}`);
    console.log(`${lbl}: ${(r.rows[0] as any).c}`);
  }
}
main();
