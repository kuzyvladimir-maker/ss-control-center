/**
 * POST /api/walmart/retire-listing/search
 *
 * Body: { query: string; limit?: number; includeUnpublished?: boolean }
 *
 * Wraps searchWalmartCatalogCache so the Procurement "Снять с продажи"
 * modal can find every SKU sharing a product name (multi-pack variants,
 * bundles, etc.). Reads from the nightly catalog mirror — sub-second.
 *
 * Returns each match plus `alreadyRetired: true` if there's an open
 * (not-rolled-back) WalmartListingRetirement row for that SKU, so the UI
 * can grey-out already-zeroed listings instead of letting Vladimir
 * re-zero them.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchWalmartCatalogCache } from "@/lib/walmart/catalog-cache";
import { getWalmartClient } from "@/lib/walmart/client";
import { searchWalmartItems } from "@/lib/walmart/items";

const STORE_INDEX = 1;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const b = body as {
    query?: unknown;
    limit?: unknown;
    includeUnpublished?: unknown;
    // When true, hit Walmart's live catalog instead of the cache mirror —
    // slower (~exact-SKU is instant, a title scan is up to ~20s) but
    // AUTHORITATIVE. The cache can miss a freshly-published SKU (e.g.
    // RizwanX-65 was live+PUBLISHED but absent from the 13h-old mirror), so
    // the modal offers this as a fallback when the cached results don't
    // contain the product.
    live?: unknown;
  };

  const query = typeof b.query === "string" ? b.query.trim() : "";
  if (!query) {
    return NextResponse.json(
      { error: "query is required and must be a non-empty string" },
      { status: 400 },
    );
  }

  const limit =
    typeof b.limit === "number" && Number.isFinite(b.limit) && b.limit > 0
      ? Math.min(200, Math.floor(b.limit))
      : 50;
  const includeUnpublished = b.includeUnpublished === true;
  const live = b.live === true;

  try {
    // r: a uniform shape from EITHER the fast cache mirror or the live
    // (authoritative) Walmart catalog scan.
    let r: {
      matches: Array<{
        itemId: string;
        sku: string;
        title: string;
        lifecycleStatus: string;
        publishedStatus: string;
        // "primary" = the product + its pack/multipack/bundle variations;
        // "secondary" = same-brand, different flavour (collapsed in the UI).
        tier: "primary" | "secondary";
      }>;
      count: number;
      totalInCache: number;
      lastSyncedAt: Date | null;
      excludedByStatus: number;
      live: boolean;
    };
    if (live) {
      const client = getWalmartClient(STORE_INDEX);
      const res = await searchWalmartItems(client, query, {
        limit,
        includeUnpublished,
        // Scan the WHOLE catalog (~5300 items) — the default 4500 cap stopped
        // before reaching late items like RizwanX-65, so a title that lives
        // past the cap (and isn't in the cache) was still unfindable. This is
        // an explicit, on-demand fallback, so the extra ~10s is acceptable.
        maxItemsScanned: 9000,
      });
      r = {
        // Live is a whole-string substring scan (already strict — it needs the
        // typed query as a verbatim substring), so there's no loose tail to
        // tier; treat every live hit as a primary match.
        matches: res.matches.map((m) => ({ ...m, tier: "primary" as const })),
        count: res.matches.length,
        totalInCache: res.totalItemsAvailable,
        lastSyncedAt: null,
        excludedByStatus: 0,
        live: true,
      };
    } else {
      const c = await searchWalmartCatalogCache(prisma, STORE_INDEX, query, {
        limit,
        includeUnpublished,
      });
      r = { ...c, excludedByStatus: c.excludedByStatus ?? 0, live: false };
    }

    // Mark SKUs that are already on the retired list (open rows, not yet
    // rolled back). Single grouped query instead of N per-row lookups.
    const skus = r.matches.map((m) => m.sku);
    const openRetirements =
      skus.length === 0
        ? []
        : await prisma.walmartListingRetirement.findMany({
            where: {
              storeIndex: STORE_INDEX,
              sku: { in: skus },
              rolledBackAt: null,
            },
            select: { sku: true, retiredAt: true },
          });
    const retiredMap = new Map(openRetirements.map((r) => [r.sku, r.retiredAt]));

    return NextResponse.json({
      query,
      count: r.count,
      totalInCache: r.totalInCache,
      cacheLastSyncedAt: r.lastSyncedAt,
      // True when these results came from the live Walmart catalog (fallback),
      // not the cache mirror.
      live: r.live,
      // Matches that exist only in non-PUBLISHED statuses (hidden by the
      // unchecked "include UNPUBLISHED" box) — the UI hints at these.
      excludedByStatus: r.excludedByStatus ?? 0,
      matches: r.matches.map((m) => ({
        ...m,
        alreadyRetired: retiredMap.has(m.sku),
        retiredAt: retiredMap.get(m.sku) ?? null,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[retire-listing/search] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
