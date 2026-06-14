import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
const SKUS=["FaisalX-2272","RizwanX-3152","FaisalX-3755","RizwanX-2330","RizwanX-3011"];
async function main(){
  const c=getWalmartClient(1);
  for(const sku of SKUS){
    const it:any=(await c.requestRaw("GET",`/items/${encodeURIComponent(sku)}`)).body;
    const r=it?.ItemResponse?.[0];
    // all catalog offers for this UPC
    const s:any=(await c.requestRaw("GET","/items/walmart/search",{params:{upc:r?.upc}})).body;
    console.log(`\n${sku}  wpid=${r?.wpid} upc=${r?.upc} ourTitle="${(r?.productName||'').slice(0,55)}"`);
    for(const x of (s?.items||[])){
      console.log(`   catalogItem id=${x.itemId} mp=${x.isMarketPlaceItem} title="${(x.title||'').slice(0,55)}"`);
    }
  }
}
main().catch(e=>{console.error(e?.message);process.exit(1)});
