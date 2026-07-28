import { config as loadEnv } from "dotenv"; loadEnv({path:".env.local"}); loadEnv({path:".env"});
import { getWalmartClient } from "./src/lib/walmart/client";
import { checkFeedItems } from "./src/lib/walmart/multipack/remediate";
async function main(){
  const client=getWalmartClient(1);
  const feedId="18BF8926A69C50ED8682EC698646784A@AX8BBwA";
  const r=await checkFeedItems(client,feedId);
  if(!r){console.log("feed still processing / not terminal");return;}
  console.log("feed status:",r.status);
  for(const it of r.items) console.log("  ",it.sku,it.ingestionStatus, it.ok?"OK-applied":("errors: "+it.errors.slice(0,1).join("|").slice(0,70)));
}
main().then(()=>process.exit(0)).catch(e=>{console.log("check err:",e.message);process.exit(0)});
