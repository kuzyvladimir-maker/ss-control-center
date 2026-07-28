import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
async function main(){
  const c=getWalmartClient(1);
  const r:any = await c.requestRaw("POST","/insights/items/listingQuality/items",{params:{limit:"2"},body:{}});
  if(r.status!==200){console.log("status",r.status,JSON.stringify(r.body).slice(0,160));return;}
  const it = r.body?.payload?.[0];
  console.log("ITEM top-level keys:", Object.keys(it||{}));
  console.log(JSON.stringify(it, null, 1).slice(0, 1500));
}
main().catch(e=>{console.error(e?.message);process.exit(1)});
