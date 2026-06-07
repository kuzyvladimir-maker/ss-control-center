// Verify listing-quality.ts lib against the live API (read-only, no DB).
//   npx tsx scripts/diag-walmart-lq-verify.ts
import "dotenv/config";
import { getWalmartClient } from "@/lib/walmart/client";
import {
  fetchSellerListingQuality,
  iterateListingQualityItems,
  type LqItem,
} from "@/lib/walmart/listing-quality";

async function main() {
  const client = getWalmartClient(1);

  const seller = await fetchSellerListingQuality(client);
  console.log("### SELLER SCORE ###");
  console.log(JSON.stringify(seller, null, 2));

  console.log("\n### FIRST 2 PAGES OF ITEMS (distilled) ###");
  const items: LqItem[] = [];
  const it = iterateListingQualityItems(client, { pageSize: 20, maxPages: 2 });
  let n = await it.next();
  while (!n.done) {
    items.push(n.value as LqItem);
    n = await it.next();
  }
  console.log(`got ${items.length} items, totalItems=${n.value?.totalItems}, pages=${n.value?.pages}`);

  // Show the 3 lowest-scoring items in full distilled form
  const worst = [...items].sort((a, b) => (a.lqScore ?? 0) - (b.lqScore ?? 0)).slice(0, 3);
  for (const it2 of worst) {
    console.log(`\n--- ${it2.sku} | LQ=${it2.lqScore?.toFixed(1)} | priority=${it2.priority} | topFix=${it2.topFixComponent}`);
    console.log(`    ${it2.productName?.slice(0, 60)}`);
    console.log(`    inStock=${it2.isInStock} fastShip=${it2.isFastAndFreeShipping} reviews=${it2.ratingCount} views30d=${it2.pageViews30d} conv=${it2.conversionRate30d}`);
    console.log(`    components:`, Object.entries(it2.components).map(([k, v]) => `${k}=${v.score ?? "—"}(${v.impact})`).join(" "));
    console.log(`    issues (${it2.issues.length}):`);
    for (const iss of it2.issues.slice(0, 8)) {
      console.log(`      [${iss.impact}] ${iss.componentLabel}: ${iss.title}`);
    }
  }

  // Aggregate: how many items fail each component (by HIGH/MED impact + low score)
  const counts = { noStock: 0, noFastShip: 0, noReviews: 0, lowContent: 0 };
  for (const it3 of items) {
    if (!it3.isInStock) counts.noStock++;
    if (!it3.isFastAndFreeShipping) counts.noFastShip++;
    if (it3.ratingCount === 0) counts.noReviews++;
    if ((it3.components.content.score ?? 100) < 80) counts.lowContent++;
  }
  console.log(`\n### AGG over ${items.length} items ###`);
  console.log(JSON.stringify(counts, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
