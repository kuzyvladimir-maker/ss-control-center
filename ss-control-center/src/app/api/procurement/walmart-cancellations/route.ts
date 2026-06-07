/**
 * POST /api/procurement/walmart-cancellations
 *
 * Body:  { orderNumbers: string[] }   // Veeqo order numbers
 *                                    // (== Walmart customerOrderId for
 *                                    //  Walmart-channel orders)
 *
 * Returns:
 *   { results: { [orderNumber]: WalmartCancellationFlag } }
 *
 * Each flag tells the procurement card whether the buyer requested
 * cancellation (intentToCancel = the red exclamation in Seller Center)
 * or whether the order is already Cancelled. The /procurement page
 * calls this in parallel with /api/procurement/items so the card list
 * paints immediately and the cancellation badges fade in moments later.
 *
 * Resolution order — critical for freshness:
 *
 *   1. ALWAYS scan Walmart's live Acknowledged + Created queues and
 *      index by customerOrderId. This is the source of truth for
 *      intentToCancel — that field is stripped from our nightly cache.
 *      We do NOT gate on a DB cache lookup here because fresh orders
 *      arrive into Veeqo before our orders-walmart-light cron has had
 *      a chance to sync them (cron runs every 2h; Veeqo pulls Walmart
 *      orders within seconds). Gating the live API call behind a cache
 *      lookup means we silently miss intent-to-cancel on any order
 *      received in the last 2h — exactly the orders Vladimir is most
 *      likely to be processing on /procurement right now. (This was
 *      the bug surfaced 2026-06-07 — order 200014779658109 had the
 *      red exclamation in Seller Center but no banner appeared on
 *      /procurement because it hadn't synced to cache yet.)
 *
 *   2. For any orderNumber NOT found in the live scan, check the DB
 *      cache for an already-Cancelled status. (Cancelled orders drop
 *      out of Acknowledged/Created so won't appear in step 1.)
 *
 *   3. Anything that misses both — return no flag (the card simply
 *      doesn't render a banner). Could be: not a Walmart order at all,
 *      Walmart order in Shipped state (procurement page wouldn't show
 *      it normally), or Walmart API hiccup.
 *
 * Walmart-API cost: 2 paginated /v3/orders scans (Acknowledged +
 * Created), typically one HTTP call each for our volume.
 *
 * Companion endpoint: POST /api/procurement/walmart-cancel-order
 *   — actions the cancellation with reason CUSTOMER_CHANGED_MIND.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type {
  WalmartOrder,
  WalmartOrderStatus,
} from "@/lib/walmart/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STORE_INDEX = 1;
// Hard cap on pagination loops as a safety belt — Walmart's
// Acknowledged + Created queues would have to balloon past 2 000 orders
// for us to hit this, which never happens in practice for our volume.
const MAX_PAGES = 10;

export interface WalmartCancellationFlag {
  /** Buyer clicked "Request cancellation" — the red exclamation in
   *  Seller Center. Highest-priority signal: we have ~48h to honour it
   *  before Walmart auto-cancels and dings our seller metrics. */
  intentToCancel: boolean;
  /** Order is already in Cancelled state on Walmart's side. */
  isCancelled: boolean;
  /** Reason string Walmart returned for the line that's cancelled (or
   *  the request, if intentToCancel is set). Surfaced verbatim on the
   *  card for context. */
  cancellationReason: string | null;
  /** Walmart purchaseOrderId — needed by the cancel-order endpoint. */
  purchaseOrderId: string;
  /** Top-level order status as Walmart sees it right now. */
  status: string;
}

function extractFlag(order: WalmartOrder): {
  intentToCancel: boolean;
  cancellationReason: string | null;
} {
  let intent = false;
  let reason: string | null = null;
  for (const line of order.orderLines) {
    for (const s of line.statuses) {
      if (s.intentToCancel) intent = true;
      if (s.cancellationReason && !reason) reason = s.cancellationReason;
    }
  }
  return { intentToCancel: intent, cancellationReason: reason };
}

