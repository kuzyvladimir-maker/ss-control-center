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
// writer calls `invalidateSkuDatabaseCache()` — but that only clears the cache
// of the ONE serverless instance that served the write. On Vercel the next
// request routinely lands on a DIFFERENT instance, which still holds its own
// snapshot from up to a minute ago. That is exactly what made "Edit package →
// Save" look like it did nothing: the save landed in the DB, and the re-quote
// that followed read a stale snapshot on another instance and reported "no
// package dimensions for this SKU" again. Retrying sometimes hit the instance
// that had invalidated, which is why it "worked on the second or third try".
//
// So before serving a cached snapshot we ask the DB for a tiny stamp — row
// count + newest updatedAt — and refetch when it differs from the stamp the
// snapshot was built with. One small round trip instead of a 6.8 MB pull, and
// it is correct across instances, which the in-process invalidation is not.
const SKU_CACHE_TTL_MS = 60_000;
interface SkuTableStamp {
  count: number;
  maxUpdatedMs: number;
}
let skuCache: {
  rows: SkuRow[];
  fetchedAt: number;
  stamp: SkuTableStamp | null;
} | null = null;
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

/**
 * Cheap "has anything changed?" probe: how many rows are in the table and when
 * was the newest one last written. Returns null when the probe itself fails —
 * callers then keep whatever snapshot they have rather than dropping a good
 * cache over a hiccup.
 */
async function readSkuTableStamp(): Promise<SkuTableStamp | null> {
  try {
    const agg = await prisma.skuShippingData.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    return {
      count: agg._count._all,
      maxUpdatedMs: agg._max.updatedAt ? agg._max.updatedAt.getTime() : 0,
    };
  } catch (e) {
    console.warn(
      "[sku-database] freshness probe failed (serving cached snapshot):",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export async function fetchSkuDatabase(): Promise<SkuRow[]> {
  if (skuCache && Date.now() - skuCache.fetchedAt < SKU_CACHE_TTL_MS) {
    const stamp = await readSkuTableStamp();
    const unchanged =
      stamp == null ||
      skuCache.stamp == null ||
      (stamp.count === skuCache.stamp.count &&
        stamp.maxUpdatedMs === skuCache.stamp.maxUpdatedMs);
    if (unchanged) return skuCache.rows;
    // Somebody (another instance, a script, a cron) wrote to the table since
    // this snapshot was taken — drop it and pull fresh.
    skuCache = null;
  }
  if (skuCacheInFlight) return skuCacheInFlight;

  skuCacheInFlight = (async () => {
    // Only the shipping columns: the table also carries heavy identify/COGS
    // text, and pulling every column took ~7 s for 5.9k rows (2026-10-26).
    const rows = await prisma.skuShippingData.findMany({
      orderBy: { sku: "asc" },
      select: {
        sku: true,
        productTitle: true,
        marketplace: true,
        category: true,
        length: true,
        width: true,
        height: true,
        weight: true,
        weightFedex: true,
        updatedAt: true,
      },
    });
    const mapped = rows.map(toSkuRow);
    const maxUpdatedMs = rows.reduce(
      (max, r) => Math.max(max, r.updatedAt ? r.updatedAt.getTime() : 0),
      0,
    );
    skuCache = {
      rows: mapped,
      fetchedAt: Date.now(),
      stamp: { count: rows.length, maxUpdatedMs },
    };
    return mapped;
  })();
  try {
    return await skuCacheInFlight;
  } finally {
    skuCacheInFlight = null;
  }
}

/**
 * Only the rows for these SKUs — what the shipping plan actually reads (the
 * first line's SKU of each order). Pulling the whole 5.9k-row table for that
 * cost 39–41 s on a cold Vercel instance (2026-10-26); a keyed IN-query is one
 * ~40 ms round trip, and always fresh, so no cross-instance staleness either.
 */
export async function fetchSkuRows(skus: string[]): Promise<SkuRow[]> {
  const wanted = [...new Set(skus.map((s) => s.trim()).filter(Boolean))];
  const out: SkuRow[] = [];
  for (let i = 0; i < wanted.length; i += 500) {
    const rows = await prisma.skuShippingData.findMany({
      where: { sku: { in: wanted.slice(i, i + 500) } },
      select: {
        sku: true,
        productTitle: true,
        marketplace: true,
        category: true,
        length: true,
        width: true,
        height: true,
        weight: true,
        weightFedex: true,
      },
    });
    out.push(...rows.map(toSkuRow));
  }
  return out;
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
