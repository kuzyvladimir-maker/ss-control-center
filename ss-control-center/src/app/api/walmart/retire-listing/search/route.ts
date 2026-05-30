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

  try {
    const r = await searchWalmartCatalogCache(prisma, STORE_INDEX, query, {
      limit,
      includeUnpublished,
    });

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
