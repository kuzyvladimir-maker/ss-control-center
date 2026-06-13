import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
import { writeFileSync } from "fs";
async function main() {
  const client = getWalmartClient(1);
  const res = await client.requestRaw("POST", "/items/spec", {
    body: { feedType: "MP_ITEM", version: "5.0.20260330-14_47_14-api", productTypes: ["Sports Drinks"] },
  });
  const s = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  console.log("status", res.status, "len", s.length);
  if (res.status === 200) { writeFileSync("/tmp/spec.json", s); console.log("SAVED /tmp/spec.json"); }
  else console.log(s.slice(0, 300));
}
main().catch(e => { console.error(e?.name, e?.message); process.exit(1); });
