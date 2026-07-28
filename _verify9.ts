// Item-level verification of the 9 published feeds (never leave at SUBMITTED).
import { readFileSync } from "node:fs";
for (const f of [".env",".env.local"]) { let t=""; try{t=readFileSync(f,"utf8")}catch{continue} for(const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"")} }
async function main(){
  const { createClient } = await import("@libsql/client");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { checkFeedItems } = await import("./src/lib/walmart/multipack/remediate.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const rows = (await db.execute(`SELECT sku, feedId, feedStatus FROM WalmartListingRemediation WHERE notes LIKE 'clean-pipeline verified fix%' ORDER BY runAt DESC LIMIT 9`)).rows as any[];
  const client = getWalmartClient(1);
  const feeds = [...new Set(rows.map(r=>String(r.feedId)))];
  let live=0, fail=0, proc=0;
  for (const fid of feeds){
    let res:any=null;
    for(let a=0;a<3;a++){ try{ res=await checkFeedItems(client,fid); }catch{} if(res) break; await new Promise(r=>setTimeout(r,3000)); }
    const sku = rows.find(r=>String(r.feedId)===fid)?.sku;
    if(!res){ proc++; console.log(`  ${sku} feed ${fid.slice(0,14)}… still PROCESSING`); continue; }
    for (const it of res.items||[]){
      const ok = it.ok || /SUCCESS/i.test(it.ingestionStatus||"");
      if(ok){live++;} else {fail++;}
      console.log(`  ${it.sku} → ${ok?"✓ LIVE (ingested)":"✗ INGEST_FAIL "+(it.errors||[]).join("; ").slice(0,80)}`);
      await db.execute({sql:`UPDATE WalmartListingRemediation SET feedStatus=?, ok=? WHERE feedId=? AND sku=?`, args:[ok?"PROCESSED":"ERROR", ok?1:0, fid, it.sku]});
    }
  }
  console.log(`\n=== live: ${live} · ingest-fail: ${fail} · still-processing: ${proc} ===`);
}
main().catch(e=>{console.error(e);process.exit(1);});
