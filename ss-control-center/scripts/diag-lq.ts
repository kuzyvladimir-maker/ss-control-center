import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
async function main(){
  const c=getWalmartClient(1);
  // overall score
  const s:any=(await c.requestRaw("GET","/insights/items/listingQuality/score")).body;
  console.log("SCORE overall:", JSON.stringify(s).slice(0,500));
  // per-item quality (POST)
  for(const body of [{},{query:{},filters:[]}]){
    const r:any=(await c.requestRaw("POST","/insights/items/listingQuality/items",{params:{limit:"5"},body})).body;
    if(r && !r.error){ console.log("ITEMS sample keys:", Object.keys(r)); console.log(JSON.stringify(r).slice(0,900)); break; }
  }
}
main().catch(e=>{console.error(e?.message);process.exit(1)});
