/**
 * POST /api/walmart/retire-listing/execute
 *
 * Body: {
 *   skus: string[];          // 1..N seller SKUs to zero
 *   reason?: string;         // free-form, persisted on audit row
 *   triggeredFrom?: string;  // e.g. "procurement:200014888886083"
 *   searchQuery?: string;    // what was typed into the modal
 * }
 *
 * For each SKU:
 *   1. Walmart PUT /v3/inventory amount=0 (same call walmart_inventory_update
 *      uses). No shipNode — updates the default node, matches Vladimir's
 *      manual "Out of Stock" in Seller Center.
 *   2. Insert one WalmartListingRetirement row (audit + rollback support).
 *
 * Per-SKU outcomes are independent: one failure doesn't block the rest.
 * Returns { results: Array<{sku, ok, error?, retirementId?, walmartResponse?}> }
 *
 * NOTE on "all warehouses": Walmart's PUT /v3/inventory without shipNode
 * targets the default fulfillment node — which is the only node Vladimir's
 * Seller-Fulfilled (S2H) account uses. If the account ever gets multiple
 * ship nodes (WFS, 3PL, multi-warehouse S2H), this endpoint would need to
 * loop GET /inventories first to find every node-level qty. For now —
 * single node is the truth.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";

const STORE_INDEX = 1;

interface PerSkuResult {
  sku: string;
  ok: boolean;
  retirementId?: string;
  error?: string;
  walmartStatus?: number;
  walmartCorrelationId?: string | null;
  walmartResponse?: unknown;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const b = body as {
    skus?: unknown;
    reason?: unknown;
    triggeredFrom?: unknown;
    searchQuery?: unknown;
  };

  if (!Array.isArray(b.skus) || b.skus.length === 0) {
    return NextResponse.json(
      { error: "skus must be a non-empty array of strings" },
      { status: 400 },
    );
  }
  const skus = (b.skus as unknown[])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  if (skus.length === 0) {
    return NextResponse.json(
      { error: "skus must contain at least one non-empty string" },
      { status: 400 },
    );
  }
  if (skus.length > 100) {
    return NextResponse.json(
      { error: "skus must contain at most 100 entries per call" },
      { status: 400 },
    );
  }

  const reason =
    typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : null;
  const triggeredFrom =
    typeof b.triggeredFrom === "string" && b.triggeredFrom.trim()
      ? b.triggeredFrom.trim()
      : null;
  const searchQuery =
    typeof b.searchQuery === "string" && b.searchQuery.trim()
      ? b.searchQuery.trim()
      : null;

  // Pull cached catalog rows so we can preserve title/itemId in the audit
  // log even if Walmart's response doesn't echo them. One query.
  const catalogRows = await prisma.walmartCatalogItem.findMany({
    where: { storeIndex: STORE_INDEX, sku: { in: skus } },
    select: { sku: true, title: true, itemId: true },
  });
  const catalogMap = new Map(
    catalogRows.map((r) => [r.sku, { title: r.title, itemId: r.itemId }]),
  );

  const client = getWalmartClient(STORE_INDEX);
  const results: PerSkuResult[] = [];

  for (const sku of skus) {
    const meta = catalogMap.get(sku);
    const params: Record<string, string> = { sku };
    const wireBody = { sku, quantity: { unit: "EACH", amount: 0 } };

    try {
      const walmartResponse = await client.request("PUT", "/inventory", {
        params,
        body: wireBody,
      });

      const retirement = await prisma.walmartListingRetirement.create({
        data: {
          sku,
          storeIndex: STORE_INDEX,
          itemId: meta?.itemId ?? null,
          productTitle: meta?.title ?? null,
          previousQty: null, // not fetched — too expensive per SKU; can backfill later
          reason,
          triggeredFrom,
          searchQuery,
        },
      });

      results.push({
        sku,
        ok: true,
        retirementId: retirement.id,
        walmartResponse,
      });
    } catch (err) {
      if (err instanceof WalmartApiError) {
        const userReason =
          err.status === 401 || err.status === 403
            ? "Walmart auth failed"
            : err.status === 404
              ? `SKU "${sku}" not found in this Walmart account`
              : `Walmart API ${err.status}`;
        results.push({
          sku,
          ok: false,
          error: userReason,
          walmartStatus: err.status,
          walmartCorrelationId: err.correlationId,
          walmartResponse: err.errorBody,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[retire-listing/execute] ${sku} failed:`, msg);
        results.push({ sku, ok: false, error: msg });
      }
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    requested: skus.length,
    succeeded: okCount,
    failed: skus.length - okCount,
    results,
  });
}
