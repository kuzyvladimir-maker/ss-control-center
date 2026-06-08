// Stage 0b — extract manufacturer UPC/GTIN from our OWN marketplace listings
// and write it onto SkuShippingData.upc (the matching key for the retail price
// engine). This is the "lynchpin": resale items carry the real barcode.
//
//   Walmart: GET /items/{sku} returns upc + gtin (the LIST endpoint does not).
//   Amazon : GET_MERCHANT_LISTINGS_ALL_DATA report → "product-id" column.
//
//   set -a; . ./.env; . ./.env.local; set +a;
//   npx tsx scripts/cogs-extract-upc.ts --walmart      # Walmart only (fast)
//   npx tsx scripts/cogs-extract-upc.ts --amazon       # Amazon report (slow)
//   npx tsx scripts/cogs-extract-upc.ts                # both

import { createClient } from "@libsql/client";
import { WalmartClient } from "@/lib/walmart/client";
import { getConfiguredStores } from "@/lib/amazon-sp-api/auth";
import { requestAndWaitForReport } from "@/lib/amazon-sp-api/reports";

const doWalmart = process.argv.includes("--walmart") || !process.argv.includes("--amazon");
const doAmazon = process.argv.includes("--amazon") || !process.argv.includes("--walmart");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanUpc = (v: any): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && /\d/.test(s) ? s.replace(/^0+(?=\d{12,})/, "") : null; // drop GTIN leading zeros to UPC-12
};

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const now = new Date().toISOString();

  // ── Walmart: per-item GET ──
  if (doWalmart) {
    const rows = (await db.execute(
      "SELECT sku FROM SkuShippingData WHERE upc IS NULL AND (marketplace='Walmart' OR marketplace='Both')"
    )).rows as any[];
    console.log(`\n[WALMART] ${rows.length} SKUs without UPC to look up`);
    const client = new WalmartClient(1); // store1 = our Walmart account
    let found = 0, miss = 0, err = 0;
    for (let i = 0; i < rows.length; i++) {
      const sku = String(rows[i].sku);
      try {
        const r: any = await client.request("GET", `/items/${encodeURIComponent(sku)}`, {});
        const it = r?.ItemResponse?.[0] || r?.payload || r;
        const upc = cleanUpc(it?.upc) || cleanUpc(it?.gtin);
        if (upc) {
          await db.execute({ sql: "UPDATE SkuShippingData SET upc=?, upcSource='walmart_item', updatedAt=? WHERE sku=?", args: [upc, now, sku] });
          found++;
        } else miss++;
      } catch (e: any) {
        if (/404|not found/i.test(String(e.message))) miss++;
        else { err++; if (err <= 3) console.log(`  err ${sku}: ${String(e.message).slice(0, 60)}`); }
      }
      if ((i + 1) % 50 === 0) console.log(`  …${i + 1}/${rows.length} (found ${found}, miss ${miss}, err ${err})`);
      await sleep(120);
    }
    console.log(`[WALMART] done: UPC found ${found}, none ${miss}, errors ${err}`);
  }

  // ── Amazon: GET_MERCHANT_LISTINGS_ALL_DATA report per store ──
  if (doAmazon) {
    const stores = getConfiguredStores(); // [{storeIndex,...}] with creds
    console.log(`\n[AMAZON] configured stores: ${stores.map((s: any) => s.storeIndex ?? s).join(", ")}`);
    const skuUpc = new Map<string, string>();
    for (const s of stores) {
      const idx = (s.storeIndex ?? s) as number;
      const storeId = `store${idx}`;
      try {
        const tsv = await requestAndWaitForReport(storeId, "GET_MERCHANT_LISTINGS_ALL_DATA", 0, 180_000);
        if (!tsv) { console.log(`  ${storeId}: no report`); continue; }
        const lines = String(tsv).split("\n").filter(Boolean);
        const header = lines[0].split("\t").map((h) => h.toLowerCase());
        const sIdx = header.findIndex((c) => c === "seller-sku");
        const pIdx = header.findIndex((c) => c === "product-id");
        let n = 0;
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split("\t");
          const sku = (cols[sIdx] ?? "").trim();
          const upc = cleanUpc(cols[pIdx]);
          if (sku && upc) { skuUpc.set(sku, upc); n++; }
        }
        console.log(`  ${storeId}: ${n} sku→upc pairs`);
      } catch (e: any) { console.log(`  ${storeId}: ${String(e.message).slice(0, 70)}`); }
    }
    // write to our catalog
    let written = 0;
    const ours = (await db.execute("SELECT sku FROM SkuShippingData WHERE upc IS NULL")).rows as any[];
    for (const r of ours) {
      const upc = skuUpc.get(String(r.sku));
      if (upc) { await db.execute({ sql: "UPDATE SkuShippingData SET upc=?, upcSource='amazon_listing_report', updatedAt=? WHERE sku=?", args: [upc, now, r.sku] }); written++; }
    }
    console.log(`[AMAZON] wrote UPC for ${written} of our SKUs (report had ${skuUpc.size} total pairs)`);
  }

  // ── coverage report ──
  const cov = await db.execute(
    "SELECT COALESCE(marketplace,'(null)') m, COUNT(*) total, SUM(CASE WHEN upc IS NOT NULL THEN 1 ELSE 0 END) withUpc FROM SkuShippingData GROUP BY marketplace"
  );
  console.log("\n=== UPC COVERAGE (SkuShippingData) ===");
  for (const x of cov.rows as any[]) console.log(`  ${String(x.m).padEnd(10)} ${x.withUpc}/${x.total}`);
})();
