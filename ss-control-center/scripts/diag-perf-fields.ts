import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  // what per-item perf do we already store?
  const r = await db.execute(`SELECT sku, ratingCount, pageViews30d, conversionRate30d, gmv30d, orders30d, units30d FROM WalmartListingQualityItem WHERE storeIndex=1 AND (gmv30d>0 OR pageViews30d>0) ORDER BY gmv30d DESC LIMIT 8`);
  console.log("top by gmv30d (already in mirror):");
  for(const x of r.rows as any[]) console.log(`  ${x.sku}: gmv30d=$${x.gmv30d} units=${x.units30d} orders=${x.orders30d} views=${x.pageViews30d} conv=${x.conversionRate30d} reviews=${x.ratingCount}`);
  const agg = await db.execute(`SELECT COUNT(*) c, SUM(CASE WHEN gmv30d>0 THEN 1 ELSE 0 END) withSales, SUM(CASE WHEN pageViews30d>0 THEN 1 ELSE 0 END) withTraffic, SUM(CASE WHEN ratingCount>0 THEN 1 ELSE 0 END) withReviews FROM WalmartListingQualityItem WHERE storeIndex=1`);
  const a = agg.rows[0] as any;
  console.log(`\ncoverage: ${a.c} items · ${a.withSales} with $sales(30d) · ${a.withTraffic} with traffic · ${a.withReviews} with reviews`);
}
main();
