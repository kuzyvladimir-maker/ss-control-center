/**
 * GET /api/shipping-labels/walmart/verify/{purchaseOrderId}
 *
 * Pre-flight check before buying a shipping label for a Walmart order.
 * Walmart orders can flip to Cancelled (or have specific lines cancelled)
 * between the time Veeqo synced the order and the time we click "Buy".
 * Buying a label for a cancelled order wastes money and triggers a
 * shipping adjustment claim downstream.
 *
 * Response shape:
 *   {
 *     orderId: "PO123",
 *     status: "Acknowledged" | "Cancelled" | ...,
 *     isSafeToShip: true | false,
 *     reason?: "...",
 *     cancelledLines?: ["1", "2"]
 *   }
 */

import { NextResponse } from "next/server";
import { WalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await ctx.params;
  if (!orderId) {
    return NextResponse.json({ error: "orderId required" }, { status: 400 });
  }

  let client: WalmartClient;
  try {
    client = new WalmartClient(1);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }

  const api = new WalmartOrdersApi(client);

  try {
    const order = await api.getOrderById(orderId);

    // Collect any line-level cancellations
    const cancelledLines: string[] = [];
    let hasShippableQuantity = false;
    for (const line of order.orderLines) {
      const lineStatuses = line.statuses;
      const lineCancelled = lineStatuses.some((s) => s.status === "Cancelled");
      const lineShippable = lineStatuses.some(
        (s) => s.status === "Created" || s.status === "Acknowledged"
      );
      if (lineCancelled) cancelledLines.push(line.lineNumber);
      if (lineShippable) hasShippableQuantity = true;
    }

    let isSafeToShip = true;
    let reason: string | undefined;

    if (order.status === "Cancelled") {
      isSafeToShip = false;
      reason = "Order was cancelled";
    } else if (order.status === "Shipped" || order.status === "Delivered") {
      isSafeToShip = false;
      reason = `Order already ${order.status.toLowerCase()}`;
    } else if (!hasShippableQuantity) {
      isSafeToShip = false;
      reason = "No remaining shippable line items";
    } else if (cancelledLines.length > 0) {
      // Some lines cancelled but others still shippable — still safe overall,
      // surface the warning so the operator knows to ship only the active SKUs.
      reason = `Line(s) ${cancelledLines.join(", ")} cancelled — ship remaining lines only`;
    }

    return NextResponse.json({
      orderId: order.purchaseOrderId,
      customerOrderId: order.customerOrderId,
      status: order.status,
      isSafeToShip,
      reason,
      cancelledLines: cancelledLines.length ? cancelledLines : undefined,
      orderTotal: order.orderTotal,
    });
  } catch (err) {
    if (err instanceof WalmartApiError) {
      // Surface 404 vs other errors clearly
      return NextResponse.json(
        {
          error: err.message,
          status: err.status,
          isSafeToShip: false,
          reason:
            err.status === 404
              ? "Order not found in Walmart"
              : "Walmart API error",
        },
        { status: err.status === 404 ? 404 : 500 }
      );
    }
    return NextResponse.json(
      { error: (err as Error).message, isSafeToShip: false },
      { status: 500 }
    );
  }
}
