// Stage 0c — seed the matched Sellerboard COGS into SkuCost (prod Turso).
// Reads docs/cogs-coverage.json (catalog × Sellerboard join) and upserts every
// matched row that has a cost. Dry → productCost (no packaging). Frozen →
// totalCost with includesPackaging=true (Sellerboard frozen bundles pkg+ice) and
// needsReview=true so we later source the BARE product cost for the separation.
//
//   set -a; . ./.env; . ./.env.local; set +a; npx tsx scripts/cogs-seed-sellerboard.ts [--dry-run]

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COVERAGE = resolve(__dirname, "../../docs/cogs-coverage.json");
const DRY = process.argv.includes("--dry-run");

(async () => {
  const rows = JSON.parse(readFileSync(COVERAGE, "utf8")) as any[];
  const seedable = rows.filter((r) => r.matched && r.cost !== null && r.cost !== undefined);
  console.log(`Coverage rows: ${rows.length}; seedable (matched + cost): ${seedable.length}`);

  const c = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const now = new Date().toISOString();
  let dry = 0, frozen = 0, other = 0, written = 0;

  for (const r of seedable) {
    const isFrozen = (r.category ?? "").toLowerCase() === "frozen";
    const isDry = (r.category ?? "").toLowerCase() === "dry";
    const effectiveDate = (r.costDate ?? "") || "";
    const cost = Number(r.cost);

    // Dry: the Sellerboard cost is the bare product cost (no special pkg/ice).
    // Frozen: cost already bundles product+packaging+ice → store as total, flag review.
    const productCost = isFrozen ? null : cost;
    const totalCost = cost;
    const includesPackaging = isFrozen ? 1 : 0;
    const needsReview = isFrozen ? 1 : 0; // frozen needs bare-cost sourcing later
    const id = `sb:${r.sku}:${effectiveDate}`;

    if (isFrozen) frozen++; else if (isDry) dry++; else other++;

    if (DRY) continue;
    await c.execute({
      sql: `INSERT INTO "SkuCost"
        (id, sku, asin, effectiveDate, productCost, packagingCost, iceCost, totalCost,
         costPerUnit, packSize, includesPackaging, currency, source, confidence, needsReview, notes, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(sku, source, effectiveDate) DO UPDATE SET
          asin=excluded.asin, productCost=excluded.productCost, totalCost=excluded.totalCost,
          costPerUnit=excluded.costPerUnit, packSize=excluded.packSize,
          includesPackaging=excluded.includesPackaging, needsReview=excluded.needsReview,
          updatedAt=excluded.updatedAt`,
      args: [
        id, r.sku, r.sbAsin ?? null, effectiveDate, productCost, null, null, totalCost,
        r.costPerUnit ?? null, r.packSize ?? null, includesPackaging, "USD", "sellerboard",
        1.0, needsReview, isFrozen ? "Sellerboard cost incl pkg+ice; bare cost TBD" : null, now, now,
      ],
    });
    written++;
  }

  console.log(`\nSeedable breakdown: Dry ${dry} / Frozen ${frozen} / other ${other}`);
  console.log(DRY ? "DRY RUN — nothing written." : `Upserted ${written} rows into SkuCost.`);

  if (!DRY) {
    const total = await c.execute("SELECT COUNT(*) n FROM SkuCost");
    const bySrc = await c.execute("SELECT source, COUNT(*) n, ROUND(AVG(totalCost),2) avgCost FROM SkuCost GROUP BY source");
    console.log("SkuCost total rows:", total.rows[0].n);
    for (const x of bySrc.rows) console.log(`  ${x.source}: ${x.n} rows, avg total $${x.avgCost}`);
  }
})();
