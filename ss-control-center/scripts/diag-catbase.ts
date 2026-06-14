import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  for(const st of ["PUBLISHED","UNPUBLISHED","SYSTEM_PROBLEM"]){
    const r = await db.execute({sql:`SELECT COUNT(*) c FROM WalmartCatalogItem w WHERE w.storeIndex=1 AND w.publishedStatus=? AND w.sku NOT IN (SELECT sku FROM WalmartListingRemediation WHERE ok=1) AND w.sku NOT IN (SELECT sku FROM WalmartRemediationQueue WHERE status IN ('queued','running'))`,args:[st]});
    console.log(`${st}: ${(r.rows[0] as any).c}`);
  }
}
main();
