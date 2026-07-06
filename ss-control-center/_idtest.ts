import { readFileSync } from "node:fs";
for (const f of [".env",".env.local"]){let t="";try{t=readFileSync(f,"utf8");}catch{continue;}for(const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);if(m)process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"");}}
process.env.SS_VISION_PROVIDER="auto";
async function main(){
  const { identifyProduct } = await import("./src/lib/sourcing/identify.ts");
  const { resolveDonorPhoto } = await import("./src/lib/sourcing/resolve-donor.ts");
  let nod:any[]=[]; try{nod=JSON.parse(readFileSync("_backlog_final_nodonor.json","utf8"));}catch{ nod=JSON.parse(readFileSync("_rebuildall_stillfail.json","utf8")); }
  const pick = nod.filter((x:any)=>/campbell|fancy feast|pringles|skippy|oreo|belvita/i.test(x.title)).slice(0,3);
  const set = pick.length?pick:nod.slice(0,3);
  for(const it of set){
    console.log(`\n=== ${it.sku}: ${String(it.title).slice(0,60)}`);
    const id:any = await identifyProduct({ title: it.title });
    console.log(`  IDENTIFY → base_unit="${id.base_unit}" query="${id.retail_search_query}" units=${id.units_in_listing} bundle=${id.is_bundle} conf=${id.confidence}`);
    const dp = await resolveDonorPhoto(it.title, { searchQuery: id.retail_search_query, identityTitle: id.base_unit || it.title });
    console.log(`  DONOR (with identify): ${dp ? "✅ "+dp.src : "still none"}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
