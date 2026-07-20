import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { assertMeteredProviderCall } from "@/lib/sourcing/metered-call-guard";
throw new Error("LEGACY_METERED_SCRIPT_DISABLED: direct paid diagnostic transport is quarantined");
const ITEMS:[string,string][]=[["Barilla(ours)","14742510940"],["Contadina","14822705333"]];
async function scrape(id:string){const key=process.env.BLUECART_API_KEY;assertMeteredProviderCall({ provider: "bluecart", operation: "detail" });const r=await fetch(`https://api.bluecartapi.com/request?api_key=${key}&type=product&item_id=${id}&walmart_domain=walmart.com`);if(!r.ok)return null;return (await r.json()).product||null;}
async function main(){for(const[n,id]of ITEMS){const p=await scrape(id);if(!p){console.log(n,"fail");continue;}const imgs=[p.main_image,...(p.images||[]).map((x:any)=>typeof x==="string"?x:x?.link)].filter((u:any)=>typeof u==="string");const uniq=[...new Set(imgs.map((u:string)=>u.split("?")[0]))];console.log(`\n${n} (ip/${id})`);console.log(`  title: ${(p.title||"").slice(0,85)}`);console.log(`  images: ${uniq.length}`);console.log(`  desc head: ${String(p.description||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").slice(0,130)}`);}}
main().catch(e=>{console.error(e?.message);process.exit(1)});
