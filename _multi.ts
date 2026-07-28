import { readFileSync } from "node:fs";
for (const f of [".env",".env.local"]) { let t=""; try{t=readFileSync(f,"utf8");}catch{continue;} for (const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"");} }
throw new Error("LEGACY_METERED_SCRIPT_DISABLED: _multi.ts has unbounded direct Oxylabs calls; migrate it to guarded provider adapters before reuse");
async function main(){
  const { unwrangleSearch } = await import("./src/lib/sourcing/retail-fetch.ts");
  const u=(process.env.OXYLABS_USERNAME||"").replace(/^['"]|['"]$/g,""); const p=(process.env.OXYLABS_PASSWORD||"").replace(/^['"]|['"]$/g,""); const auth=Buffer.from(`${u}:${p}`).toString("base64");
  async function gshop(q:string){const c=new AbortController();const t=setTimeout(()=>c.abort(),90000);try{const r=await fetch("https://realtime.oxylabs.io/v1/queries",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Basic ${auth}`},body:JSON.stringify({source:"google_shopping_search",query:q,parse:true}),signal:c.signal});const j:any=await r.json();const raw=j?.results?.[0]?.content?.results?.organic||j?.results?.[0]?.content?.results||[];const arr=Array.isArray(raw)?raw:Object.values(raw||{});return (arr as any[]).map(x=>({title:String(x.title||""),merchant:x.merchant?.name||x.seller||"",price:x.price})); }finally{clearTimeout(t);}}
  // Sam's Club + Target for the real Keto (Carb Control)
  for(const [ret,q] of [["samsclub","Arnold Carb Control Keto Bread"],["samsclub","Arnold Keto Bread"],["target","Arnold Carb Control Bread"],["target","Sara Lee Artesano White Bakery Buns"]] as any){
    try{ const r=await unwrangleSearch(ret,q); console.log(`[${ret} "${q}"] ${r.offers.length} offers; top: ${r.offers.slice(0,3).map((o:any)=>`${String(o.title).slice(0,40)}[${o.imageUrls[0]?"img":"noimg"}]`).join(" | ")}`);}catch(e:any){console.log(`[${ret} "${q}"] ERR ${String(e?.message||e).slice(0,40)}`);}
  }
  // Google Shopping merchant coverage for the real name
  for(const q of ["Arnold Carb Control Bread","Arnold Country Oatmeal Bread"]){
    try{ const g=await gshop(q); console.log(`\n[gshop "${q}"] ${g.length}; merchants: ${JSON.stringify([...new Set(g.map(x=>x.merchant).filter(Boolean))].slice(0,8))}`); g.slice(0,3).forEach(x=>console.log(`   • ${x.title.slice(0,44)} @ ${x.merchant} ${x.price||""}`)); }catch(e:any){console.log(`[gshop "${q}"] ERR ${String(e?.message||e).slice(0,40)}`);}
  }
}
main().catch(e=>{console.error(String(e?.message||e));process.exit(1);});
