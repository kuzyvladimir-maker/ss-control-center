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

// Whole-table snapshot, cached for the lifetime of the function instance.
//
// Measured 2026-07-30 against production Turso: this table is 5,919 rows /
// ~6.8 MB and takes ~3.9s to pull. Both the shipping plan and the manual
// rate picker awaited that pull on every single call — to read the weight and
// box of ONE SKU. That was several seconds of dead time on every page load and
// on every open of the Carrier dialog.
//
// The table only changes when the operator edits SKU dimensions, and every
// writer calls `invalidateSkuDatabaseCache()`, so a short TTL is belt-and-
// braces against a write we didn't route through this module rather than the
// primary correctness mechanism.
const SKU_CACHE_TTL_MS = 60_000;
let skuCache: { rows: SkuRow[]; fetchedAt: number } | null = null;
// Shared in-flight pull, so concurrent callers on a cold instance await one
// query instead of each dragging their own copy of the table across the wire.
let skuCacheInFlight: Promise<SkuRow[]> | null = null;

/**
 * Drop the cached snapshot. MUST be called by anything that writes
 * SkuShippingData, otherwise a freshly edited weight/box would keep quoting at
 * the old dimensions until the TTL expired.
 */
export function invalidateSkuDatabaseCache(): void {
  skuCache = null;
  skuCacheInFlight = null;
}

export async function fetchSkuDatabase(): Promise<SkuRow[]> {
  if (skuCache && Date.now() - skuCache.fetchedAt < SKU_CACHE_TTL_MS) {
    return skuCache.rows;
  }
  if (skuCacheInFlight) return skuCacheInFlight;

  skuCacheInFlight = (async () => {
    const rows = await prisma.skuShippingData.findMany({
      orderBy: { sku: "asc" },
    });
    const mapped = rows.map(toSkuRow);
    skuCache = { rows: mapped, fetchedAt: Date.now() };
    return mapped;
  })();
  try {
    return await skuCacheInFlight;
  } finally {
    skuCacheInFlight = null;
  }
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
  // The snapshot now describes stale dimensions — drop it so the next quote
  // uses what the operator just saved.
  invalidateSkuDatabaseCache();
  return true;
}
