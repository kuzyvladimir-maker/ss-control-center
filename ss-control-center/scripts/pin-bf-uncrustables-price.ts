/* eslint-disable @typescript-eslint/no-explicit-any */
// Pin the 3 Bundle-Factory Uncrustables to our target item price AND cap them
// with maximum_seller_allowed_price = target, so the ChannelMAX repricer (which
// drives store1 and reverted the plain reprice back up toward list_price within
// a day) can't push them above our number. Amazon will not publish a price above
// maximum_seller_allowed_price regardless of the source. Preserves the existing
// minimum_seller_allowed_price floor. This is the SP-API half; the ChannelMAX
// flat-file (scripts/channelmax-bf-uncrustables.ts) is the durable half.
//
// Safe: PREVIEW by default. --apply to write.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, patchListing } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { blockLegacyUncrustablesPriceMutation } from "@/lib/pricing/uncrustables-policy";

const STORE = 1;
const TARGETS = [
  { asin: "B0H788M8WM", sku: "AZ-ASMY-VEQ2", price: 86.25 },
  { asin: "B0H784LMG6", sku: "UA-ASAO-RE7Q", price: 128.57 },
  { asin: "B0H786L5MW", sku: "VC-ASV1-378P", price: 250.47 },
];

function scheduleVal(v: number) {
  return [{ schedule: [{ value_with_tax: v }] }];
}

async function main() {
  blockLegacyUncrustablesPriceMutation("pin-bf-uncrustables-price.ts");
  const apply = process.argv.includes("--apply");
  const sellerId = await getMerchantToken(STORE);
  console.log(`\nMode: ${apply ? "APPLY (live)" : "PREVIEW"}\n`);
  console.log("ASIN         SKU            our_price  min(kept)  MAX(cap)  result");
  console.log("─".repeat(80));

  for (const t of TARGETS) {
    let result = "";
    try {
      const l = await getListing(STORE, sellerId, t.sku);
      const a = l.attributes as Record<string, any>;
      const productType = l.summaries?.[0]?.productType;
      if (!productType) throw new Error("no productType");
      const po = (a?.purchasable_offer ?? [])[0] ?? {};
      const existingMin =
        po?.minimum_seller_allowed_price?.[0]?.schedule?.[0]?.value_with_tax ?? null;

      const offer: Record<string, unknown> = {
        marketplace_id: MARKETPLACE_ID,
        currency: "USD",
        our_price: scheduleVal(t.price),
        maximum_seller_allowed_price: scheduleVal(t.price),
      };
      if (existingMin != null && existingMin < t.price) {
        offer.minimum_seller_allowed_price = scheduleVal(existingMin);
      }

      const res = await patchListing(
        STORE,
        sellerId,
        t.sku,
        productType,
        [{ op: "replace", path: "/attributes/purchasable_offer", value: [offer] }],
        { validationPreview: !apply },
      );
      const errs = (res?.issues ?? []).filter((i: { severity?: string }) => i?.severity === "ERROR");
      result = errs.length ? "FAIL " + JSON.stringify(errs).slice(0, 160) : (res?.status ?? "OK");
      console.log(
        `${t.asin}  ${t.sku.padEnd(13)}  $${t.price.toFixed(2).padStart(7)}  ` +
          `${(existingMin != null ? "$" + existingMin.toFixed(2) : "—").padStart(8)}  ` +
          `$${t.price.toFixed(2).padStart(7)}  ${result}`,
      );
    } catch (e) {
      console.log(`${t.asin}  ${t.sku.padEnd(13)}  ERR ${(e as Error).message}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
