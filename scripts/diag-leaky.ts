import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const r = await db.execute(`SELECT sku, productName, lqScore, contentScore, isInStock, pageViews30d, ratingCount, issuesSummary FROM WalmartListingQualityItem WHERE sku LIKE 'Testing-0%' ORDER BY pageViews30d DESC LIMIT 3`);
  for(const x of r.rows as any[]){
    console.log(`\n${x.sku} "${(x.productName||'').slice(0,40)}" LQ=${x.lqScore} content=${x.contentScore} inStock=${x.isInStock} views=${x.pageViews30d} reviews=${x.ratingCount}`);
    try{ const j=JSON.parse(x.issuesSummary||'[]'); for(const i of j) console.log(`   [${i.impact}] ${i.componentLabel}: ${i.title}`); }catch{}
  }
}
main();
