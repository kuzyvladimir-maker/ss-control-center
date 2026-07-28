import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const tot = await db.execute(`SELECT COUNT(*) c, MAX(syncedAt) m FROM WalmartListingQualityItem`);
  console.log("mirror rows:", (tot.rows[0] as any).c, "| latest syncedAt:", (tot.rows[0] as any).m);
  const ours = await db.execute(`SELECT sku, lqScore, contentScore, conversionRate30d, pageViews30d, gmv30d, units30d, issueCount FROM WalmartListingQualityItem WHERE sku IN ('FaisalX-2272','RizwanX-3152','FaisalX-3755','RizwanX-2330','RizwanX-3011')`);
  console.log("our SKUs in mirror:", ours.rows.length);
  for(const r of ours.rows as any[]) console.log(` ${r.sku}: LQ=${r.lqScore} content=${r.contentScore} conv=${r.conversionRate30d} views=${r.pageViews30d} gmv=${r.gmv30d} units=${r.units30d} issues=${r.issueCount}`);
}
main();
