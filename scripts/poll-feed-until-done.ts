import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
async function main() {
  const feedId = process.argv[2];
  const client = getWalmartClient(1);
  for (let i = 0; i < 40; i++) {
    const d: any = (await client.requestRaw("GET", `/feeds/${encodeURIComponent(feedId)}`, { params: { includeDetails: "true" } })).body;
    const st = d?.feedStatus;
    if (st === "PROCESSED" || st === "ERROR") {
      console.log(`TERMINAL ${st} recv=${d.itemsReceived} ok=${d.itemsSucceeded} fail=${d.itemsFailed}`);
      const fe = d?.ingestionErrors?.ingestionError ?? [];
      for (const e of fe) console.log(`FEED-ERR [${e.field}] ${e.description?.slice(0,260)}`);
      const items = d?.itemDetails?.itemIngestionStatus ?? [];
      for (const it of items) {
        console.log(`ITEM ${it.sku}: ${it.ingestionStatus}`);
        for (const e of (it.ingestionErrors?.ingestionError ?? [])) console.log(`  [${e.type}/${e.field}] ${e.code}: ${e.description?.slice(0,260)}`);
      }
      return;
    }
    await new Promise(r => setTimeout(r, 60000));
  }
  console.log("TIMEOUT still not terminal");
}
main().catch(e => { console.error("POLLERR", e?.message); process.exit(1); });
