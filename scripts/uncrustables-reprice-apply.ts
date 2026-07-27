/**
 * APPLIES new prices to the 9 overpriced Uncrustables listings on store1.
 * Approved by Vladimir 2026-06-15. Item price (our_price) via SP-API.
 * Per SKU: read productType → validation-preview → real PATCH.
 *
 * Run: npx tsx scripts/uncrustables-reprice-apply.ts        (LIVE)
 *      npx tsx scripts/uncrustables-reprice-apply.ts --dry  (preview only)
 */
import "dotenv/config";
import { getListing } from "@/lib/amazon-sp-api/listings";
import { setListingPrice } from "@/lib/amazon-sp-api/pricing";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";

const STORE = 1;
const DRY = process.argv.includes("--dry");

// SKU → new item price (target landed×1.5, rounded to .99). Explicit & auditable.
const CHANGES: Array<{ sku: string; price: number; note: string }> = [
  { sku: "743269740767", price: 249.99, note: "88ct XL (was 378.02)" },
  { sku: "VY-DG31-67FN", price: 82.99, note: "28ct S (was 111.00)" },
  { sku: "743269740583", price: 123.99, note: "40ct M (was 162.95)" },
  { sku: "SV-2ZYX-WRHI", price: 85.99, note: "30ct S (was 111.00)" },
  { sku: "743269740828", price: 111.99, note: "32ct M (was 144.09)" },
  { sku: "743269740743", price: 123.99, note: "40ct M (was 158.43)" },
  { sku: "743269740590", price: 135.99, note: "48ct M (was 169.11)" },
  { sku: "743269740835", price: 135.99, note: "48ct M (was 169.14)" },
  { sku: "WP-7XFG-JIB0", price: 153.99, note: "60ct M (was 188.33)" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sellerId = await getMerchantToken(STORE);
  console.log(`store${STORE} sellerId=${sellerId}  mode=${DRY ? "DRY (preview)" : "LIVE"}\n`);

  let applied = 0;
  for (const ch of CHANGES) {
    try {
      const listing = await getListing(STORE, sellerId, ch.sku);
      const productType = listing.summaries?.[0]?.productType;
      if (!productType) {
        console.log(`✗ ${ch.sku} (${ch.note}): no productType — SKIP`);
        continue;
      }

      // 1) validation preview
      const prev = await setListingPrice(STORE, sellerId, ch.sku, productType, ch.price, {
        validationPreview: true,
      });
      const issues = (prev?.issues ?? []).filter(
        (i: any) => i?.severity === "ERROR",
      );
      if (issues.length) {
        console.log(
          `✗ ${ch.sku} (${ch.note}): preview rejected → ${JSON.stringify(issues)}`,
        );
        continue;
      }

      if (DRY) {
        console.log(`✓ ${ch.sku} (${ch.note}): preview OK → would set $${ch.price}`);
        await sleep(300);
        continue;
      }

      // 2) real patch
      const res = await setListingPrice(STORE, sellerId, ch.sku, productType, ch.price);
      console.log(
        `✓ ${ch.sku} (${ch.note}): set $${ch.price} → status=${res?.status} sub=${res?.submissionId ?? "?"}`,
      );
      applied++;
      await sleep(500);
    } catch (e: any) {
      console.log(`✗ ${ch.sku} (${ch.note}): ERROR ${e?.message}`);
    }
  }
  console.log(`\n${DRY ? "Preview" : "Applied"} done. ${DRY ? "" : `${applied}/${CHANGES.length} prices submitted.`}`);
  if (!DRY)
    console.log(
      "Note: Amazon processes price PATCH async (status ACCEPTED → live in minutes). Re-run the proposal script later to confirm.",
    );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
