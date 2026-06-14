import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
import { analyzePool, PoolListing } from "../src/lib/walmart/multipack/analyst";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
async function main(){
  const rows = await db.execute(`SELECT sku, productName, lqScore, contentScore, isInStock, pageViews30d, ratingCount, issuesSummary FROM WalmartListingQualityItem WHERE sku LIKE 'Testing-0%' ORDER BY pageViews30d DESC LIMIT 6`);
  const listings: PoolListing[] = (rows.rows as any[]).map(x=>{
    let issues:string[]=[]; try{const j=JSON.parse(x.issuesSummary||'[]'); issues=j.map((i:any)=>`[${i.impact}] ${i.componentLabel}: ${i.title}`).slice(0,8);}catch{}
    return { sku:x.sku, name:x.productName, status:"PUBLISHED", pack:1, lq:x.lqScore, content:x.contentScore, sales:0, units:0, conv:0, views:x.pageViews30d, reviews:x.ratingCount, returns:0, inStock:!!x.isInStock, issues };
  });
  const a = await analyzePool({ period:30, aggregates:{count:listings.length, outOfStock:listings.length, zeroSales:listings.length, totalViews:listings.reduce((s,l)=>s+l.views,0)}, listings });
  if(!a){ console.log("NULL (no key/err)"); return; }
  console.log("NARRATIVE:\n", a.narrative, "\n");
  for(const r of a.recommendations) console.log(`[${r.type}] ${r.title} ${r.fields.length?`(${r.fields.join(",")})`:""} — ${r.skus.length} skus\n   ${r.detail.slice(0,140)}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e?.message);process.exit(1)});
