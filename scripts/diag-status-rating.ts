import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  // 1) does listingQuality item carry a star rating / publish status?
  const c = getWalmartClient(1);
  const r:any = await c.requestRaw("POST","/insights/items/listingQuality/items",{params:{limit:"3"},body:{}});
  const it = r.body?.payload?.[0];
  if(it){ const keys=Object.keys(it); console.log("LQ item has rating-ish keys:", keys.filter(k=>/rating|review|star|status|publish/i.test(k)).join(", ")||"(none)");
    console.log("  ratingCount=",it.ratingCount,"averageRating=",it.averageRating,"avgRating=",it.avgRating,"publishedStatus=",it.publishedStatus,"status=",it.status); }
  // 2) WalmartCatalogItem status coverage + distinct statuses
  const wci = await db.execute(`SELECT publishedStatus, COUNT(*) c FROM WalmartCatalogItem GROUP BY publishedStatus`);
  console.log("\nWalmartCatalogItem publishedStatus distribution:");
  for(const x of wci.rows as any[]) console.log("  ",x.publishedStatus, x.c);
  const lq = await db.execute(`SELECT COUNT(*) c FROM WalmartListingQualityItem`);
  console.log("LQ mirror items:", (lq.rows[0] as any).c);
}
main().catch(e=>{console.error(e?.message);process.exit(1)});
