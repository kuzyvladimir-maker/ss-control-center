// Read-only: find Walmart multipack listings that are good pilot candidates for
// the Quantity-Confusion Fix. A candidate = published Walmart SKU with a known
// pack count (>1), a title, and a usable main image we can tile.
//
//   npx tsx scripts/diag-multipack-candidates.ts
//
// Pack count source priority: SkuShippingData.unitsInListing, else SkuCost.packSize.
// Does NOT modify anything.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { fetchVeeqoImageBySku } from "../src/lib/veeqo/product-image";

const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!;
const authToken = process.env.TURSO_AUTH_TOKEN;
const db = createClient(url.startsWith("libsql") || url.startsWith("http") ? { url, authToken } : { url });

async function main() {
  const rows = await db.execute(`
    SELECT
      w.sku            AS sku,
      w.itemId         AS itemId,
      w.title          AS title,
      w.publishedStatus AS published,
      w.mainImageUrl   AS image,
      s.unitsInListing AS units,
      s.baseUnitDesc   AS baseUnit,
      c.packSize       AS packSize
    FROM WalmartCatalogItem w
    LEFT JOIN SkuShippingData s ON s.sku = w.sku
    LEFT JOIN SkuCost c         ON c.sku = w.sku
    WHERE COALESCE(s.unitsInListing, c.packSize, 1) > 1
    ORDER BY COALESCE(s.unitsInListing, c.packSize) DESC
  `);

  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of rows.rows as any[]) {
    if (seen.has(r.sku)) continue;
    seen.add(r.sku);
    out.push(r);
  }

  console.log(`\nWalmart multipack SKUs (pack > 1): ${out.length}`);
  console.log(`  published: ${out.filter((r) => r.published === "PUBLISHED").length}`);
  console.log(`  (main image not cached in DB — resolving live via Veeqo...)\n`);

  // Resolve a real product photo from Veeqo for each published multipack SKU.
  const published = out.filter((r) => r.published === "PUBLISHED");
  const resolved: any[] = [];
  for (const r of published) {
    const img = r.image || (await fetchVeeqoImageBySku(r.sku));
    resolved.push({ ...r, veeqoImg: img });
    process.stdout.write(img ? "." : "x");
  }
  console.log("\n");

  const ranked = resolved.filter((r) => r.veeqoImg).slice(0, 15);
  console.log(`Tile-able candidates (Veeqo photo resolved): ${ranked.length}\n`);
  for (const r of ranked) {
    const n = r.units ?? r.packSize;
    console.log(`  [${n}x] ${r.sku}  item=${r.itemId ?? "?"}`);
    console.log(`        title: ${(r.title ?? "").slice(0, 90)}`);
    console.log(`        base:  ${r.baseUnit ?? "—"}`);
    console.log(`        photo: ${r.veeqoImg}`);
    console.log("");
  }

  // Also surface total catalog scale for context.
  const total = await db.execute(`SELECT COUNT(*) AS n FROM WalmartCatalogItem WHERE publishedStatus='PUBLISHED'`);
  console.log(`Context: ${(total.rows[0] as any).n} published Walmart SKUs total.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
