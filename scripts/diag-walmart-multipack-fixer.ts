// PILOT (dry-run, NO publish): Walmart Quantity-Confusion Fix on 2 listings.
// Reads the real single-unit product photo + pack count from our DB, then
// writes preview files you can open: NEW main image (tiled), NEW secondary
// badge image, and the rewritten title/bullets. Nothing is pushed to Walmart.
//
//   npx tsx scripts/diag-walmart-multipack-fixer.ts                       # default 2 SKUs
//   npx tsx scripts/diag-walmart-multipack-fixer.ts FaisalX-2272 FaisalX-1732
//
// Output dir: ../preview-multipack/  (repo root, gitignored)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { composeTiledMainImage, renderBadgeImage, fetchImageBuffer, highResImageUrl } from "../src/lib/walmart/multipack/composite";
import { rewriteMultipackContent, inferUnitNoun } from "../src/lib/walmart/multipack/content";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Diverse pilot set on purpose: a bottle, a bread bag, cans, a pasta box — so
// the spacing/cutout logic is judged across very different product shapes.
const DEFAULT_SKUS = [
  "FaisalX-2272", // BODYARMOR drink bottle (8)
  "FaisalX-1732", // Nature's Own bread bag (7)
  "RizwanX-3152", // Bush's pinto beans can (4) — low-res donor URL test
  "FaisalX-3755", // Progresso soup can (6)
  "RizwanX-2330", // Barilla pasta (4)
  "RizwanX-3011", // Contadina tomato paste small can (6)
];
const OUT = join(process.cwd(), "..", "preview-multipack");

interface Candidate {
  sku: string;
  walmartTitle: string;
  packCount: number;
  baseImageUrl: string;
}

async function loadCandidate(sku: string): Promise<Candidate | null> {
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

  // A single-unit base photo: prefer a RetailPrice row whose matched listing was
  // NOT itself a multipack (packSizeSeen 1/null), so tiling reflects true count.
  const r = await db.execute({
    sql: `SELECT imageUrls, packSizeSeen FROM RetailPrice
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
  const baseImageUrl = highResImageUrl(raw); // drop thumbnail params for full res

  return {
    sku,
    walmartTitle: wr.wtitle ?? sku,
    packCount: Number(wr.pack) || 2,
    baseImageUrl,
  };
}

async function main() {
  const skus = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SKUS;
  mkdirSync(OUT, { recursive: true });
  console.log(`\nPILOT — Walmart Quantity-Confusion Fix (dry-run, no publish)`);
  console.log(`Output: ${OUT}\n`);

  const summaries: string[] = [];
  for (const sku of skus) {
    const cand = await loadCandidate(sku);
    if (!cand) { console.log(`  ${sku}: SKIP (no pack count or base photo)`); continue; }
    const noun = inferUnitNoun(cand.walmartTitle);
    console.log(`▶ ${sku}  [${cand.packCount}× ${noun}]  ${cand.walmartTitle.slice(0, 60)}`);

    const base = await fetchImageBuffer(cand.baseImageUrl);
    const bm = await sharp(base).metadata();
    console.log(`   source photo: ${bm.width}x${bm.height}px`);
    writeFileSync(join(OUT, `${sku}-0-BEFORE-main.png`), await sharpToPng(base));

    const main = await composeTiledMainImage(base, cand.packCount);
    writeFileSync(join(OUT, `${sku}-1-AFTER-main-tiled.png`), main);

    const badge = await renderBadgeImage(base, cand.packCount, { noun });
    writeFileSync(join(OUT, `${sku}-2-AFTER-badge.png`), badge);

    const content = rewriteMultipackContent(cand.walmartTitle, cand.packCount, { noun });
    summaries.push(
      `## ${sku}  (${cand.packCount}× ${noun})\n\n` +
      `**BEFORE title:** ${cand.walmartTitle}\n\n` +
      `**AFTER title:** ${content.title}  _(${content.title.length} chars)_\n\n` +
      `**AFTER bullets:**\n${content.bullets.map((b) => `- ${b}`).join("\n")}\n\n` +
      `**AFTER description:**\n${content.description}\n\n` +
      `Images: \`${sku}-0-BEFORE-main.png\` → \`${sku}-1-AFTER-main-tiled.png\` + \`${sku}-2-AFTER-badge.png\`\n`,
    );
    console.log(`   wrote BEFORE + AFTER main + badge + content\n`);
  }

  writeFileSync(join(OUT, "PREVIEW.md"), `# Multipack Fix — Pilot Preview\n\n${summaries.join("\n---\n\n")}`);
  console.log(`Summary: ${join(OUT, "PREVIEW.md")}`);
  console.log(`Open the PNGs in ${OUT} to review.\n`);
}

// Normalize the BEFORE image to PNG on white so it sits next to the AFTERs.
async function sharpToPng(buf: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(buf).flatten({ background: { r: 255, g: 255, b: 255 } }).resize(2000, 2000, { fit: "inside", background: { r: 255, g: 255, b: 255 } }).png().toBuffer();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
