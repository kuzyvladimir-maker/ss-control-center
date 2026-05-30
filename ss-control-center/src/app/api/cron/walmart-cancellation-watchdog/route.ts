/**
 * GET /api/cron/walmart-cancellation-watchdog
 *
 * Runs every 30 minutes. For every Acknowledged Walmart order where the
 * buyer has clicked "Request cancellation" (orderLineStatus.intentToCancel
 * === TRUE — the red exclamation in Seller Center):
 *
 *   * If the label is NOT yet on file (no orderLine trackingNumber AND no
 *     "Ship with Walmart" label purchased) → cancel the order immediately
 *     via cancelOrderLines with reason CUSTOMER_REQUESTED_SELLER_TO_CANCEL.
 *     This matches Vladimir's manual flow (Seller Center → Cancel →
 *     Customer Changed Mind → Apply).
 *
 *   * If a label IS on file → send a Telegram alert so Vladimir can
 *     decide (don't auto-cancel because the label cost is paid and the
 *     shipment may already be in transit).
 *
 * Dedup: WalmartCancellationRequest table — one row per PO, never
 * processed twice. Walmart's SLA is 48h before auto-cancel — at our
 * 30-min cadence we have ~96 chances to react, plenty of headroom.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { getWalmartClient } from "@/lib/walmart/client";
import { sendWalmartTelegram } from "@/lib/telegram";
import type { WalmartOrder, WalmartCancelLineInput } from "@/lib/walmart/types";

export const maxDuration = 300;

const STORE_INDEX = 1;
const CANCEL_REASON = "CUSTOMER_REQUESTED_SELLER_TO_CANCEL";

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function hasIntentToCancel(order: WalmartOrder): boolean {
  for (const line of order.orderLines) {
    for (const s of line.statuses) {
      if (s.intentToCancel) return true;
    }
  }
  return false;
}

/**
 * Best-effort detection: does this order have any label purchased?
 *   1. Any orderLine trackingNumber set (means ship-confirm done).
 *   2. Walmart Ship-with-Walmart label exists for this PO.
 * Returns true if either is true — be conservative, don't auto-cancel
 * a paid label.
 */
