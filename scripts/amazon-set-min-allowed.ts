/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Lower Amazon's minimum_seller_allowed_price to our floor for store1 Uncrustables
 * where it currently sits ABOVE the floor (else ChannelMAX dropping to floor would
 * push the listing Inactive). Preserves current our_price; does NOT set a max cap
 * (Option A: don't cap upside). validation-preview then real PATCH.
 *
 * Run: npx tsx scripts/amazon-set-min-allowed.ts --dry   (preview only)
 *      npx tsx scripts/amazon-set-min-allowed.ts          (LIVE)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { getListing, patchListing } from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { blockLegacyUncrustablesPriceMutation } from "@/lib/pricing/uncrustables-policy";

const DRY = process.argv.includes("--dry");
const MARKETPLACE_ID = "ATVPDKIKX0DER";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function allBlock(po: any) {
  if (!Array.isArray(po)) return null;
  return po.find((o) => o.audience === "ALL") ?? po[0] ?? null;
}
function val(blk: any, key: string): number | null {
  const v = blk?.[key]?.[0]?.schedule?.[0]?.value_with_tax;
  return typeof v === "number" ? v : null;
}

async function main() {
  blockLegacyUncrustablesPriceMutation("amazon-set-min-allowed.ts");
  const rows = readFileSync("data/channelmax-uncrustables-corrected.txt", "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1)
    .map((l) => l.split("\t"))
    .filter((c) => c[2] === "AmazonUS"); // store1
  const sellerId = await getMerchantToken(1);
  console.log(`store1 Uncrustables: ${rows.length}  mode=${DRY ? "DRY" : "LIVE"}\n`);

  let fixed = 0,
    skip = 0,
    err = 0;
  for (const c of rows) {
    const sku = c[0];
    const floor = Number(c[3]);
    try {
      const listing = await getListing(1, sellerId, sku);
      const productType = listing.summaries?.[0]?.productType;
      const blk = allBlock((listing.attributes as any)?.purchasable_offer);
      const minAllowed = val(blk, "minimum_seller_allowed_price");
      const ourPrice = val(blk, "our_price");
      if (!productType || ourPrice == null) {
        console.log(`✗ ${sku}: missing productType/our_price — SKIP`);
        err++;
        continue;
      }
      if (minAllowed == null || minAllowed <= floor) {
        skip++;
        continue; // already safe
      }
      // Rebuild purchasable_offer: keep our_price, lower min_allowed to floor.
      const patches = [
        {
          op: "replace" as const,
          path: "/attributes/purchasable_offer",
          value: [
            {
              marketplace_id: MARKETPLACE_ID,
              currency: "USD",
              our_price: [{ schedule: [{ value_with_tax: ourPrice }] }],
              minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: floor }] }],
            },
          ],
        },
      ];
      const res = await patchListing(1, sellerId, sku, productType, patches, {
        validationPreview: DRY,
      });
      const errs = (res?.issues ?? []).filter((i: any) => i?.severity === "ERROR");
      if (errs.length) {
        console.log(`✗ ${sku}: ${JSON.stringify(errs).slice(0, 200)}`);
        err++;
      } else {
        console.log(`✓ ${sku}: AmzMin ${minAllowed} → ${floor} (our_price ${ourPrice})${DRY ? " [preview]" : ` ${res?.status}`}`);
        fixed++;
      }
      await sleep(DRY ? 150 : 400);
    } catch (e: any) {
      console.log(`✗ ${sku}: ERROR ${e?.message}`);
      err++;
    }
  }
  console.log(`\n${DRY ? "Would fix" : "Fixed"}: ${fixed}, already-safe skipped: ${skip}, errors: ${err}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
