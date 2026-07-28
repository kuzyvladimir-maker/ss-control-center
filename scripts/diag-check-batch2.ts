import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
const F:[string,string][]=[
["BODYARMOR","18B8CEE2063B579FB7709113F17255C5@AX8BBwA"],
["Bush's","18B8CEE6138A5275BC0B7993817FB3D2@AX8BBgA"],
["Progresso","18B8CEE9A9EB52498A02541C3175A450@AX8BBwA"],
["Barilla","18B8CEED14BD553E9DCD2CFCD04A33F5@AX8BBwA"],
["Contadina","18B8CEF053CE5E498D9CC666ACE0B71B@AX8BBwA"]];
async function main(){const c=getWalmartClient(1);for(const[n,f]of F){const d:any=(await c.requestRaw("GET",`/feeds/${encodeURIComponent(f)}`,{params:{includeDetails:"true"}})).body;const e=d?.itemDetails?.itemIngestionStatus?.[0]?.ingestionErrors?.ingestionError??[];console.log(`${n.padEnd(10)} ${d?.feedStatus?.padEnd(11)} ok=${d?.itemsSucceeded} fail=${d?.itemsFailed} proc=${d?.itemsProcessing}${e.length?" :: "+e.map((x:any)=>x.field+":"+(x.description||"").slice(0,50)).join(" | "):""}`);}}
main().catch(e=>{console.error(e?.message);process.exit(1)});
