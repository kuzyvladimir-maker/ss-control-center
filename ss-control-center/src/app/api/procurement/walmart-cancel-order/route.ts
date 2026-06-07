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
 * CUSTOMER_CHANGED_MIND — Vladimir's chosen reason for procurement-time
 * cancellations (he made the call: if we haven't bought the inventory
 * yet, treat the cancellation as a buyer-side change of heart rather
 * than a seller fault). Walmart accepts CUSTOMER_CHANGED_MIND as a
 * valid orderLineStatus.cancellationReason.
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
 *   502 if Walmart cancelOrderLines fails — message bubbled up so the
 *       UI can surface "Walmart rejected: ..." inline on the card.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type { WalmartCancelLineInput } from "@/lib/walmart/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CANCEL_REASON = "CUSTOMER_CHANGED_MIND";

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
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[procurement/walmart-cancel-order] cancel failed PO ${row.purchaseOrderId}:`,
        msg,
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
          notes: `Manual cancel from /procurement failed: ${msg.slice(0, 400)}`,
        },
        update: {
          action: "FAILED",
          actionedAt: new Date(),
          notes: `Manual cancel from /procurement failed: ${msg.slice(0, 400)}`,
        },
      });
      return NextResponse.json(
        {
          ok: false,
          error: msg,
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
