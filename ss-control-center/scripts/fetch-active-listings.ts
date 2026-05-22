/**
 * Fetch Active Listings Report (GET_MERCHANT_LISTINGS_ALL_DATA) from each
 * available US Amazon store via SP-API, then save concatenated TSV to
 *   data/imports/Active_Listings_Report_<YYYY-MM-DD>.txt
 * so prisma/seed/upc-pool-import.ts can pick it up.
 *
 * Stores covered: STORE1, STORE2, STORE3 (SALUTEM, PERSONAL, AMZCOM).
 *   STORE4 (SIRIUS) — no SP-API app yet.
 *   STORE5 (RETAILER) — US suspended; LWA refresh_token revoked.
 *
 * Header (seller-sku, product-id, ...) is taken from the first store's
 * output; subsequent stores have their header line stripped before concat.
 *
 * Run: npx tsx scripts/fetch-active-listings.ts [store1,store3,...]
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestAndWaitForReport } from "@/lib/amazon-sp-api/reports";

const REPORT_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const DEFAULT_STORES = ["store1", "store2", "store3"];

async function fetchOne(storeId: string): Promise<{ ok: true; tsv: string } | { ok: false; error: string }> {
  console.log(`[${storeId}] requesting ${REPORT_TYPE} …`);
  try {
    const tsv = await requestAndWaitForReport(storeId, REPORT_TYPE, 1, 8 * 60 * 1000);
    console.log(`[${storeId}] downloaded ${tsv.length} bytes`);
    return { ok: true, tsv };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${storeId}] FAILED: ${msg}`);
    return { ok: false, error: msg };
  }
}

async function main() {
  const argStores = process.argv[2]?.split(",").map((s) => s.trim()).filter(Boolean);
  const stores = argStores && argStores.length ? argStores : DEFAULT_STORES;
  console.log(`Fetching for stores: ${stores.join(", ")}`);

  const results = await Promise.all(stores.map((s) => fetchOne(s).then((r) => ({ store: s, ...r }))));

  let combined = "";
  let headerWritten = false;
  let okCount = 0;
  for (const r of results) {
    if (!r.ok) continue;
    okCount++;
    const lines = r.tsv.split(/\r?\n/);
    if (!headerWritten) {
      combined += lines.join("\n");
      headerWritten = true;
    } else {
      combined += "\n" + lines.slice(1).join("\n");
    }
  }

  if (okCount === 0) {
    console.error("No stores succeeded; nothing written.");
    process.exit(2);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = join(process.cwd(), "data", "imports", `Active_Listings_Report_${stamp}.txt`);
  writeFileSync(outPath, combined, "utf-8");
  console.log("");
  console.log(`Wrote ${combined.length} bytes (${okCount}/${stores.length} stores) to:`);
  console.log(`  ${outPath}`);
  console.log("");
  console.log("Next: npx tsx prisma/seed/upc-pool-import.ts");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
