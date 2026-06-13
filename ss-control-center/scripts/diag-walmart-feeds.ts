import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
import { writeFileSync } from "fs";
async function main() {
  const client = getWalmartClient(1);
  const list: any = (await client.requestRaw("GET", "/feeds", { params: { limit: "50" } })).body;
  const feeds = list?.results?.feed ?? [];
  console.log(`feeds: ${feeds.length}`);
  for (const f of feeds) {
    console.log(`  ${f.feedType.padEnd(16)} ${f.feedStatus.padEnd(10)} recv=${f.itemsReceived} ok=${f.itemsSucceeded} fail=${f.itemsFailed} id=${f.feedId}`);
  }
  // UPC search for full catalog content
  const upc = "684611920775";
  const s: any = (await client.requestRaw("GET", "/items/walmart/search", { params: { upc } })).body;
  writeFileSync("/tmp/walmart-upc-search.json", JSON.stringify(s, null, 2));
  console.log(`\nUPC search status keys: ${Object.keys(s||{}).join(", ")}`);
  console.log(JSON.stringify(s).slice(0, 500));
}
main().catch(e => { console.error(e?.name, e?.message); process.exit(1); });
