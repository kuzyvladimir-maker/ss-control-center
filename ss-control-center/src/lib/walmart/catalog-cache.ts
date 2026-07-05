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
import { itemReportIsFresh, MIN_SANE_ROWS } from "./catalog-report-sync";

export interface CatalogSyncResult {
  storeIndex: number;
  written: number;
  replaced: number;
  skipped?: string; // set when this /v3/items sync stepped aside for the ITEM report
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
  // The ITEM report (catalog-report-sync) is the AUTHORITATIVE full catalog. When it
  // has refreshed the mirror recently, this /v3/items sync steps aside — it under-
  // reports (~2981 of 3895 published), so re-running it would overwrite the fuller
  // report data with a smaller set. It stays as a FALLBACK for when the report path
  // is broken/stale.
  if (await itemReportIsFresh(prisma, storeIndex)) {
    return { storeIndex, written: 0, replaced: 0, skipped: "item-report-authoritative" };
  }
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

  // Floor guard (same as the ITEM-report path): a transient /v3/items glitch or an
  // unrecognized response envelope makes iterateWalmartCatalog yield 0 rows and return
  // WITHOUT throwing — the old code would then deleteMany + insert 0, wiping the mirror
  // that Jackie search / account health / the COGS sweep depend on. As the FALLBACK
  // that runs exactly when the guarded report path is already down, it must not wipe.
  if (rows.length < MIN_SANE_ROWS) {
    throw new Error(`/v3/items returned only ${rows.length} SKUs (< ${MIN_SANE_ROWS}) — refusing to replace mirror (degrade to stale, never empty)`);
  }

  // Preserve the lazily-warmed image cache across the replace (mirror of the ITEM path).
  const priorImgs = await prisma.walmartCatalogItem.findMany({
    where: { storeIndex },
    select: { sku: true, mainImageUrl: true, mainImageFetchedAt: true },
  });
  const imgBySku = new Map(priorImgs.map((p) => [p.sku, p]));

  const replaced = await prisma.$transaction(
    async (tx) => {
      const prior = await tx.walmartCatalogItem.deleteMany({ where: { storeIndex } });
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await tx.walmartCatalogItem.createMany({
          data: rows.slice(i, i + INSERT_CHUNK).map((r) => {
            const img = imgBySku.get(r.sku);
            return { ...r, mainImageUrl: img?.mainImageUrl ?? null, mainImageFetchedAt: img?.mainImageFetchedAt ?? null };
          }),
        });
      }
      return prior.count;
    },
    { timeout: TX_TIMEOUT_MS, maxWait: 10_000 },
  );

  return { storeIndex, written: rows.length, replaced };
}

export interface CatalogMatch extends WalmartItemSummary {
  /**
   * How the match relates to the searched product:
   *  - "primary"   — the product itself + its pack / multipack / bundle
   *                  variations (shares the distinctive brand+flavour words).
   *  - "secondary" — a different flavour/line of the SAME brand anchor
   *                  (shown collapsed behind "Показать похожие").
   */
  tier: "primary" | "secondary";
}

