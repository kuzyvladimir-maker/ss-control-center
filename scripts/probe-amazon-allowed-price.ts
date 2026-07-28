/**
 * For store1 Uncrustables: read Amazon's minimum/maximum_seller_allowed_price and
 * compare to the floor we want ChannelMAX to use. If Amazon's min_allowed > our
 * floor, ChannelMAX dropping to floor would push the listing Inactive. Quantify
 * how many are at risk.
 *
 * Run: npx tsx scripts/probe-amazon-allowed-price.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { getListing } from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { priceFor } from "@/lib/pricing/cost-model";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function allowed(po: any, key: string): number | null {
  if (!Array.isArray(po)) return null;
  const blk = po.find((o) => o.audience === "ALL") ?? po[0];
  const v = blk?.[key]?.[0]?.schedule?.[0]?.value_with_tax;
  return typeof v === "number" ? v : null;
}

async function main() {
  // store1 (AmazonUS) rows from the corrected file: SKU + our Min(floor)
  const lines = readFileSync("data/channelmax-uncrustables-corrected.txt", "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1)
    .map((l) => l.split("\t"))
    .filter((c) => c[2] === "AmazonUS"); // venue col
  console.log(`store1 Uncrustables to check: ${lines.length}`);
  const sellerId = await getMerchantToken(1);

  let atRisk = 0,
    noMin = 0,
    ok = 0,
    err = 0;
  const samples: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const sku = lines[i][0];
    const ourFloor = Number(lines[i][3]);
    try {
      const listing = await getListing(1, sellerId, sku);
      const po = (listing.attributes as any)?.purchasable_offer;
      const minAllowed = allowed(po, "minimum_seller_allowed_price");
      const maxAllowed = allowed(po, "maximum_seller_allowed_price");
      if (minAllowed == null) noMin++;
      else if (minAllowed > ourFloor) {
        atRisk++;
        if (samples.length < 12)
          samples.push(`  ${sku}: AmzMin $${minAllowed} > ourFloor $${ourFloor}  (max $${maxAllowed ?? "—"})`);
      } else ok++;
    } catch (e) {
      err++;
    }
    if ((i + 1) % 25 === 0) console.error(`…${i + 1}/${lines.length}`);
    await sleep(130);
  }
  console.log(`\nAt risk (AmzMin > ourFloor → would go Inactive): ${atRisk}`);
  console.log(`Safe (AmzMin ≤ ourFloor): ${ok}`);
  console.log(`No Amazon min set: ${noMin}`);
  console.log(`Errors: ${err}`);
  console.log(`\nSamples at risk:`);
  samples.forEach((s) => console.log(s));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
