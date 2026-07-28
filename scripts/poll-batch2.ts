import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
const F:[string,string,string][]=[
["BODYARMOR","18B8CEE2063B579FB7709113F17255C5@AX8BBwA","https://www.walmart.com/ip/10126870205"],
["Bush's","18B8CEE6138A5275BC0B7993817FB3D2@AX8BBgA","https://www.walmart.com/ip/14806018179"],
["Progresso","18B8CEE9A9EB52498A02541C3175A450@AX8BBwA","https://www.walmart.com/ip/11399410693"],
["Barilla","18B8CEED14BD553E9DCD2CFCD04A33F5@AX8BBwA","https://www.walmart.com/ip/14675822737"],
["Contadina","18B8CEF053CE5E498D9CC666ACE0B71B@AX8BBwA","https://www.walmart.com/ip/14822705333"]];
async function main(){const c=getWalmartClient(1);const done:Record<string,string>={};
for(let r=0;r<60&&Object.keys(done).length<F.length;r++){
 for(const[n,f]of F){if(done[n])continue;try{const d:any=(await c.requestRaw("GET",`/feeds/${encodeURIComponent(f)}`,{params:{includeDetails:"true"}})).body;if(d?.feedStatus==="PROCESSED"||d?.feedStatus==="ERROR"){const e=d?.itemDetails?.itemIngestionStatus?.[0]?.ingestionErrors?.ingestionError??[];done[n]=`${d.feedStatus} ok=${d.itemsSucceeded} fail=${d.itemsFailed}${e.length?" :: "+e.map((x:any)=>x.field).join(","):""}`;console.log(`DONE ${n}: ${done[n]}`);}}catch{}}
 if(Object.keys(done).length<F.length)await new Promise(r=>setTimeout(r,300000));}
console.log("=== FINAL ===");for(const[n,,u]of F)console.log(`${n}: ${done[n]||"INPROGRESS(timeout)"} | ${u}`);}
main().catch(e=>{console.error("ERR",e?.message);process.exit(1)});
