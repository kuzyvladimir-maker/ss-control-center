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
 * Per-SKU pipeline (reversible — Vladimir wants to be able to put stock
 * back if the supplier returns, so we DO NOT permanently retire the
 * listing — only zero inventory):
 *
 *   1. GET  /v3/inventory?sku=  — capture `previousQty` for the audit row.
 *   2. PUT  /v3/inventory?sku=  amount=0 — the actual "stop selling".
 *   3. GET  /v3/inventory?sku=  AGAIN, read-back — verify Walmart actually
 *      accepted the 0 (HTTP 200 is not enough; the older code reported
 *      "Снят" any time Walmart returned 200, but Vladimir saw stock stay
 *      positive in Seller Center afterwards, meaning Walmart accepted the
 *      call without applying it — most likely for items where inventory
 *      is feed-managed, or for SKUs whose default ship-node differs).
 *      If the read-back says amount > 0, we surface a hard error instead
 *      of falsely claiming success.
 *
 * Per-SKU outcomes are independent: one failure doesn't block the rest.
 * Returns { results: Array<PerSkuResult> }
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";

const STORE_INDEX = 1;

interface PerSkuResult {
  sku: string;
  ok: boolean;
  retirementId?: string;
  /** Stock just before we zeroed it — null if the read failed. */
  previousQty?: number | null;
  /** Stock Walmart reports AFTER our PUT — proves whether 0 actually landed. */
  verifiedQty?: number | null;
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

  // Tiny helper — Walmart's GET /v3/inventory shape, defensive against
  // missing fields. Returns null on any 4xx so the caller can treat
  // "no inventory configured" the same as "couldn't read".
  async function readQty(sku: string): Promise<number | null> {
    try {
      const r = (await client.request<{
        quantity?: { amount?: number };
      }>("GET", "/inventory", { params: { sku } })) as {
        quantity?: { amount?: number };
      };
      const amt = r?.quantity?.amount;
      return typeof amt === "number" ? amt : null;
    } catch {
      return null;
    }
  }

  for (const sku of skus) {
    const meta = catalogMap.get(sku);
    const params: Record<string, string> = { sku };
    const wireBody = { sku, quantity: { unit: "EACH", amount: 0 } };

    // Step 1 — read previous qty for the audit row (rollback needs it).
    const previousQty = await readQty(sku);

    // Step 2 — the actual zero-out.
    let walmartResponse: unknown = null;
    try {
      walmartResponse = await client.request("PUT", "/inventory", {
        params,
        body: wireBody,
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
          previousQty,
          error: userReason,
          walmartStatus: err.status,
          walmartCorrelationId: err.correlationId,
          walmartResponse: err.errorBody,
        });
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[retire-listing/execute] ${sku} PUT /inventory failed:`, msg);
      results.push({ sku, ok: false, previousQty, error: msg });
      continue;
    }

    // Step 3 — read-back verification. This catches the failure mode
    // where Walmart returns 200 OK to our PUT but doesn't actually apply
    // the 0 (silent no-op). Without this step the UI would falsely
    // report "Снят" and the operator would see sales keep coming.
    const verifiedQty = await readQty(sku);

    // Audit row goes in regardless of verification outcome — we want a
    // record of every attempt, including the silent-fail ones.
    const retirement = await prisma.walmartListingRetirement.create({
      data: {
        sku,
        storeIndex: STORE_INDEX,
        itemId: meta?.itemId ?? null,
        productTitle: meta?.title ?? null,
        previousQty,
        reason,
        triggeredFrom,
        searchQuery,
      },
    });

    if (verifiedQty !== null && verifiedQty > 0) {
      // Walmart accepted our PUT but didn't apply it — surface as a hard
      // failure so the operator knows the listing is still live.
      console.warn(
        `[retire-listing/execute] ${sku} silent-fail: PUT returned 200 but GET still shows qty=${verifiedQty}`,
      );
      results.push({
        sku,
        ok: false,
        previousQty,
        verifiedQty,
        retirementId: retirement.id,
        error: `Walmart accepted PUT amount=0 but stock is still ${verifiedQty}. Возможно SKU управляется отдельным feed-ом или другим ship-node — поставь 0 вручную в Seller Center.`,
        walmartResponse,
      });
      continue;
    }

    results.push({
      sku,
      ok: true,
      previousQty,
      verifiedQty,
      retirementId: retirement.id,
      walmartResponse,
    });
  }

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    requested: skus.length,
    succeeded: okCount,
    failed: skus.length - okCount,
    results,
  });
}
