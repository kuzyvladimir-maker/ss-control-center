import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
import { writeFileSync } from "fs";
async function main() {
  const client = getWalmartClient(1);
  const tries: Array<[string, Record<string,string>]> = [
    ["/getReport", { type: "item" }],
    ["/items/walmart/search", {}],
    ["/feeds", {}],
  ];
  for (const [path, params] of tries) {
    try {
      const res = await client.requestRaw("GET", path, { params, raw: false as any });
      const s = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      console.log(`GET ${path} ${JSON.stringify(params)} -> ${res.status} (len ${s.length})`);
      console.log("   ", s.slice(0, 300).replace(/\n/g, " "));
    } catch (e: any) { console.log(`GET ${path} -> ERR ${e?.message?.slice(0,150)}`); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
