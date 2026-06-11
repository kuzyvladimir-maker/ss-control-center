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
  // How many ALSO-matching items were hidden because they aren't PUBLISHED
  // (only set when includeUnpublished is false). Lets the UI say "N more in
  // UNPUBLISHED — enable the checkbox" instead of a bare "nothing found".
  excludedByStatus?: number;
}

// Words too generic to help locate a product — dropped from tokenization so
// ranking keys on the brand/flavour words that actually discriminate.
const SEARCH_STOPWORDS = new Set([
  "the", "of", "a", "an", "and", "with", "for", "to", "in", "on", "by", "or",
  "oz", "fl", "ct", "pack", "count", "fluid", "ounce",
]);

/** Split a query into distinct lowercase search tokens (≥2 chars, no stopwords). */
function tokenizeQuery(q: string): string[] {
  return Array.from(
    new Set(
      q
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t)),
    ),
  );
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
  const tokens = tokenizeQuery(q);

  // RECALL: match items containing ANY query token in title OR sku — so a
  // title that differs by a word ("Hidden Valley Ranch ... Taco" vs the typed
  // "Hidden Valley The Original Ranch Taco") still surfaces, instead of the
  // old whole-string `contains` that needed the exact phrase verbatim and
  // returned nothing. Falls back to whole-string when there are no usable
  // tokens (e.g. a query that's all stopwords/symbols).
  const tokenOr =
    tokens.length > 0
      ? tokens.flatMap((t) => [
          { title: { contains: t } },
          { sku: { contains: t } },
        ])
      : [{ title: { contains: q } }, { sku: { contains: q } }];
  const baseWhere: Record<string, unknown> = { storeIndex, OR: tokenOr };
  const where: Record<string, unknown> = opts.includeUnpublished
    ? baseWhere
    : { ...baseWhere, publishedStatus: "PUBLISHED" };

  // Pull a generous candidate set and rank in-process — the cache is only a
  // few thousand rows so this stays sub-second.
  const CANDIDATES = 400;
  const [rows, totalInCache, newest, excludedByStatus] = await Promise.all([
    prisma.walmartCatalogItem.findMany({ where, take: CANDIDATES }),
    prisma.walmartCatalogItem.count({ where: { storeIndex } }),
    prisma.walmartCatalogItem.findFirst({
      where: { storeIndex },
      orderBy: { syncedAt: "desc" },
      select: { syncedAt: true },
    }),
    // Matches that exist but are hidden by the PUBLISHED-only filter.
    opts.includeUnpublished
      ? Promise.resolve(0)
      : prisma.walmartCatalogItem.count({
          where: { ...baseWhere, NOT: { publishedStatus: "PUBLISHED" } },
        }),
  ]);

  // RELEVANCE: rank by (1) exact whole-query phrase present, (2) most distinct
  // query tokens matched, (3) shorter title (a more specific match), so the
  // best candidates lead even though the WHERE matched on ANY token.
  const qLower = q.toLowerCase();
  const ranked = rows
    .map((r) => {
      const hay = `${r.title ?? ""} ${r.sku ?? ""}`.toLowerCase();
      const tokenHits = tokens.filter((t) => hay.includes(t)).length;
      const phrase = qLower && hay.includes(qLower) ? 1 : 0;
      return { r, tokenHits, phrase, len: (r.title ?? "").length };
    })
    .sort(
      (a, b) =>
        b.phrase - a.phrase || b.tokenHits - a.tokenHits || a.len - b.len,
    )
    .slice(0, limit);

  return {
    matches: ranked.map(({ r }) => ({
      itemId: r.itemId ?? "",
      sku: r.sku,
      title: r.title ?? "",
      lifecycleStatus: r.lifecycleStatus ?? "",
      publishedStatus: r.publishedStatus ?? "",
    })),
    count: ranked.length,
    totalInCache,
    lastSyncedAt: newest?.syncedAt ?? null,
    excludedByStatus,
  };
}

/** How many catalog rows we've cached for an account (0 ⇒ never synced). */
export async function catalogCacheSize(
  prisma: PrismaClient,
  storeIndex: number,
): Promise<number> {
  return prisma.walmartCatalogItem.count({ where: { storeIndex } });
}
