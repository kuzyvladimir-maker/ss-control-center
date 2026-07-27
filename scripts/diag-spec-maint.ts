import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
import { writeFileSync } from "fs";
async function main() {
  const client = getWalmartClient(1);
  const res = await client.requestRaw("POST", "/items/spec", {
    body: { feedType: "MP_MAINTENANCE", version: "5.0.20260330-14_47_14-api", productTypes: ["Sports Drinks"] },
  });
  console.log("status", res.status);
  if (res.status !== 200) { console.log(JSON.stringify(res.body).slice(0,300)); return; }
  writeFileSync("/tmp/spec-maint.json", JSON.stringify(res.body));
  const spec:any = res.body;
  const hdr = spec.schema.properties.MPItemFeedHeader;
  console.log("HEADER required:", hdr.required, "| props:", Object.keys(hdr.properties));
  const item = spec.schema.properties.MPItem.items;
  const ord = item.properties.Orderable;
  console.log("Orderable required:", ord.required);
  const vis = item.properties.Visible;
  const ptKey = Object.keys(vis.properties).find(k=>/sport/i.test(k));
  console.log("Visible PT key:", ptKey, "| required:", ptKey ? vis.properties[ptKey]?.required : undefined);
}
main().catch(e => { console.error(e?.name, e?.message); process.exit(1); });
