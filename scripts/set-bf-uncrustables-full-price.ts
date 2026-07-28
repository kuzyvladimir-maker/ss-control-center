/* eslint-disable @typescript-eslint/no-explicit-any */
// Set EVERY price field on the 3 BF Uncrustables to our agreed target, coherently
// (Vladimir 2026-07-04): regular price = target, maximum_seller_allowed_price =
// target (cap so ChannelMAX can't raise it), minimum_seller_allowed_price kept,
// business_price = target (B2B pays the same, no margin-eroding auto-discount).
//
// NOTE: durable only once the ChannelMAX flat file is uploaded
// (data/channelmax-bf-uncrustables-minmax.txt) — ChannelMAX can overwrite the
// offer. The max cap is the SP-API safety brake.
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

const sched = (v: number) => [{ schedule: [{ value_with_tax: v }] }];

async function main() {
  blockLegacyUncrustablesPriceMutation("set-bf-uncrustables-full-price.ts");
  const apply = process.argv.includes("--apply");
  const sellerId = await getMerchantToken(STORE);
  console.log(`\nMode: ${apply ? "APPLY (live)" : "PREVIEW"}\n`);
  console.log("ASIN         SKU            price/max/biz  min(kept)  result");
  console.log("─".repeat(78));

  for (const t of TARGETS) {
    try {
      const l = await getListing(STORE, sellerId, t.sku);
      const a = l.attributes as Record<string, any>;
      const productType = l.summaries?.[0]?.productType;
      if (!productType) throw new Error("no productType");
      const existingMin =
        a?.purchasable_offer?.[0]?.minimum_seller_allowed_price?.[0]?.schedule?.[0]?.value_with_tax ?? null;

      const offer: Record<string, unknown> = {
        marketplace_id: MARKETPLACE_ID,
        currency: "USD",
        our_price: sched(t.price),
        maximum_seller_allowed_price: sched(t.price),
      };
      if (existingMin != null && existingMin < t.price) {
        offer.minimum_seller_allowed_price = sched(existingMin);
      }

      const patches = [
        { op: "replace" as const, path: "/attributes/purchasable_offer", value: [offer] },
        {
          op: "replace" as const,
          path: "/attributes/business_price",
          value: [{ marketplace_id: MARKETPLACE_ID, currency: "USD", schedule: [{ value_with_tax: t.price }] }],
        },
      ];

      const res = await patchListing(STORE, sellerId, t.sku, productType, patches, {
        validationPreview: !apply,
      });
      const errs = (res?.issues ?? []).filter((i: { severity?: string }) => i?.severity === "ERROR");
      const result = errs.length ? "FAIL " + JSON.stringify(errs).slice(0, 160) : (res?.status ?? "OK");
      console.log(
        `${t.asin}  ${t.sku.padEnd(13)}  $${t.price.toFixed(2).padStart(7)}     ` +
          `${(existingMin != null ? "$" + existingMin.toFixed(2) : "—").padStart(8)}  ${result}`,
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
