/**
 * scripts/migrate-sku-from-sheets.ts
 *
 * One-off migration: pull all SKU data from the Google Sheets "SKU Shipping
 * Database v2" and write to the internal SkuShippingData table. Safe to
 * re-run (upsert by `sku`).
 *
 * Usage:
 *   # Local SQLite
 *   npx tsx --env-file=.env scripts/migrate-sku-from-sheets.ts
 *
 *   # Turso prod (Prisma picks up TURSO_* from env automatically)
 *   npx tsx --env-file=.env scripts/migrate-sku-from-sheets.ts --prod
 *
 * Required env: GOOGLE_SHEETS_ID, GOOGLE_SHEETS_API_KEY (read-only for the
 * sheet — write API key not needed; we only fetch the CSV export).
 *
 * Side-effect: writes a frozen dump to prisma/seed/sku-database.json so the
 * repo stays self-sufficient after the Google sheet goes away.
 */

import { fetchSkuDatabase } from "../src/lib/google-sheets";
import { prisma } from "../src/lib/prisma";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

async function main() {
  console.log("Fetching SKU data from Google Sheets…");
  const rows = await fetchSkuDatabase();
  console.log(`  Found ${rows.length} rows`);

  // 1. Save raw dump so future clones of the repo can reconstruct the
  //    table without touching Google. Lives at prisma/seed/sku-database.json
  //    and IS committed.
  const seedDir = resolve(process.cwd(), "prisma", "seed");
  if (!existsSync(seedDir)) mkdirSync(seedDir, { recursive: true });
  const seedPath = resolve(seedDir, "sku-database.json");
  writeFileSync(
    seedPath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        source: "Google Sheets SKU Shipping Database v2",
        rowCount: rows.length,
        rows,
      },
      null,
      2
    )
  );
  console.log(`  Saved dump → ${seedPath}`);

  // 2. Upsert each row. We intentionally don't blow away existing manual
  //    edits — when a column comes back nullish from Google, we leave the
  //    existing DB value alone (`?? undefined` → Prisma skips the field).
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row.sku) {
      skipped++;
      continue;
    }
    const existing = await prisma.skuShippingData.findUnique({
      where: { sku: row.sku },
      select: { id: true },
    });
    await prisma.skuShippingData.upsert({
      where: { sku: row.sku },
      create: {
        sku: row.sku,
        productTitle: row.productTitle || null,
        marketplace: row.marketplace || null,
        category: row.category || null,
        length: row.length,
        width: row.width,
        height: row.height,
        weight: row.weight,
        weightFedex: row.weightFedex,
        source: "google_sheets_migration",
      },
      update: {
        productTitle: row.productTitle || undefined,
        marketplace: row.marketplace || undefined,
        category: row.category || undefined,
        length: row.length ?? undefined,
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        weight: row.weight ?? undefined,
        weightFedex: row.weightFedex ?? undefined,
      },
    });
    if (existing) updated++;
    else inserted++;
  }

  console.log("\n✓ Migration complete:");
  console.log(`    inserted: ${inserted}`);
  console.log(`    updated:  ${updated}`);
  console.log(`    skipped:  ${skipped}`);
  console.log(`    total:    ${rows.length}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
