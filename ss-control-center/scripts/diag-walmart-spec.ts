import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
import { writeFileSync } from "fs";
async function main() {
  const client = getWalmartClient(1);
  // Try the item spec endpoint
  const res = await client.requestRaw("GET", `/items/spec`, { params: { feedType: "MP_ITEM" } });
  console.log("status:", res.status);
  const body: any = res.body;
  if (res.status !== 200) { console.log(JSON.stringify(body).slice(0, 800)); return; }
  writeFileSync("/tmp/walmart-mp-item-spec.json", JSON.stringify(body, null, 2));
  console.log("written /tmp/walmart-mp-item-spec.json, size:", JSON.stringify(body).length);
  console.log("top keys:", Object.keys(body || {}).join(", "));
}
main().catch(e => { console.error(e?.name, e?.message); process.exit(1); });