async function hasLabelOnFile(
  api: WalmartOrdersApi,
  order: WalmartOrder,
): Promise<boolean> {
  for (const line of order.orderLines) {
    for (const s of line.statuses) {
      if (s.trackingInfo?.trackingNumber) return true;
    }
  }
  try {
    const labels = await api.getLabelsByPurchaseOrder(order.purchaseOrderId);
    return labels.length > 0;
  } catch (err) {
    // If the labels endpoint fails (e.g. 404 = no labels), assume none.
    console.warn(
      `[watchdog] getLabelsByPurchaseOrder(${order.purchaseOrderId}) failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

function telegramSummary(
  order: WalmartOrder,
  outcome: "AUTO_CANCELLED" | "ALERTED_LABEL_BOUGHT",
): string {
  const product = order.orderLines[0]?.productName ?? "(unknown product)";
  const qty = order.orderLines.reduce((s, l) => s + l.orderedQty, 0);
  const total = `$${order.orderTotal.toFixed(2)}`;
  const shipBy = order.shippingInfo?.estimatedShipDate
    ? order.shippingInfo?.estimatedShipDate.toISOString().slice(0, 10)
    : "—";
  if (outcome === "AUTO_CANCELLED") {
    return [
      "✅ <b>Walmart auto-cancelled</b> (buyer-requested)",
      "",
      `PO# <code>${order.purchaseOrderId}</code>`,
      `Product: ${product}`,
      `Qty: ${qty} · Total: ${total}`,
      `Ship by: ${shipBy}`,
      "",
      "Label not on file — safe to cancel. Walmart will refund the buyer automatically.",
    ].join("\n");
  }
  return [
    "⚠️ <b>Buyer-requested cancellation — LABEL ALREADY ON FILE</b>",
    "",
    `PO# <code>${order.purchaseOrderId}</code>`,
    `Product: ${product}`,
    `Qty: ${qty} · Total: ${total}`,
    `Ship by: ${shipBy}`,
    "",
    "Cannot auto-cancel — label is paid and shipment may be in transit.",
    "Decide: cancel anyway (you eat the label cost) or ship anyway (request will auto-expire after 48h).",
  ].join("\n");
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const syncLog = await prisma.syncLog.create({
    data: {
      jobName: "walmart-cancellation-watchdog",
      storeIndex: STORE_INDEX,
      status: "running",
    },
  });

  const startedAt = Date.now();
  const result = {
    acknowledgedScanned: 0,
    intentDetected: 0,
    autoCancelled: 0,
    alerted: 0,
    skippedAlreadyActioned: 0,
    errors: 0,
  };

  try {
    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);

    // Walmart orders list — only need Acknowledged (others can't be cancelled).
    const page = await api.getAllOrders({
      status: "Acknowledged",
      limit: 200,
    });
    result.acknowledgedScanned = page.orders.length;

    const withIntent = page.orders.filter(hasIntentToCancel);
    result.intentDetected = withIntent.length;

    for (const order of withIntent) {
      const existing = await prisma.walmartCancellationRequest.findUnique({
        where: { purchaseOrderId: order.purchaseOrderId },
      });
      if (existing && existing.action !== "PENDING") {
        result.skippedAlreadyActioned++;
        continue;
      }

      const product = order.orderLines[0]?.productName ?? null;
      const shipBy = order.shippingInfo?.estimatedShipDate ?? null;

      // Upsert as PENDING first — protects against double-processing if the
      // cron runs twice concurrently.
      await prisma.walmartCancellationRequest.upsert({
        where: { purchaseOrderId: order.purchaseOrderId },
        create: {
          purchaseOrderId: order.purchaseOrderId,
          storeIndex: STORE_INDEX,
          customerOrderId: order.customerOrderId,
          productName: product,
          orderTotal: order.orderTotal,
          shipBy,
          action: "PENDING",
        },
        update: {
          productName: product ?? undefined,
          orderTotal: order.orderTotal,
          shipBy: shipBy ?? undefined,
        },
      });

      const labelOnFile = await hasLabelOnFile(api, order);

      if (!labelOnFile) {
        // Auto-cancel: build per-line input mirroring "cancel all" semantics.
        const cancelLines: WalmartCancelLineInput[] = order.orderLines.map(
          (l) => ({
            lineNumber: l.lineNumber,
            quantity: l.orderedQty,
            reason: CANCEL_REASON,
          }),
        );
        try {
          await api.cancelOrderLines(order.purchaseOrderId, cancelLines);
          const text = telegramSummary(order, "AUTO_CANCELLED");
          const tg = await sendWalmartTelegram(text);
          await prisma.walmartCancellationRequest.update({
            where: { purchaseOrderId: order.purchaseOrderId },
            data: {
              action: "AUTO_CANCELLED",
              actionedAt: new Date(),
              telegramSent: !!tg && tg.sent !== false,
              notes: `Cancelled ${cancelLines.length} line(s) at ${new Date().toISOString()}`,
            },
          });
          result.autoCancelled++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[watchdog] cancel failed for ${order.purchaseOrderId}:`,
            msg,
          );
          await prisma.walmartCancellationRequest.update({
            where: { purchaseOrderId: order.purchaseOrderId },
            data: {
              action: "FAILED",
              actionedAt: new Date(),
              notes: msg.slice(0, 500),
            },
          });
          result.errors++;
        }
      } else {
        // Label bought — alert, don't auto-cancel.
        const text = telegramSummary(order, "ALERTED_LABEL_BOUGHT");
        const tg = await sendWalmartTelegram(text);
        await prisma.walmartCancellationRequest.update({
          where: { purchaseOrderId: order.purchaseOrderId },
          data: {
            action: "ALERTED_LABEL_BOUGHT",
            actionedAt: new Date(),
            telegramSent: !!tg && tg.sent !== false,
            notes: "Label on file; manual decision needed.",
          },
        });
        result.alerted++;
      }
    }

    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: result.errors > 0 ? "error" : "done",
        completedAt: new Date(),
        itemsSynced: result.autoCancelled + result.alerted,
        error:
          result.errors > 0
            ? `${result.errors} cancellation(s) failed; see notes on WalmartCancellationRequest rows`
            : null,
      },
    });

    return NextResponse.json({
      ok: result.errors === 0,
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[watchdog] fatal:", msg);
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: { status: "error", completedAt: new Date(), error: msg },
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
