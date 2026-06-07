// Dry-run verification of the Featured-Offer repricer DECISION logic against
// live data. Reads a sample of SKUs, fetches real offers, and prints what the
// engine WOULD do — changes nothing, touches no DB.
//
// Run: DOTENV_CONFIG_PATH=.env.local npx tsx scripts/diag-reprice-dryrun.ts [store] [pages]
//      (defaults: store 1, 4 pages × 20 = 80 SKUs)

import "dotenv/config";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { listSkus } from "@/lib/amazon-sp-api/listings";
import { getListingOffersBatch } from "@/lib/amazon-sp-api/pricing";
import { decideReprice, type SkuMeta } from "@/lib/reprice/reprice-engine";

const m = (n: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);

async function main() {
  const storeIndex = Number(process.argv[2] ?? 1);
  const maxPages = Number(process.argv[3] ?? 4);
  const sellerId = await getMerchantToken(storeIndex);
  console.log(`store${storeIndex} (${sellerId}) — sampling up to ${maxPages * 20} SKUs\n`);

  const counts: Record<string, number> = {};
  let pageToken: string | undefined;
  const changes: any[] = [];
  const flagged: any[] = [];

  for (let p = 0; p < maxPages; p++) {
    const page = await listSkus(storeIndex, sellerId, {
      pageSize: 20,
      includedData: ["summaries"],
      pageToken,
    });
    const metas: SkuMeta[] = page.items.map((it) => {
      const s = it.summaries?.[0];
      return { sku: it.sku, asin: s?.asin, title: s?.itemName, productType: s?.productType, status: s?.status };
    });
    const offers = await getListingOffersBatch(storeIndex, metas.map((x) => x.sku));
    const byKey = new Map(offers.map((o) => [o.sku, o]));

    for (const meta of metas) {
      const o = byKey.get(meta.sku);
      if (!o || !o.ok) { counts.error = (counts.error ?? 0) + 1; continue; }
      const d = decideReprice(meta, o);
      counts[d.action] = (counts[d.action] ?? 0) + 1;
      if (d.action === "repriced") changes.push(d);
      if (d.action === "skipped_cap") flagged.push(d);
    }
    pageToken = page.pagination?.nextToken;
    if (!pageToken) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("=== WOULD REPRICE ===");
  for (const c of changes) {
    console.log(
      `  ${(c.title ?? c.sku).slice(0, 45).padEnd(46)} ${m(c.oldPrice)} → ${m(c.newPrice)}  (featured landed ${m(c.targetLanded)}, ship ${m(c.shipping)}, ${c.competitors} offers)`,
    );
  }
  if (!changes.length) console.log("  (none in this sample)");

  console.log("\n=== FLAGGED FOR MANUAL REVIEW (>10% drop) ===");
  for (const f of flagged) {
    console.log(`  ${(f.title ?? f.sku).slice(0, 45).padEnd(46)} ${m(f.oldPrice)}  ${f.reason}`);
  }
  if (!flagged.length) console.log("  (none)");

  console.log("\n=== TALLY ===");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  console.log("\nNOTE: dry-run — no prices changed, nothing written.");
  process.exit(0);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
