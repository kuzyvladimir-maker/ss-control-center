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
 * listing — only zero inventory across EVERY ship node):
 *
 *   1. readInventoryAcrossNodes — GET inventory for every known ship
 *      node, sum to previousQty for the audit row.
 *   2. setInventoryAllNodes — PUT amount=0 once per discovered ship
 *      node (default-node-only PUT is the historical bug; with two+
 *      warehouses the listing kept selling from the warehouse our
 *      call never touched).
 *   3. readInventoryAcrossNodes AGAIN — verify the sum landed at 0.
 *      A residual amount > 0 surfaces as a hard error with the
 *      per-node breakdown so the operator can see which warehouse
 *      didn't accept the zero.
 *
 * Per-SKU outcomes are independent: one failure doesn't block the rest.
 * Returns { results: Array<PerSkuResult> }
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient } from "@/lib/walmart/client";
import {
  readInventoryAcrossNodes,
  setInventoryAllNodes,
  verifyInventoryAllNodes,
  type PerNodeQty,
  type PerNodeWriteResult,
} from "@/lib/walmart/inventory";

// Multi-SKU retire with up-to-17s verification per SKU could blow
// Vercel's default 10s/60s window. Most SKUs settle on attempt 2-3
// (≈4-9s), but bound the worst case explicitly so the operator gets a
// response instead of a generic timeout.
export const maxDuration = 300;

const STORE_INDEX = 1;

interface PerSkuResult {
  sku: string;
  ok: boolean;
  retirementId?: string;
  /** Total stock across ALL ship nodes just before we zeroed it. */
  previousQty?: number | null;
  /** Total stock across ALL ship nodes AFTER our PUT. */
  verifiedQty?: number | null;
  /** Per-ship-node breakdown of the verified read so the operator can
   *  see which warehouse(s) still have stock if anything went wrong. */
  perNode?: PerNodeQty[];
  /** Per-ship-node write outcomes (which PUTs succeeded). */
  writes?: PerNodeWriteResult[];
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

    // Step 1 — read previous qty across every known ship node for the
    // audit row. Sum gives the total inventory we're about to remove
    // so rollback knows what to restore.
    const before = await readInventoryAcrossNodes(client, STORE_INDEX, sku);
    const previousQty = before.totalQty;

    // Step 2 — fan-out PUT amount=0 to every known ship node. The old
    // default-only PUT was the bug that let warehouses keep selling
    // after a "retire" click.
    const writes = await setInventoryAllNodes(client, STORE_INDEX, sku, 0);
    const allWritesOk = writes.length > 0 && writes.every((w) => w.ok);

    if (!allWritesOk) {
      const failedNodes = writes
        .filter((w) => !w.ok)
        .map((w) => `${w.shipNode}: ${w.error ?? "unknown"}`)
        .join("; ");
      const msg = `Walmart rejected PUT on ${writes.filter((w) => !w.ok).length}/${writes.length} ship node(s): ${failedNodes}`;
      console.error(`[retire-listing/execute] ${sku} multi-node PUT failed:`, msg);
      // Still log a retirement row so we can audit the attempt.
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
      results.push({
        sku,
        ok: false,
        previousQty,
        retirementId: retirement.id,
        writes,
        error: msg,
      });
      continue;
    }

    // Step 3 — read-back verification. Walmart processes inventory
    // PUTs asynchronously ("Updates may take up to 1 hour" per their
    // own UI), so a single-shot read ~500ms after the PUT almost
    // always returns the stale pre-PUT value and falsely trips the
    // silent-fail path. Live probe 2026-06-07: FaisalX-5409..5411 read
    // 50 immediately after PUT, then read 0 across all nodes ~2min
    // later. We retry with exponential backoff up to ~17s; the common
    // path settles on attempt 2-3 (≈4-9s).
    const after = await verifyInventoryAllNodes(client, STORE_INDEX, sku, 0);
    const verifiedQty = after.totalQty;

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

    if (verifiedQty > 0) {
      const stillStocked = after.nodes
        .filter((n) => (n.qty ?? 0) > 0)
        .map((n) => `${n.shipNode}: ${n.qty}`)
        .join("; ");
      console.warn(
        `[retire-listing/execute] ${sku} silent-fail across ${after.nodes.length} node(s); residual qty=${verifiedQty} in ${stillStocked}`,
      );
      results.push({
        sku,
        ok: false,
        previousQty,
        verifiedQty,
        perNode: after.nodes,
        writes,
        retirementId: retirement.id,
        error: `Walmart accepted PUT amount=0 on ${writes.length} ship node(s) but stock is still ${verifiedQty} (${stillStocked}). Возможно SKU управляется отдельным feed-ом — обнули вручную в Seller Center.`,
      });
      continue;
    }

    results.push({
      sku,
      ok: true,
      previousQty,
      verifiedQty,
      perNode: after.nodes,
      writes,
      retirementId: retirement.id,
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
