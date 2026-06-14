import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
import { getWalmartClient } from "../src/lib/walmart/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const SKUS = ["FaisalX-2272","RizwanX-3152","FaisalX-3755","RizwanX-2330","RizwanX-3011"];
async function main(){
  const c = getWalmartClient(1);
  for(const sku of SKUS){
    const r = await db.execute({ sql:`SELECT imageUrls, keyFeatures, upc FROM RetailPrice WHERE sku=? AND imageUrls IS NOT NULL ORDER BY (CASE WHEN COALESCE(packSizeSeen,1)=1 THEN 0 ELSE 1 END), confidence DESC LIMIT 1`, args:[sku] });
    const row = r.rows[0] as any;
    let imgs:string[]=[]; try{imgs=JSON.parse(row.imageUrls);}catch{}
    imgs = [...new Set(imgs.filter((u:string)=>typeof u==="string"&&u.startsWith("http")).map((u:string)=>u.split("?")[0]))];
    let kf:any = row.keyFeatures; let kfArr:string[]=[]; try{kfArr=JSON.parse(kf);}catch{ if(kf) kfArr=[String(kf)]; }
    // catalog search image count
    const itemRes:any = (await c.requestRaw("GET",`/items/${encodeURIComponent(sku)}`)).body;
    const upc = itemRes?.ItemResponse?.[0]?.upc;
    const s:any = (await c.requestRaw("GET","/items/walmart/search",{params:{upc}})).body;
    const catImgs = (s?.items?.[0]?.images||[]).length;
    console.log(`${sku}: RP-images(unique)=${imgs.length} keyFeatures=${kfArr.length} | catalogSearch images=${catImgs}`);
  }
}
main().catch(e=>{console.error(e?.message);process.exit(1)});
