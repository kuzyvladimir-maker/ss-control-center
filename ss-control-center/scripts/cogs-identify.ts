// COGS engine — the "brain": vision-aware product identification.
// For each of OUR SKUs, pull the listing title + attributes + MAIN PHOTO from
// SP-API, and have Claude (vision) figure out EXACTLY what the product is and —
// critically — HOW MANY procurement units are in this listing (handles "Pack of
// N", "N count", "10 ct Pack of 3 = 30", multi-flavor variety bundles). Outputs
// a base-unit description + retail search query so the price step can find the
// SINGLE shelf unit and we can store cost-per-unit.
//
//   npx tsx scripts/cogs-identify.ts <SKU> [<SKU> ...]
//
// Writes identity JSON to SkuShippingData.productIdentity (+ unitsInListing,
// baseUnitDesc) and prints a readable summary.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing } from "@/lib/amazon-sp-api/listings";
import { analyzeImagesWithFallback } from "@/lib/ai-vision";

const SKUS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const STORES = [1, 3, 5];

const PROMPT = `You are a product-identification engine for an e-commerce RESELLER.
You are given a marketplace listing's MAIN PHOTO plus its title and attributes.
Identify the EXACT physical product and how many PROCUREMENT units are in this listing
(a procurement unit = the single item we would buy on a store shelf to fulfill it).

Return ONLY JSON:
{
  "brand": "",
  "product_line": "",
  "flavor": "",                // or "variety" for multi-flavor
  "size": "",                  // e.g. "15 oz", "20 oz", "4.9 oz"
  "container_type": "",        // can | cup | pouch | bag | box | loaf | tray | bottle | jar
  "base_unit": "",             // ONE shelf unit, e.g. "Chef Boyardee Beef Ravioli 15 oz can"
  "units_in_listing": 1,       // total base units in THIS listing. "10 count Pack of 3" = 3 boxes; multi-flavor 4x3 = 12
  "unit_basis": "",            // what one unit is: can/box/bag/loaf/etc
  "is_bundle": false,
  "components": [],            // for multi-flavor/variety: [{"flavor":"","size":"","qty":0}] else []
  "retail_search_query": "",   // best query to find ONE base unit at Walmart/Target
  "confidence": 0.0,
  "notes": ""
}
Use the PHOTO to confirm container type, visible count, and flavor — titles can be wrong or
ambiguous. Be precise about size and container (can vs cup vs pouch is a different SKU).`;

async function toBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  } catch {
    return null;
  }
}

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const now = new Date().toISOString();

  for (const sku of SKUS) {
    let listing: any = null;
    for (const store of STORES) {
      try {
        const sellerId = await getMerchantToken(store);
        const l = await getListing(store, sellerId, sku);
        if (l) { listing = l; break; }
      } catch { /* try next store */ }
    }
    if (!listing) { console.log(`\n❌ ${sku}: not found on stores ${STORES.join("/")}`); continue; }

    const attrs = listing.attributes ?? {};
    const title = attrs.item_name?.[0]?.value ?? listing.summaries?.[0]?.itemName ?? "";
    const imgUrl = attrs.main_product_image_locator?.[0]?.media_location ?? null;
    // a few attributes that often carry the count/size
    const hint = {
      number_of_items: attrs.number_of_items?.[0]?.value,
      item_package_quantity: attrs.item_package_quantity?.[0]?.value,
      unit_count: attrs.unit_count?.[0]?.value ?? attrs.unit_count?.[0],
      size: attrs.size?.[0]?.value,
      flavor: attrs.flavor?.[0]?.value,
    };

    const promptWithCtx = `${PROMPT}\n\nLISTING TITLE: ${title}\nATTRIBUTES: ${JSON.stringify(hint)}`;
    const b64 = imgUrl ? await toBase64(imgUrl) : null;

    let identity: any;
    try {
      identity = await analyzeImagesWithFallback(b64 ? [b64] : [], promptWithCtx);
    } catch (e: any) {
      console.log(`\n⚠️ ${sku}: vision failed (${String(e.message).slice(0, 60)})`);
      continue;
    }

    console.log(`\n=== ${sku} ===`);
    console.log(`  title : ${title.slice(0, 75)}`);
    console.log(`  photo : ${imgUrl ? "yes" : "NO IMAGE"}`);
    console.log(`  → ${identity.brand} | ${identity.product_line} | ${identity.flavor} | ${identity.size} | ${identity.container_type}`);
    console.log(`  base unit : ${identity.base_unit}`);
    console.log(`  UNITS IN LISTING: ${identity.units_in_listing} (${identity.unit_basis})  bundle=${identity.is_bundle}`);
    if (identity.components?.length) console.log(`  components: ${JSON.stringify(identity.components)}`);
    console.log(`  retail query: ${identity.retail_search_query}`);
    console.log(`  confidence: ${identity.confidence}  ${identity.notes ? "— " + identity.notes : ""}`);

    await db.execute({
      sql: `UPDATE SkuShippingData SET productIdentity=?, unitsInListing=?, baseUnitDesc=?, updatedAt=? WHERE sku=?`,
      args: [JSON.stringify(identity), identity.units_in_listing ?? null, identity.base_unit ?? null, now, sku],
    });
  }
  console.log("\n(identity written to SkuShippingData.productIdentity)");
})();
