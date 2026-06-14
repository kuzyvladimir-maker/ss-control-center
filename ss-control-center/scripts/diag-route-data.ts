import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const hist = await db.execute(`SELECT COUNT(*) c FROM WalmartListingRemediation`);
  console.log("history rows:", (hist.rows[0] as any).c);
  const cand = await db.execute(`
    SELECT q.sku, q.productName, q.contentScore, q.issueCount, q.pageViews30d, COALESCE(s.unitsInListing,c.packSize) packCount
    FROM WalmartListingQualityItem q
    LEFT JOIN SkuShippingData s ON s.sku=q.sku
    LEFT JOIN SkuCost c ON c.sku=q.sku
    WHERE q.storeIndex=1 AND COALESCE(s.unitsInListing,c.packSize,1)>=2
      AND q.sku NOT IN (SELECT sku FROM WalmartListingRemediation WHERE ok=1)
      AND q.sku NOT IN (SELECT sku FROM WalmartRemediationQueue WHERE status IN ('queued','running'))
    ORDER BY (CASE WHEN COALESCE(s.unitsInListing,c.packSize,1)>=4 THEN 0 ELSE 1 END), q.pageViews30d DESC LIMIT 10`);
  console.log("candidate multipacks (sample):", cand.rows.length);
  for(const r of cand.rows as any[]) console.log(` ×${r.packCount} ${r.sku} content=${r.contentScore} issues=${r.issueCount} views=${r.pageViews30d} | ${(r.productName||'').slice(0,45)}`);
  const tot = await db.execute(`SELECT COUNT(*) c FROM WalmartListingQualityItem q LEFT JOIN SkuShippingData s ON s.sku=q.sku LEFT JOIN SkuCost c ON c.sku=q.sku WHERE COALESCE(s.unitsInListing,c.packSize,1)>=4`);
  console.log("\ntotal pack>=4 multipacks in catalog:", (tot.rows[0] as any).c);
}
main();
