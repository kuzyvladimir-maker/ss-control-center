// Walmart multipack fix — GENERATE + HOST step (no live publish yet).
//
//   npx tsx scripts/walmart-multipack-publish.ts                 # default SKU set
//   npx tsx scripts/walmart-multipack-publish.ts FaisalX-2272
//
// For each SKU: pull the donor product photo + pack count from the DB,
// compose the clean tiled main image + the quantity badge, upload BOTH to
// R2, and print the public URLs + the rewritten title/bullets/description.
// Vladimir opens the URLs to review. Live Walmart feed submission is a
// separate, later step.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { composeTiledMainImage, renderBadgeImage, fetchImageBuffer, highResImageUrl } from "../src/lib/walmart/multipack/composite";
import { rewriteMultipackContent, inferUnitNoun } from "../src/lib/walmart/multipack/content";
import { uploadToR2, multipackImageKey } from "../src/lib/walmart/multipack/r2";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const DEFAULT_SKUS = ["FaisalX-2272"];
// date stamp passed in (libs must not call Date.now) — fine to compute here in a script
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "");

async function loadCandidate(sku: string) {
  const w = await db.execute({
    sql: `SELECT w.title AS wtitle, COALESCE(s.unitsInListing,c.packSize) AS pack
          FROM WalmartCatalogItem w
          LEFT JOIN SkuShippingData s ON s.sku=w.sku
          LEFT JOIN SkuCost c ON c.sku=w.sku
          WHERE w.sku=? LIMIT 1`,
    args: [sku],
  });
  const wr = w.rows[0] as any;
  if (!wr) return null;
  const r = await db.execute({
    sql: `SELECT imageUrls FROM RetailPrice
          WHERE sku=? AND imageUrls IS NOT NULL AND imageUrls != ''
          ORDER BY (CASE WHEN COALESCE(packSizeSeen,1)=1 THEN 0 ELSE 1 END), confidence DESC
          LIMIT 1`,
    args: [sku],
  });
  const rr = r.rows[0] as any;
  if (!rr) return null;
  let imgs: string[] = [];
  try { imgs = JSON.parse(rr.imageUrls); } catch { imgs = [rr.imageUrls]; }
  const raw = imgs.find((u) => typeof u === "string" && u.startsWith("http")) ?? "";
  if (!raw) return null;
  return {
    sku,
    walmartTitle: wr.wtitle ?? sku,
    packCount: Number(wr.pack) || 2,
    baseImageUrl: highResImageUrl(raw),
  };
}

async function main() {
  const skus = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SKUS;
  console.log(`\nWalmart multipack — GENERATE + HOST (no live publish)\n`);
  for (const sku of skus) {
    const cand = await loadCandidate(sku);
    if (!cand) { console.log(`  ${sku}: SKIP (no pack count or donor photo)`); continue; }
    const noun = inferUnitNoun(cand.walmartTitle);
    console.log(`▶ ${sku}  [${cand.packCount}× ${noun}]`);

    const base = await fetchImageBuffer(cand.baseImageUrl);
    const main = await composeTiledMainImage(base, cand.packCount);
    const badge = await renderBadgeImage(base, cand.packCount, { noun });

    const mainUrl = await uploadToR2(main, multipackImageKey(sku, "main", STAMP));
    const badgeUrl = await uploadToR2(badge, multipackImageKey(sku, "badge", STAMP));

    const content = rewriteMultipackContent(cand.walmartTitle, cand.packCount, { noun });

    console.log(`\n  MAIN  image: ${mainUrl}`);
    console.log(`  BADGE image: ${badgeUrl}`);
    console.log(`\n  BEFORE title: ${cand.walmartTitle}`);
    console.log(`  AFTER  title: ${content.title}  (${content.title.length} chars)`);
    console.log(`\n  Bullets:`);
    content.bullets.forEach((b) => console.log(`   - ${b}`));
    console.log(`\n  Description:\n   ${content.description.replace(/\n/g, "\n   ")}\n`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
