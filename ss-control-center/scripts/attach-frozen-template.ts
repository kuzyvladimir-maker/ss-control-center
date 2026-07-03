// One-off — replace the broken `legacy-template-id` merchant_shipping_group on
// the 3 Bundle-Factory Uncrustables listings with the REAL frozen shipping
// template (weight-tiered; Amazon charges the customer by package weight). Also
// re-affirms item_package_weight per cooler. Reprice already dropped the item
// price; this makes the customer pay frozen shipping on top (margin ~17% → ~34%).
//
// Safe by default: PREVIEW (VALIDATION_PREVIEW). Pass --apply to write.
//
// Run:  npx tsx scripts/attach-frozen-template.ts           # preview
//       npx tsx scripts/attach-frozen-template.ts --apply   # write live

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, patchListing } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { coolerFor } from "@/lib/pricing/cost-model";
import { frozenShippingGroupGuid, packageWeightOz } from "@/lib/bundle-factory/distribution/shipping-templates";

const STORE = 1;
const TARGETS = [
  { asin: "B0H788M8WM", sku: "AZ-ASMY-VEQ2", count: 30 },
  { asin: "B0H784LMG6", sku: "UA-ASAO-RE7Q", count: 45 },
  { asin: "B0H786L5MW", sku: "VC-ASV1-378P", count: 90 },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const sellerId = await getMerchantToken(STORE);
  console.log(`\nMode: ${apply ? "APPLY (live write)" : "PREVIEW (no mutation)"}\n`);
  console.log("ASIN         SKU            ct  cooler  guid              weightOz  result");
  console.log("─".repeat(92));

  for (const t of TARGETS) {
    const cooler = coolerFor(t.count);
    const guid = frozenShippingGroupGuid(cooler);
    const wtOz = packageWeightOz(cooler);
    let result = "";
    try {
      const listing = await getListing(STORE, sellerId, t.sku);
      const productType = listing.summaries?.[0]?.productType;
      if (!productType) throw new Error("no productType");
      // Only replace the broken `legacy-template-id` placeholder with the real
      // weight-tiered frozen template. Leave item_package_weight untouched — the
      // existing values (118/156/268 oz) are realistic for Uncrustables; the
      // per-cooler band (packageWeightOz) overstates weight and would overcharge
      // the customer on the weight-tiered template. (wtOz kept for display only.)
      void wtOz;
      const patches = [
        {
          op: "replace" as const,
          path: "/attributes/merchant_shipping_group",
          value: [{ value: guid, marketplace_id: MARKETPLACE_ID }],
        },
      ];
      const res = await patchListing(STORE, sellerId, t.sku, productType, patches, {
        validationPreview: !apply,
      });
      const errs = (res?.issues ?? []).filter((i: { severity?: string }) => i?.severity === "ERROR");
      result = errs.length ? "FAIL " + JSON.stringify(errs).slice(0, 200) : (res?.status ?? "OK");
    } catch (e) {
      result = "ERR " + (e as Error).message;
    }
    console.log(
      `${t.asin}  ${t.sku.padEnd(13)}  ${String(t.count).padStart(2)}  ${cooler.padEnd(5)}   ${guid.slice(0, 8)}…  ${String(wtOz).padStart(6)}    ${result}`,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
