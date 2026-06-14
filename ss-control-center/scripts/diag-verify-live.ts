import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
const SKUS=["FaisalX-2272","RizwanX-3152","FaisalX-3755","RizwanX-2330","RizwanX-3011"];
async function main(){
  const c=getWalmartClient(1);
  for(const sku of SKUS){
    const it:any=(await c.requestRaw("GET",`/items/${encodeURIComponent(sku)}`)).body;
    const r=it?.ItemResponse?.[0];
    const t=r?.productName||"";
    const newTitle = /-Pack \(\d+ \w+\)/.test(t) ? "NEW" : "old";
    // catalog search to see live image count + title on the buyer page
    const s:any=(await c.requestRaw("GET","/items/walmart/search",{params:{upc:r?.upc}})).body;
    const match=(s?.items||[]).find((x:any)=>x.itemId)||{};
    const imgs=(match.images||[]).length;
    console.log(`${sku} [${newTitle}] price=$${r?.price?.amount} status=${r?.publishedStatus}`);
    console.log(`   title: ${t}`);
    console.log(`   buyer-page images: ${imgs}`);
  }
}
main().catch(e=>{console.error(e?.message);process.exit(1)});
