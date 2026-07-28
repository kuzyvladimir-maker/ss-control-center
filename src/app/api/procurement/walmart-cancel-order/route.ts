/**
 * POST /api/procurement/walmart-cancel-order
 *
 * Body:  { orderNumber: string }
 *
 *   orderNumber accepts either the Veeqo order number (== Walmart
 *   customerOrderId) or the Walmart purchaseOrderId directly — the
 *   handler resolves both via the WalmartOrder cache.
 *
 * Cancels every open line on the Walmart order with reason
 * CUSTOMER_REQUESTED_SELLER_TO_CANCEL. Walmart's Seller Center
 * exposes a friendlier UI label ("Cancel - Customer changed mind")
 * for the same enum — we tried sending CUSTOMER_CHANGED_MIND verbatim
 * and Walmart 400'd with INVALID_REQUEST_CONTENT.GMP_ORDER_API on the
 * cancellationReason field (live probe 2026-06-07,
 * cid=e780f3d1-a86c-473c-b016-eecb9b36e23a). CUSTOMER_REQUESTED_SELLER_TO_CANCEL
 * is the documented API code for the buyer-initiated cancel flow —
 * same code the walmart-cancellation-watchdog cron uses for the
 * automated no-label-bought path, so manual + automatic cancels now
 * share one reason and one audit trail.
 *
 * Side effects:
 *   1. Walmart cancelOrderLines call (live API).
 *   2. WalmartOrder.status flipped to "Cancelled" in cache so the
 *      procurement list drops the row on next refresh.
 *   3. WalmartCancellationRequest row upserted to AUTO_CANCELLED so
 *      the watchdog cron skips this PO next time it scans.
 *
 * Errors:
 *   400 if orderNumber missing.
 *   404 if no matching Walmart order in cache.
 *   502 if Walmart cancelOrderLines fails. The Walmart-returned error
 *       body (errors.error[].description) is bubbled up in `error` so
 *       the UI banner shows what Walmart actually complained about
 *       rather than the bare "HTTP 502".
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type { WalmartCancelLineInput } from "@/lib/walmart/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CANCEL_REASON = "CUSTOMER_REQUESTED_SELLER_TO_CANCEL";

/** Pull a human-friendly description out of a WalmartApiError. The
 *  /v3/orders error envelope is `{ errors: { error: [{description, ...}] } }`,
 *  but the wrapper sometimes returns it unwrapped depending on the
 *  endpoint — handle both shapes defensively. */
