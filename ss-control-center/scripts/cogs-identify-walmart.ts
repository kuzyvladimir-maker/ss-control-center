// COGS engine — Walmart-input sibling of the brain (cogs-identify.ts).
// The Amazon brain reads listings via SP-API; our Walmart listings live in OUR
// DB instead (WalmartCatalogItem.title/itemId/mainImageUrl, with productTitle in
// SkuShippingData as fallback). This runner feeds those into the SAME vision
// identify logic so we can resolve Walmart SKUs to a canonical product + clean
// retail search query — the "Link A" output we hand to Jackie's price services.
//
// It does NOT modify the Amazon brain. Same PROMPT verbatim so resolution matches.
//
//   npx tsx scripts/cogs-identify-walmart.ts                  # default = Jackie's 13 pilot SKUs
//   npx tsx scripts/cogs-identify-walmart.ts FaisalX-1268 ... # explicit SKUs
//
// Writes identity to SkuShippingData.productIdentity (+ unitsInListing, baseUnitDesc),
// prints a readable summary, and emits a Jackie-ready batch JSON to
//   ../docs/sourcing/brain-walmart-batch.json   (array; one record per SKU).

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { analyzeImagesWithFallback } from "@/lib/ai-vision";
import { writeFileSync, mkdirSync } from "node:fs";

// Jackie's exact 13-SKU pilot bed (so we can compare brain-resolved vs his raw-title 9/13).
const DEFAULT_POOL = [
  "FaisalX-1241", "FaisalX-1229", "RizwanX-4597", "RizwanX-2168", "RizwanX-199",
  "FaisalX-1646", "FaisalX-1215", "FaisalX-1121", "FaisalX-1142", "FaisalX-1268",
  "FaisalX-3743", "FaisalX-1244", "RizwanX-3877",
];
const SKUS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const POOL = SKUS.length ? SKUS : DEFAULT_POOL;

// VERBATIM from cogs-identify.ts — keep identical so Walmart and Amazon resolve the same way.
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
  "is_bundle": false,          // TRUE only if the listing has MULTIPLE DIFFERENT products (variety/assorted pack). A multipack of the SAME product ("Pack of 6", "12 count") is NOT a bundle → false + units_in_listing>1.
  "components": [],            // REQUIRED when is_bundle=true: one entry per DISTINCT product, decomposed FROM THE PHOTO: [{"product":"","flavor":"","size":"","qty":0}] (e.g. a 4-flavor canned-veg variety = 4 entries). Else [].
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
  const batch: any[] = [];

  for (const sku of POOL) {
    // Title + image + itemId from our Walmart catalog cache; title fallback from SkuShippingData.
    const cat = await db.execute({
      sql: `SELECT title, itemId, mainImageUrl, publishedStatus FROM WalmartCatalogItem WHERE sku=? LIMIT 1`,
      args: [sku],
    });
    const ship = await db.execute({
      sql: `SELECT productTitle, category FROM SkuShippingData WHERE sku=? LIMIT 1`,
      args: [sku],
    });
    const title = (cat.rows[0]?.title as string) || (ship.rows[0]?.productTitle as string) || "";
    const itemId = (cat.rows[0]?.itemId as string) || null;
    const imgUrl = (cat.rows[0]?.mainImageUrl as string) || null;
    const category = (ship.rows[0]?.category as string) || null;

    if (!title) { console.log(`\n❌ ${sku}: no title in catalog or SkuShippingData`); continue; }

    const promptWithCtx =
      `${PROMPT}\n\nLISTING TITLE: ${title}\nCATEGORY: ${category ?? "unknown"} (Frozen items still have a bare retail unit)`;
    const b64 = imgUrl ? await toBase64(imgUrl) : null;

    let identity: any;
    try {
      identity = await analyzeImagesWithFallback(b64 ? [b64] : [], promptWithCtx);
    } catch (e: any) {
      console.log(`\n⚠️ ${sku}: vision failed (${String(e.message).slice(0, 70)})`);
      continue;
    }

    console.log(`\n=== ${sku} ===`);
    console.log(`  title : ${title.slice(0, 78)}`);
    console.log(`  photo : ${imgUrl ? "yes" : "TITLE-ONLY (no cached image)"}`);
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

    batch.push({
      sku,
      our_title: title,
      walmart_item_id: itemId,
      category,
      // Link A → Link B handoff: the clean, disambiguated target for Jackie's services.
      retail_search_query: identity.retail_search_query,
      base_unit: identity.base_unit,
      brand: identity.brand,
      product_line: identity.product_line,
      flavor: identity.flavor,
      size: identity.size,
      container_type: identity.container_type,
      units_in_listing: identity.units_in_listing,
      is_bundle: identity.is_bundle,
      components: identity.components ?? [],
      confidence: identity.confidence,
      notes: identity.notes ?? "",
    });
  }

  mkdirSync("../docs/sourcing", { recursive: true });
  const out = "../docs/sourcing/brain-walmart-batch.json";
  writeFileSync(out, JSON.stringify(batch, null, 2));
  console.log(`\n✅ ${batch.length}/${POOL.length} resolved. Identity written to SkuShippingData.productIdentity.`);
  console.log(`   Jackie-ready batch → ${out}`);
})();
