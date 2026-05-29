/**
 * Walmart catalog cache — sync + search.
 *
 * Why this exists: Walmart's /v3/items API has NO server-side text search.
 * Finding "every SKU whose title contains X" means paginating the whole
 * catalog (~5 000 items, ~20 sequential API calls, 40-60 s). That's fine
 * once a night but unacceptable as an interactive lookup for Jackie.
 *
 * So the nightly cron mirrors the full catalog into WalmartCatalogItem
 * (see iterateWalmartCatalog in ./items), and live search reads that table
 * in a few ms. Names/SKUs change rarely, so a few-hours-stale mirror is fine
 * for name→SKU lookup. Inventory WRITES are untouched — they still hit
 * Walmart in real time via walmart_inventory_update.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { WalmartClient } from "./client";
import { iterateWalmartCatalog, type WalmartItemSummary } from "./items";

export interface CatalogSyncResult {
  storeIndex: number;
  written: number;
  replaced: number;
}

// Rows-per-INSERT. ~8 columns → ~4000 bound params/statement, well under
// libsql's 32 766 variable cap, and ~5300 rows becomes ~11 statements instead
// of 50+ — fewer network round-trips to Turso.
const INSERT_CHUNK = 500;

// The whole replace runs in one interactive transaction over remote Turso,
// where every statement is a round-trip. Prisma's default 5s cap is far too
// short for ~5000 rows — give it room (nightly single-writer job).
const TX_TIMEOUT_MS = 120_000;

/**
 * Refresh the WalmartCatalogItem mirror for one account.
 *
 * Walmart has no text search, so we must page the whole catalog regardless.
 * We buffer it in memory (~5000 small rows) and then REPLACE the mirror in a
 * single transaction: delete this account's rows, then createMany in chunks.
 * That's a handful of statements instead of thousands of per-row upserts —
 * critical because the runtime DB is Turso (remote libsql), where every
 * statement is a network round-trip.
 *
 * Safety: if Walmart paging throws, we never touch the DB. If the transaction
 * throws, it rolls back — the previous mirror stays intact. So a failed sync
 * degrades to "stale", never to "empty" or "corrupt".
 */
export async function syncWalmartCatalog(
  prisma: PrismaClient,
  client: WalmartClient,
  storeIndex: number,
): Promise<CatalogSyncResult> {
  const syncedAt = new Date();
  const seen = new Set<string>();
  const rows: Array<{
    storeIndex: number;
    sku: string;
    itemId: string | null;
    title: string | null;
    lifecycleStatus: string | null;
    publishedStatus: string | null;
    syncedAt: Date;
  }> = [];

  for await (const item of iterateWalmartCatalog(client)) {
    if (!item.sku || seen.has(item.sku)) continue; // need a SKU; dedup
    seen.add(item.sku);
    rows.push({
      storeIndex,
      sku: item.sku,
      itemId: item.itemId || null,
      title: item.title || null,
      lifecycleStatus: item.lifecycleStatus || null,
      publishedStatus: item.publishedStatus || null,
      syncedAt,
    });
  }

  const replaced = await prisma.$transaction(
    async (tx) => {
      const prior = await tx.walmartCatalogItem.deleteMany({ where: { storeIndex } });
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await tx.walmartCatalogItem.createMany({ data: rows.slice(i, i + INSERT_CHUNK) });
      }
      return prior.count;
    },
    { timeout: TX_TIMEOUT_MS, maxWait: 10_000 },
  );

  return { storeIndex, written: rows.length, replaced };
}

export interface CatalogSearchResult {
  matches: WalmartItemSummary[];
  count: number;
  totalInCache: number;
  lastSyncedAt: Date | null;
}

/**
 * Substring search (case-insensitive for ASCII via SQLite LIKE) over the
 * cached catalog. Matches SKU OR title. Defaults to PUBLISHED items only —
 * the ones customers can buy, which is what zeroing inventory affects.
 */
export async function searchWalmartCatalogCache(
  prisma: PrismaClient,
  storeIndex: number,
  query: string,
  opts: { limit?: number; includeUnpublished?: boolean } = {},
): Promise<CatalogSearchResult> {
  const q = query.trim();
  const limit = opts.limit ?? 50;

  const where: Record<string, unknown> = {
    storeIndex,
    OR: [{ sku: { contains: q } }, { title: { contains: q } }],
  };
  if (!opts.includeUnpublished) where.publishedStatus = "PUBLISHED";

  const [rows, totalInCache, newest] = await Promise.all([
    prisma.walmartCatalogItem.findMany({ where, take: limit }),
    prisma.walmartCatalogItem.count({ where: { storeIndex } }),
    prisma.walmartCatalogItem.findFirst({
      where: { storeIndex },
      orderBy: { syncedAt: "desc" },
      select: { syncedAt: true },
    }),
  ]);

  return {
    matches: rows.map((r) => ({
      itemId: r.itemId ?? "",
      sku: r.sku,
      title: r.title ?? "",
      lifecycleStatus: r.lifecycleStatus ?? "",
      publishedStatus: r.publishedStatus ?? "",
    })),
    count: rows.length,
    totalInCache,
    lastSyncedAt: newest?.syncedAt ?? null,
  };
}

/** How many catalog rows we've cached for an account (0 ⇒ never synced). */
export async function catalogCacheSize(
  prisma: PrismaClient,
  storeIndex: number,
): Promise<number> {
  return prisma.walmartCatalogItem.count({ where: { storeIndex } });
}
