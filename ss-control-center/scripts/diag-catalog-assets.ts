import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const SKUS = ["FaisalX-2272","RizwanX-3152","FaisalX-3755","RizwanX-2330","RizwanX-3011","FaisalX-1732"];
async function main(){
  // RetailPrice columns
  const cols = await db.execute(`PRAGMA table_info(RetailPrice)`);
  console.log("RetailPrice cols:", (cols.rows as any[]).map(r=>r.name).join(", "));
  console.log("");
  for(const sku of SKUS){
    const r = await db.execute({ sql:`SELECT imageUrls, description, packSizeSeen, confidence, length(description) AS dlen FROM RetailPrice WHERE sku=? AND imageUrls IS NOT NULL ORDER BY (CASE WHEN COALESCE(packSizeSeen,1)=1 THEN 0 ELSE 1 END), confidence DESC LIMIT 1`, args:[sku] });
    const row = r.rows[0] as any;
    if(!row){ console.log(`${sku}: NO RetailPrice row`); continue; }
    let imgs:string[]=[]; try{imgs=JSON.parse(row.imageUrls);}catch{imgs=[row.imageUrls];}
    imgs = imgs.filter(u=>typeof u==="string"&&u.startsWith("http"));
    const desc = (row.description||"").toString();
    const liCount = (desc.match(/<li>/gi)||[]).length;
    console.log(`${sku}: images=${imgs.length} | descLen=${row.dlen||0} | <li> bullets=${liCount} | packSeen=${row.packSizeSeen}`);
    console.log(`   img sample: ${imgs.slice(0,3).map(u=>u.slice(0,70)).join("\n               ")}`);
    console.log(`   desc head: ${desc.replace(/\s+/g," ").slice(0,160)}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1)});
