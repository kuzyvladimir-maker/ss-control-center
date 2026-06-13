import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { getWalmartClient } from "../src/lib/walmart/client";
import { writeFileSync } from "fs";
async function main() {
  const client = getWalmartClient(1);
  const feedId = process.argv[2] || "18B700E45F4F5CF99D203E7825599489@AX8BBgA";
  const res = await client.requestRaw("GET", `/feeds/${encodeURIComponent(feedId)}`, { params: { includeDetails: "true" } });
  console.log("status:", res.status);
  writeFileSync("/tmp/walmart-feed-detail.json", JSON.stringify(res.body, null, 2));
  const b: any = res.body;
  console.log("keys:", Object.keys(b||{}).join(", "));
  const items = b?.itemDetails?.itemIngestionStatus ?? [];
  console.log("itemDetails count:", items.length);
  console.log(JSON.stringify(b).slice(0, 1200));
}
main().catch(e => { console.error(e?.name, e?.message); process.exit(1); });
