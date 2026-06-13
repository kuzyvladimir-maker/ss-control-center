import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
import { writeFileSync } from "fs";
async function main() {
  const client = getWalmartClient(1);
  const tries: Array<[string, Record<string,string>]> = [
    ["/items/spec", { feedType: "MP_ITEM", version: "5.0", productTypes: "Sports Drinks" }],
    ["/items/spec", { feedType: "MP_ITEM" }],
    ["/items/taxonomy", {}],
    ["/spec/items", { feedType: "MP_ITEM" }],
  ];
  for (const [path, params] of tries) {
    try {
      const res = await client.requestRaw("GET", path, { params });
      const s = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      console.log(`GET ${path} ${JSON.stringify(params)} -> ${res.status} len=${s.length}`);
      if (res.status === 200) { writeFileSync(`/tmp/spec${path.replace(/\//g,'_')}.json`, s); console.log("   saved; head:", s.slice(0,200)); }
      else console.log("   ", s.slice(0,160));
    } catch (e:any) { console.log(`GET ${path} ERR ${e?.message?.slice(0,120)}`); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
