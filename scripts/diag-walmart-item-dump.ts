// Dump the full Walmart item record for a SKU so we can build a safe update feed.
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
import { writeFileSync } from "fs";

async function main() {
  const sku = process.argv[2] || "FaisalX-2272";
  const client = getWalmartClient(1);
  const res = await client.requestRaw("GET", `/items/${encodeURIComponent(sku)}`);
  console.log("status:", res.status);
  const out = `/tmp/walmart-item-${sku}.json`;
  writeFileSync(out, JSON.stringify(res.body, null, 2));
  console.log("written:", out);
  // print a compact summary of top-level keys
  const b: any = res.body;
  const item = b?.ItemResponse?.[0] ?? b?.payload ?? b;
  console.log("top keys:", Object.keys(b || {}).join(", "));
  if (item) console.log("item keys:", Object.keys(item).join(", "));
}
main().catch((e) => { console.error(e?.name, e?.message); process.exit(1); });
