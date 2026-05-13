/**
 * Internal SKU shipping database — replaces the Google Sheets "SKU Shipping
 * Database v2" backed by src/lib/google-sheets.ts. Same public API so
 * callers swap only the import path.
 *
 * Migrated 2026-05-12. See docs/wiki/sku-database-migration.md.
 */

import { prisma } from "@/lib/prisma";

export interface SkuRow {
  sku: string;
  productTitle: string;
  marketplace: string;
  category: string;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  weightFedex: number | null;
  hasCompleteData: boolean;
}

interface DbRow {
  sku: string;
  productTitle: string | null;
  marketplace: string | null;
  category: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  weightFedex: number | null;
}

function toSkuRow(row: DbRow): SkuRow {
  // Shipping Labels treats a row as "ready to ship" only when all four
  // physical fields are filled — same rule the Google version used.
  const hasCompleteData =
    row.weight !== null &&
    row.length !== null &&
    row.width !== null &&
    row.height !== null;
  return {
    sku: row.sku,
    productTitle: row.productTitle || "",
    marketplace: row.marketplace || "",
    category: row.category || "",
    length: row.length,
    width: row.width,
    height: row.height,
    weight: row.weight,
    weightFedex: row.weightFedex,
    hasCompleteData,
  };
}

export async function fetchSkuDatabase(): Promise<SkuRow[]> {
  const rows = await prisma.skuShippingData.findMany({
    orderBy: { sku: "asc" },
  });
  return rows.map(toSkuRow);
}

export async function lookupSku(sku: string): Promise<SkuRow | null> {
  const row = await prisma.skuShippingData.findUnique({ where: { sku } });
  return row ? toSkuRow(row) : null;
}

/**
 * Used by the popup SKU editor on the Shipping page. The Google version was
 * append-only; we use upsert so re-saving the same SKU updates instead of
 * blowing up — matches the editor's intent (it shows current values and
 * the user adjusts them).
 */
export async function appendSkuRow(data: {
  sku: string;
  productTitle: string;
  marketplace: string;
  category: string;
  length: number;
  width: number;
  height: number;
  weight: number;
  weightFedex: number;
}): Promise<boolean> {
  await prisma.skuShippingData.upsert({
    where: { sku: data.sku },
    create: {
      sku: data.sku,
      productTitle: data.productTitle,
      marketplace: data.marketplace,
      category: data.category,
      length: data.length,
      width: data.width,
      height: data.height,
      weight: data.weight,
      weightFedex: data.weightFedex,
      sampleCount: 1,
      notes: "Added from Control Center",
      source: "manual",
    },
    update: {
      productTitle: data.productTitle,
      marketplace: data.marketplace,
      category: data.category,
      length: data.length,
      width: data.width,
      height: data.height,
      weight: data.weight,
      weightFedex: data.weightFedex,
    },
  });
  return true;
}
