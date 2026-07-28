// Capture the FULL per-item Listing Quality response so we can model the
// worklist correctly. Dumps the seller score + the first 2 items verbatim.
//   npx tsx scripts/diag-walmart-lq-schema.ts
import "dotenv/config";
import { getWalmartClient } from "@/lib/walmart/client";

async function main() {
  const client = getWalmartClient(1);

  const score = await client.requestRaw("GET", "/insights/items/listingQuality/score", {
    params: { wfsFlag: false },
  });
  console.log("### SELLER SCORE ###");
  console.log(JSON.stringify(score.body, null, 2));

  const items = await client.requestRaw("POST", "/insights/items/listingQuality/items", {
    params: { limit: 2 },
    body: {},
    headers: { "Content-Type": "application/json" },
  });
  const b = items.body as { totalItems?: number; nextCursor?: string; payload?: unknown[] };
  console.log("\n### ITEMS (totalItems=" + b?.totalItems + ") ###");
  console.log(JSON.stringify((b?.payload ?? []).slice(0, 2), null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
