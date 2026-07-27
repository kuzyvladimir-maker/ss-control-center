import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
async function main() {
  const client = getWalmartClient(1);
  const list: any = (await client.requestRaw("GET", "/feeds", { params: { limit: "3" } })).body;
  const feeds = list?.results?.feed ?? [];
  for (const f of feeds.slice(0,3)) {
    console.log(`${f.feedType} ${f.feedStatus} recv=${f.itemsReceived} ok=${f.itemsSucceeded} fail=${f.itemsFailed} ${f.feedId}`);
  }
  // detail of newest
  const newest = feeds[0];
  if (newest) {
    const d: any = (await client.requestRaw("GET", `/feeds/${encodeURIComponent(newest.feedId)}`, { params: { includeDetails: "true" } })).body;
    const fe = d?.ingestionErrors?.ingestionError ?? [];
    for (const e of fe) console.log(`  FEED-ERR [${e.field}] ${e.code}: ${e.description?.slice(0,200)}`);
    const items = d?.itemDetails?.itemIngestionStatus ?? [];
    for (const it of items) {
      console.log(`  ITEM ${it.sku}: ${it.ingestionStatus}`);
      const ie = it.ingestionErrors?.ingestionError ?? [];
      for (const e of ie) console.log(`    [${e.type}/${e.field}] ${e.code}: ${e.description?.slice(0,220)}`);
    }
  }
}
main().catch(e => { console.error(e?.name, e?.message); process.exit(1); });
