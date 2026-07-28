import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
async function main(){
  const c=getWalmartClient(1);
  // wpids of our 5
  const wpids: Record<string,string> = { "FaisalX-2272":"1MUBFP2TSMK8" };
  // Try several filter shapes to fetch a SINGLE item's quality
  const attempts:any[] = [
    { params:{limit:"1"}, body:{ filters:[{ field:"itemId", values:["1MUBFP2TSMK8"] }] } },
    { params:{limit:"1"}, body:{ query:{ sku:"FaisalX-2272" } } },
    { params:{limit:"1",sku:"FaisalX-2272"}, body:{} },
    { params:{limit:"1",itemId:"1MUBFP2TSMK8"}, body:{} },
    { params:{limit:"5"}, body:{ filters:[{ attributeName:"sku", values:["FaisalX-2272"] }] } },
  ];
  for(const a of attempts){
    const r:any = await c.requestRaw("POST","/insights/items/listingQuality/items",a);
    const ok = r.status===200 && r.body?.payload;
    const n = r.body?.payload?.length;
    const first = r.body?.payload?.[0];
    console.log(`status=${r.status} items=${n??'-'} | ${JSON.stringify(a.body).slice(0,60)} ${JSON.stringify(a.params)}`);
    if(ok && first){ console.log("   first productId:", first.productId, "score:", first.qualityScoreData?.score?.toFixed?.(1)); }
    else if(r.status!==200) console.log("   err:", JSON.stringify(r.body).slice(0,140));
  }
}
main().catch(e=>{console.error(e?.message);process.exit(1)});
