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
 * cancellation (intentToCancel = the red exclamation in Seller Center) or
 * whether the order is already Cancelled. The /procurement page calls
 * this in parallel with /api/procurement/items so the card list paints
 * immediately and the cancellation badges fade in moments later.
 *
 * Walmart-API cost: one paginated /v3/orders?status=Acknowledged scan
 * (Walmart's typical Acknowledged queue is well under a page, so this is
 * almost always one HTTP call). DB cache backstops anything already
 * Cancelled so we don't burn a second scan.
 *
 * Companion endpoint: POST /api/procurement/walmart-cancel-order
 *   — actions the cancellation with reason CUSTOMER_CHANGED_MIND.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type { WalmartOrder } from "@/lib/walmart/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STORE_INDEX = 1;
// Hard cap on pagination loops as a safety belt — Walmart's
// Acknowledged queue would have to balloon past 2 000 orders for us to
// hit this, which never happens in practice for our volume.
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

    // DB cache: map customerOrderId → purchaseOrderId + status. We
    // intersect with the requested orderNumbers — anything not in the
    // cache is silently dropped (not a Walmart order, or not yet
    // ingested by the orders-walmart-light cron).
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

    const results: Record<string, WalmartCancellationFlag> = {};
    const liveCheck: string[] = [];

    for (const num of orderNumbers) {
      const row = cachedMap.get(num);
      if (!row) continue;
      if (row.status === "Cancelled") {
        results[num] = {
          intentToCancel: false,
          isCancelled: true,
          cancellationReason: null,
          purchaseOrderId: row.purchaseOrderId,
          status: "Cancelled",
        };
        continue;
      }
      // Acknowledged / Created → need live intentToCancel from Walmart.
      liveCheck.push(num);
    }

    if (liveCheck.length === 0) {
      return NextResponse.json({ results });
    }

    // Pull the live Acknowledged queue once and index by customerOrderId.
    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);
    const liveByCustomerId = new Map<string, WalmartOrder>();

    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await api.getAllOrders(
        cursor ? { nextCursor: cursor } : { status: "Acknowledged", limit: 200 },
      );
      for (const o of page.orders) {
        liveByCustomerId.set(o.customerOrderId, o);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < MAX_PAGES);

    for (const num of liveCheck) {
      const row = cachedMap.get(num)!;
      const live = liveByCustomerId.get(num);
      if (!live) {
        // Not in the Acknowledged queue right now — could be Created
        // (rare; the acknowledge cron fires within minutes) or already
        // Shipped (procurement page won't show it anyway). Either way,
        // no intentToCancel signal to report.
        results[num] = {
          intentToCancel: false,
          isCancelled: false,
          cancellationReason: null,
          purchaseOrderId: row.purchaseOrderId,
          status: row.status,
        };
        continue;
      }
      const { intentToCancel, cancellationReason } = extractFlag(live);
      results[num] = {
        intentToCancel,
        isCancelled: live.status === "Cancelled",
        cancellationReason,
        purchaseOrderId: live.purchaseOrderId,
        status: live.status,
      };
    }

    return NextResponse.json({ results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/walmart-cancellations] error", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
