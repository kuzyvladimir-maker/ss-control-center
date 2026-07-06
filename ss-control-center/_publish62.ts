// Publish the VERIFIED corrected main images (from _rebuildall_result.json) to
// Walmart — IMAGE-ONLY MP_MAINTENANCE, batched. Non-destructive: a feed that fails
// ingestion (e.g. QARTH-locked cards) does NOT change the live listing. Reports
// per-SKU: applied / QARTH-locked / other error.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv({ path: ".env" });
import { readFileSync } from "node:fs";
import { getWalmartClient } from "./src/lib/walmart/client";
import { submitFeedBatch, checkFeedItems } from "./src/lib/walmart/multipack/remediate";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const fixed: any[] = JSON.parse(readFileSync("_rebuildall_result.json", "utf8"));
  const only = process.argv[2] ? Number(process.argv[2]) : fixed.length; // optional cap for a test batch
  const set = fixed.slice(0, only);
  const client = getWalmartClient(1);
  console.log(`publishing ${set.length} verified corrected mains (image-only)`);

  // Build image-only MPItems (need live upc + productType per sku).
  const items: { sku: string; mpItem: any }[] = [];
  for (const f of set) {
    try {
      const cur: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(f.sku)}`)).body?.ItemResponse?.[0];
      if (!cur?.upc || !cur?.productType) { console.log(`  skip ${f.sku}: no upc/productType live`); continue; }
      items.push({ sku: f.sku, mpItem: {
        Orderable: { sku: f.sku, productIdentifiers: { productIdType: "UPC", productId: cur.upc } },
        Visible: { [cur.productType]: { mainImageUrl: f.newUrl } },
      } });
    } catch (e: any) { console.log(`  skip ${f.sku}: GET failed ${e?.message?.slice(0, 60)}`); }
  }
  console.log(`built ${items.length} image-only MPItems`);

  const BATCH = 15;
  const applied: string[] = [], qarth: string[] = [], failed: { sku: string; err: string }[] = [];
  for (let off = 0; off < items.length; off += BATCH) {
    const chunk = items.slice(off, off + BATCH);
    const feed = await submitFeedBatch(client, chunk.map((c) => c.mpItem));
    if (!feed.feedId) { for (const c of chunk) failed.push({ sku: c.sku, err: feed.error || "no feedId" }); console.log(`  batch ${off}-${off + chunk.length}: POST failed ${feed.error?.slice(0, 80)}`); continue; }
    console.log(`  batch ${off}-${off + chunk.length}: feedId ${feed.feedId} — polling…`);
    let res = null;
    for (let i = 0; i < 40 && !res; i++) { await sleep(5000); res = await checkFeedItems(client, feed.feedId); }
    if (!res) { for (const c of chunk) failed.push({ sku: c.sku, err: "poll timeout" }); continue; }
    for (const it of res.items) {
      if (it.ok) applied.push(it.sku);
      else if (it.errors.some((e) => /0101119|QARTH|different details/i.test(e))) qarth.push(it.sku);
      else failed.push({ sku: it.sku, err: (it.errors[0] || it.ingestionStatus || "?").slice(0, 90) });
    }
    if (off + BATCH < items.length) await sleep(8000);
  }

  console.log(`\n=== PUBLISH RESULT ===`);
  console.log(`APPLIED (image now live): ${applied.length}`);
  console.log(`QARTH-locked (catalog lock — image not applied, not our fault): ${qarth.length}`);
  console.log(`OTHER errors: ${failed.length}`);
  if (applied.length) console.log(`applied: ${applied.join(", ")}`);
  if (qarth.length) console.log(`qarth: ${qarth.join(", ")}`);
  for (const f of failed.slice(0, 20)) console.log(`  fail ${f.sku}: ${f.err}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
