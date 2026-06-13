import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
const FEEDS: [string,string][] = [
  ["BODYARMOR FaisalX-2272","18B88DC7B02451A5A3524676C9493E1C@AX8BBgA"],
  ["Bush's RizwanX-3152","18B89022F48B5B5FBF37C66EA08C12B7@AX8BBwA"],
  ["Progresso FaisalX-3755","18B89023BF5A55749BE945ACE0F72FD3@AX8BBwA"],
  ["Barilla RizwanX-2330","18B89024829E5243A3FDA9C1E07487FA@AX8BBwA"],
  ["Contadina RizwanX-3011","18B890251FE35D5882718B6A1BD85CFB@AX8BBwA"],
];
async function main(){
  const c=getWalmartClient(1);
  for(const [name,fid] of FEEDS){
    const d:any=(await c.requestRaw("GET",`/feeds/${encodeURIComponent(fid)}`,{params:{includeDetails:"true"}})).body;
    let errs="";
    const e=d?.itemDetails?.itemIngestionStatus?.[0]?.ingestionErrors?.ingestionError??[];
    if(e.length) errs=" :: "+e.map((x:any)=>x.field).join(",");
    console.log(`${name.padEnd(24)} ${d?.feedStatus?.padEnd(11)} ok=${d?.itemsSucceeded} fail=${d?.itemsFailed} proc=${d?.itemsProcessing}${errs}`);
  }
}
main().catch(e=>{console.error(e?.message);process.exit(1)});
