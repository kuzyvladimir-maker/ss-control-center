// Diagnostic: dump declared package weight/dimensions for the SKUs Amazon
// flagged in the "Shipping options suppressed due to excessive rates" email
// (store1 / Salutem Solutions). Goal: see whether listings declare the real
// packaged weight (cooler + dry ice) or just the bare product weight.
//
//   npx tsx scripts/diag-shipping-weights.ts
import "dotenv/config";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing } from "@/lib/amazon-sp-api/listings";

const STORE = 1;

const GROUPS: Record<string, string[]> = {
  "US Coolers": [
    "S1-KJU0-VX88", "N25", "W100", "W150", "9Z-C3Z7-G38A", "KX-57YH-8HP3",
    "7G-KAMF-385M", "MB-II72-OGXA", "CP-MJUW-5DNZ", "5U-YRTQ-RTLL", "W25",
  ],
  "US Migrated Template": [
    "LF-KVPJ-JN6H", "37-UAII-TGJ2", "742259728853", "742259728846",
    "742259728839", "WC-RRKC-TP48", "742259724176", "742259723964",
    "742259724169", "742259724138",
  ],
  "US Small Frozen": ["BP-0POP-23E0", "05-4YER-PCKW", "RU-NSMF-CG31"],
};

const RX = /weight|dimension|package|girth|\bsize\b/i;

async function main() {
  const sellerId = await getMerchantToken(STORE);
  console.log("sellerId(store1) =", sellerId, "\n");

  for (const [group, skus] of Object.entries(GROUPS)) {
    console.log("################ TEMPLATE:", group, "################");
    for (const sku of skus) {
      try {
        const item = await getListing(STORE, sellerId, sku);
        const attrs = (item.attributes ?? {}) as Record<string, unknown>;
        const pt = item.summaries?.[0]?.productType ?? "?";
        const title =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (attrs.item_name as any)?.[0]?.value ??
          item.summaries?.[0]?.itemName ??
          "";
        const matched = Object.keys(attrs).filter((k) => RX.test(k)).sort();
        console.log(`\n--- ${sku} | pt=${pt} | ${String(title).slice(0, 55)}`);
        if (matched.length === 0) {
          console.log("    (NO weight/dimension/package attributes declared)");
        } else {
          for (const k of matched) {
            console.log(`    ${k} = ${JSON.stringify(attrs[k])}`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`\n--- ${sku}  -> ERROR: ${msg.slice(0, 160)}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
