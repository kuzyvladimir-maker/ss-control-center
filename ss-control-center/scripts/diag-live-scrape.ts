import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
const ITEMS:[string,string][]=[
["BODYARMOR","10126870205"],["Bush's","14806018179"],["Progresso","11399410693"],
["Barilla","14675822737"],["Contadina","14822705333"]];
async function scrape(id:string){
  const key=process.env.BLUECART_API_KEY;
  const url=`https://api.bluecartapi.com/request?api_key=${key}&type=product&item_id=${id}&walmart_domain=walmart.com`;
  const r=await fetch(url); if(!r.ok) return null; const j:any=await r.json(); return j.product||null;
}
async function main(){
  for(const[n,id]of ITEMS){
    const p=await scrape(id);
    if(!p){console.log(`${n} (${id}): scrape failed`);continue;}
    const imgs=[p.main_image,...(p.images||[]).map((x:any)=>typeof x==="string"?x:x?.link)].filter(Boolean);
    const uniq=[...new Set(imgs.filter((u:any)=>typeof u==="string").map((u:string)=>u.split("?")[0]))];
    console.log(`\n${n} (ip/${id})`);
    console.log(`  LIVE title: ${(p.title||"").slice(0,90)}`);
    console.log(`  LIVE images: ${uniq.length}`);
    console.log(`  LIVE bullets: ${(p.feature_bullets||[]).length}`);
    if((p.feature_bullets||[]).length) console.log(`     b1: ${String(p.feature_bullets[0]).slice(0,80)}`);
    console.log(`  LIVE desc head: ${String(p.description||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").slice(0,120)}`);
  }
}
main().catch(e=>{console.error(e?.message);process.exit(1)});
