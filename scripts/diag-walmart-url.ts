import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
async function main() {
  const client = getWalmartClient(1);
  const upc = "684611920775";
  const s: any = (await client.requestRaw("GET", "/items/walmart/search", { params: { upc } })).body;
  for (const it of (s?.items ?? [])) {
    console.log(`itemId=${it.itemId}  mp=${it.isMarketPlaceItem}  title=${it.title}`);
    console.log(`   url: https://www.walmart.com/ip/${it.itemId}`);
  }
}
main().catch(e => { console.error(e?.name, e?.message); process.exit(1); });