export interface CatalogSearchResult {
  matches: CatalogMatch[];
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

// Relevance tiers (see searchWalmartCatalogCache for the full algorithm). A
// candidate is scored by the fraction of the query's rarity-weighted identity
// (brand + product + flavour) it matches:
//  - primary:   the product itself + its pack/multipack/bundle variations —
//               a verbatim-substring (phrase) match, OR it shares the brand
//               anchor AND the "signature" word (the most distinctive non-brand
//               token, e.g. "puffed"/"butterbread"/"nacho") AND covers ≥ MIN.
//  - secondary: shares the brand anchor and covers ≥ MIN — a different
//               flavour/line of the SAME brand (collapsed in the UI).
//  - dropped:   everything else (the loosely-similar cross-brand items that
//               used to flood the list with 100 results).
// Tunable: raise PRIMARY_MIN for a tighter primary list, lower it for wider.
const PRIMARY_MIN = 0.5;
const SECONDARY_MIN = 0.25;

/**
 * Rarity-weighted, two-tier search over the cached catalog.
 *
 * WHY (the "100 loosely-similar results" bug): the old query matched any item
 * sharing ANY query token, so generic food words ("snacks", "crackers",
 * "cheese", "baked") pulled in every vaguely-similar product — and "Снять все
 * найденные" would then zero-out all of them. Here every query word is weighted
 * by how RARE it is across the whole catalog (classic IDF): brand/flavour words
 * ("cheez", "cheddar") are rare → high weight and drive the match; filler words
 * appear everywhere → ~0 weight and no longer create false positives. Items are
 * then bucketed into "primary" (the product + its variations) and "secondary"
 * (same-brand, other flavour) so the modal can show a tight list by default.
 *
 * The mirror is only a few thousand rows, so we scan it fully in-process — this
 * also fixes a latent bug where the old 400-row candidate pull could truncate
 * an arbitrary alphabetical slice and miss the best match.
 *
 * Defaults to PUBLISHED items only — the ones customers can buy, which is what
 * zeroing inventory affects.
 */
export async function searchWalmartCatalogCache(
  prisma: PrismaClient,
  storeIndex: number,
  query: string,
  opts: { limit?: number; includeUnpublished?: boolean } = {},
): Promise<CatalogSearchResult> {
  const q = query.trim();
  const qLower = q.toLowerCase();
  const limit = opts.limit ?? 50;
  const tokens = tokenizeQuery(q);

  const [allRows, newest] = await Promise.all([
    prisma.walmartCatalogItem.findMany({
      where: { storeIndex },
      select: {
        sku: true,
        itemId: true,
        title: true,
        lifecycleStatus: true,
        publishedStatus: true,
      },
    }),
    prisma.walmartCatalogItem.findFirst({
      where: { storeIndex },
      orderBy: { syncedAt: "desc" },
      select: { syncedAt: true },
    }),
  ]);
  const totalInCache = allRows.length;
  const lastSyncedAt = newest?.syncedAt ?? null;

  type Row = (typeof allRows)[number];
  const isPub = (r: Row) => r.publishedStatus === "PUBLISHED";
  const hayOf = (r: Row) => `${r.title ?? ""} ${r.sku ?? ""}`.toLowerCase();
  const toMatch = (r: Row, tier: "primary" | "secondary"): CatalogMatch => ({
    itemId: r.itemId ?? "",
    sku: r.sku,
    title: r.title ?? "",
    lifecycleStatus: r.lifecycleStatus ?? "",
    publishedStatus: r.publishedStatus ?? "",
    tier,
  });

  // No usable tokens (query was all stopwords/symbols) → fall back to a plain
  // whole-string contains so the box still does something.
  if (tokens.length === 0) {
    const matches = allRows
      .filter(
        (r) =>
          (opts.includeUnpublished || isPub(r)) &&
          qLower &&
          hayOf(r).includes(qLower),
      )
      .slice(0, limit)
      .map((r) => toMatch(r, "primary"));
    return {
      matches,
      count: matches.length,
      totalInCache,
      lastSyncedAt,
      excludedByStatus: 0,
    };
  }

  // RARITY WEIGHTS (IDF): document-frequency of each query token across the
  // whole mirror, then weight = ln((N+1)/(df+1)). Rare word → high weight.
  const hays = allRows.map(hayOf);
  const df = new Map<string, number>(tokens.map((t) => [t, 0]));
  for (const hay of hays) {
    for (const t of tokens) if (hay.includes(t)) df.set(t, df.get(t)! + 1);
  }
  const weight = new Map<string, number>();
  for (const t of tokens) {
    const d = df.get(t)!;
    // A token absent from the ENTIRE catalog can't discriminate between items
    // (e.g. the exact product isn't mirrored yet), so give it 0 weight —
    // otherwise it would drag down every item's coverage and could push real
    // variations below the threshold.
    weight.set(t, d === 0 ? 0 : Math.log((totalInCache + 1) / (d + 1)));
  }
  const totalWeight = tokens.reduce((s, t) => s + weight.get(t)!, 0);

  // BRAND ANCHOR: the first query word. Product titles lead with the brand
  // ("Cheez-It …", "Nature's Own …"), so token[0] reliably identifies it —
  // and every real variation (incl. a bundle that merely CONTAINS the product)
  // still carries the brand. Gating the "similar" bucket on the anchor keeps it
  // to the same brand instead of anything sharing one generic word.
  const brandAnchor = tokens[0];

  // SIGNATURE: the most distinctive NON-brand word — the one that actually
  // names this specific product/flavour ("puffed", "butterbread", "nacho",
  // "golden"). Requiring it for the primary tier is what separates a true
  // variation from a same-brand, same-category sibling that differs only by
  // this word (e.g. "Cheez-It Puff'd White Cheddar" vs plain "Cheez-It White
  // Cheddar Crackers", or "Butterbread" vs "WhiteWheat"). Coverage alone can't
  // do this — missing one token out of many is only a small coverage dip. Must
  // be matchable (df ≥ 1); if there's no such word we simply don't require one.
  let signature: string | null = null;
  for (const t of tokens) {
    if (t === brandAnchor || df.get(t)! === 0) continue;
    if (signature === null || weight.get(t)! > weight.get(signature)!) {
      signature = t;
    }
  }

  type Scored = {
    r: Row;
    coverage: number;
    phrase: boolean;
    hits: number;
    hasAnchor: boolean;
    tier: "primary" | "secondary" | null;
  };
  const scored: Scored[] = allRows.map((r, i) => {
    const hay = hays[i];
    let matched = 0;
    let hits = 0;
    for (const t of tokens) {
      if (hay.includes(t)) {
        matched += weight.get(t)!;
        hits++;
      }
    }
    const coverage = totalWeight > 0 ? matched / totalWeight : 0;
    const phrase = !!qLower && hay.includes(qLower);
    const hasAnchor = hay.includes(brandAnchor);
    const hasSignature = signature === null || hay.includes(signature);
    const tier: Scored["tier"] =
      phrase || (hasAnchor && hasSignature && coverage >= PRIMARY_MIN)
        ? "primary"
        : hasAnchor && coverage >= SECONDARY_MIN
          ? "secondary"
          : null;
    return { r, coverage, phrase, hits, hasAnchor, tier };
  });

  const relevant = scored.filter((s) => s.tier !== null);
  const visible = relevant.filter((s) => opts.includeUnpublished || isPub(s.r));
  // Relevant matches hidden purely because they aren't PUBLISHED.
  const excludedByStatus = opts.includeUnpublished
    ? 0
    : relevant.length - visible.length;

  // Rank within each tier: exact phrase first, then most identity matched,
  // then shorter (more specific) title, then most tokens hit.
  const rank = (a: Scored, b: Scored) =>
    Number(b.phrase) - Number(a.phrase) ||
    b.coverage - a.coverage ||
    (a.r.title?.length ?? 1e9) - (b.r.title?.length ?? 1e9) ||
    b.hits - a.hits;

  const primary = visible.filter((s) => s.tier === "primary").sort(rank);
  const secondary = visible.filter((s) => s.tier === "secondary").sort(rank);

  // Primary is the tight list the operator acts on — never truncate it away;
  // fill the remaining budget with "similar" (secondary).
  const primOut = primary.slice(0, limit);
  const secOut = secondary.slice(0, Math.max(0, limit - primOut.length));
  const matches = [
    ...primOut.map((s) => toMatch(s.r, "primary")),
    ...secOut.map((s) => toMatch(s.r, "secondary")),
  ];

  return {
    matches,
    count: matches.length,
    totalInCache,
    lastSyncedAt,
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