/** Paginate one Walmart status into a Map keyed by customerOrderId. */
async function scanStatus(
  api: WalmartOrdersApi,
  status: WalmartOrderStatus,
  sink: Map<string, WalmartOrder>,
): Promise<{ status: WalmartOrderStatus; count: number; pages: number }> {
  let cursor: string | undefined;
  let pages = 0;
  let count = 0;
  do {
    const page = await api.getAllOrders(
      cursor ? { nextCursor: cursor } : { status, limit: 200 },
    );
    for (const o of page.orders) {
      sink.set(o.customerOrderId, o);
      count++;
    }
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  return { status, count, pages };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const raw = Array.isArray(body?.orderNumbers) ? body.orderNumbers : [];
    const orderNumbers: string[] = raw
      .map((v: unknown) => String(v ?? "").trim())
      .filter(Boolean);

    if (orderNumbers.length === 0) {
      return NextResponse.json({ results: {} });
    }

    // Step 1 — live scan of Walmart's open queues (no cache gating).
    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);
    const liveByCustomerId = new Map<string, WalmartOrder>();

    const scanStats: Array<{ status: string; count: number; pages: number }> =
      [];
    try {
      scanStats.push(
        await scanStatus(api, "Acknowledged", liveByCustomerId),
      );
      scanStats.push(await scanStatus(api, "Created", liveByCustomerId));
    } catch (e) {
      console.error(
        "[procurement/walmart-cancellations] live scan failed",
        e instanceof Error ? e.message : e,
      );
      // Fall through with empty live map — we still want to surface
      // already-Cancelled flags from the DB cache below.
    }

    // Step 2 — DB cache fallback for already-Cancelled status. Cancelled
    // orders drop out of the Acknowledged/Created queues so won't be
    // in liveByCustomerId. We don't need any field other than status
    // + purchaseOrderId from the cache.
    const cached = await prisma.walmartOrder.findMany({
      where: { customerOrderId: { in: orderNumbers } },
      select: {
        customerOrderId: true,
        purchaseOrderId: true,
        status: true,
      },
    });
    const cachedMap = new Map<
      string,
      { purchaseOrderId: string; status: string }
    >();
    for (const r of cached) {
      cachedMap.set(r.customerOrderId, {
        purchaseOrderId: r.purchaseOrderId,
        status: r.status,
      });
    }

    // Step 3 — build the per-orderNumber flag.
    const results: Record<string, WalmartCancellationFlag> = {};
    let intentCount = 0;
    let cancelledCount = 0;
    for (const num of orderNumbers) {
      const live = liveByCustomerId.get(num);
      if (live) {
        const { intentToCancel, cancellationReason } = extractFlag(live);
        if (intentToCancel) intentCount++;
        if (live.status === "Cancelled") cancelledCount++;
        results[num] = {
          intentToCancel,
          isCancelled: live.status === "Cancelled",
          cancellationReason,
          purchaseOrderId: live.purchaseOrderId,
          status: live.status,
        };
        continue;
      }
      const cachedRow = cachedMap.get(num);
      if (cachedRow && cachedRow.status === "Cancelled") {
        cancelledCount++;
        results[num] = {
          intentToCancel: false,
          isCancelled: true,
          cancellationReason: null,
          purchaseOrderId: cachedRow.purchaseOrderId,
          status: "Cancelled",
        };
        continue;
      }
      // Not seen anywhere — nothing to surface for this order.
    }

    console.log(
      `[procurement/walmart-cancellations] checked ${orderNumbers.length} ` +
        `orderNumbers, scans=${JSON.stringify(scanStats)}, ` +
        `intentToCancel=${intentCount}, cancelled=${cancelledCount}`,
    );

    return NextResponse.json({ results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/walmart-cancellations] error", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