function extractWalmartErrorMessage(err: WalmartApiError): string {
  const body = err.errorBody as
    | {
        errors?: { error?: Array<{ description?: string; code?: string }> };
        error?: Array<{ description?: string; code?: string }>;
      }
    | null
    | undefined;
  const list =
    body?.errors?.error ?? body?.error ?? [];
  if (Array.isArray(list) && list.length > 0) {
    const first = list[0];
    if (first?.description) {
      return first.code
        ? `${first.code}: ${first.description}`
        : first.description;
    }
  }
  return err.message;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const orderNumber = String(body?.orderNumber ?? "").trim();
    if (!orderNumber) {
      return NextResponse.json(
        { error: "orderNumber required" },
        { status: 400 },
      );
    }

    // Resolve to a WalmartOrder cache row. The Veeqo procurement card
    // passes the Veeqo `number` field (== customerOrderId for Walmart),
    // but accept purchaseOrderId too for direct cancel flows.
    const row = await prisma.walmartOrder.findFirst({
      where: {
        OR: [
          { customerOrderId: orderNumber },
          { purchaseOrderId: orderNumber },
        ],
      },
      select: {
        purchaseOrderId: true,
        customerOrderId: true,
        storeIndex: true,
        status: true,
      },
    });
    if (!row) {
      return NextResponse.json(
        { error: `Walmart order ${orderNumber} not in cache` },
        { status: 404 },
      );
    }

    if (row.status === "Cancelled") {
      // Idempotent: already cancelled is success, not error.
      return NextResponse.json({
        ok: true,
        purchaseOrderId: row.purchaseOrderId,
        alreadyCancelled: true,
      });
    }

    const client = getWalmartClient(row.storeIndex);
    const api = new WalmartOrdersApi(client);

    // Live read first — we need fresh line numbers + per-line qty. The
    // cache stores only header status, not lines.
    const order = await api.getOrderById(row.purchaseOrderId);
    const openLines: WalmartCancelLineInput[] = [];
    for (const line of order.orderLines) {
      // Skip lines already cancelled/shipped — Walmart rejects the
      // whole call if any line in the body is in a terminal state.
      const isOpen = line.statuses.some(
        (s) => s.status === "Created" || s.status === "Acknowledged",
      );
      if (!isOpen) continue;
      openLines.push({
        lineNumber: line.lineNumber,
        quantity: line.orderedQty,
        reason: CANCEL_REASON,
      });
    }

    if (openLines.length === 0) {
      // Nothing left to cancel (everything already shipped or cancelled).
      // Reflect that in the cache and return idempotent success.
      await prisma.walmartOrder.update({
        where: { purchaseOrderId: row.purchaseOrderId },
        data: { status: order.status },
      });
      return NextResponse.json({
        ok: true,
        purchaseOrderId: row.purchaseOrderId,
        noOpenLines: true,
      });
    }

    try {
      await api.cancelOrderLines(row.purchaseOrderId, openLines);
    } catch (e) {
      // For Walmart-API errors, dig out the human description from
      // errors.error[].description so the banner shows the real
      // complaint instead of "Walmart API 400 on /v3/...".
      const friendly =
        e instanceof WalmartApiError
          ? extractWalmartErrorMessage(e)
          : e instanceof Error
            ? e.message
            : String(e);
      const fullForLog =
        e instanceof WalmartApiError
          ? `${e.message} | body=${JSON.stringify(e.errorBody)}`
          : friendly;
      console.error(
        `[procurement/walmart-cancel-order] cancel failed PO ${row.purchaseOrderId}:`,
        fullForLog,
      );
      await prisma.walmartCancellationRequest.upsert({
        where: { purchaseOrderId: row.purchaseOrderId },
        create: {
          purchaseOrderId: row.purchaseOrderId,
          storeIndex: row.storeIndex,
          customerOrderId: row.customerOrderId,
          productName: order.orderLines[0]?.productName ?? null,
          orderTotal: order.orderTotal,
          shipBy: order.shippingInfo?.estimatedShipDate ?? null,
          action: "FAILED",
          actionedAt: new Date(),
          notes: `Manual cancel from /procurement failed: ${fullForLog.slice(0, 500)}`,
        },
        update: {
          action: "FAILED",
          actionedAt: new Date(),
          notes: `Manual cancel from /procurement failed: ${fullForLog.slice(0, 500)}`,
        },
      });
      return NextResponse.json(
        {
          ok: false,
          error: friendly,
          purchaseOrderId: row.purchaseOrderId,
        },
        { status: 502 },
      );
    }

    // Success path — log, flip cache, return.
    const now = new Date();
    await prisma.walmartCancellationRequest.upsert({
      where: { purchaseOrderId: row.purchaseOrderId },
      create: {
        purchaseOrderId: row.purchaseOrderId,
        storeIndex: row.storeIndex,
        customerOrderId: row.customerOrderId,
        productName: order.orderLines[0]?.productName ?? null,
        orderTotal: order.orderTotal,
        shipBy: order.shippingInfo?.estimatedShipDate ?? null,
        action: "AUTO_CANCELLED",
        actionedAt: now,
        notes: `Cancelled from /procurement with reason ${CANCEL_REASON}`,
      },
      update: {
        action: "AUTO_CANCELLED",
        actionedAt: now,
        notes: `Cancelled from /procurement with reason ${CANCEL_REASON}`,
      },
    });
    await prisma.walmartOrder.update({
      where: { purchaseOrderId: row.purchaseOrderId },
      data: { status: "Cancelled" },
    });

    return NextResponse.json({
      ok: true,
      purchaseOrderId: row.purchaseOrderId,
      linesCancelled: openLines.length,
      reason: CANCEL_REASON,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/walmart-cancel-order] fatal", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
