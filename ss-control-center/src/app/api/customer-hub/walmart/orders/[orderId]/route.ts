/**
 * GET   /api/customer-hub/walmart/orders/{orderId}              — order detail
 * PATCH /api/customer-hub/walmart/orders/{orderId}
 *   body: { action: "acknowledge" }
 *       | { action: "cancel",  lines: [{ lineNumber, quantity, reason? }] }
 *       | { action: "refund",  lines: [{ lineNumber, reason, amount, currency?, tax? }] }
 *
 * Decision Engine actions for Walmart orders. The handler dispatches into
 * the right WalmartOrdersApi method, then upserts the (now-changed) order
 * back into the WalmartOrder table so the UI sees the new status without
 * a separate refresh.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type {
  WalmartCancelLineInput,
  WalmartOrder,
  WalmartRefundLineInput,
} from "@/lib/walmart/types";

interface CancelBody {
  action: "cancel";
  lines: WalmartCancelLineInput[];
}
interface RefundBody {
  action: "refund";
  lines: WalmartRefundLineInput[];
}
interface AckBody {
  action: "acknowledge";
}
type ActionBody = CancelBody | RefundBody | AckBody;

async function persistAfterMutation(order: WalmartOrder, storeIndex: number) {
  const ship = order.shippingInfo?.postalAddress;
  await prisma.walmartOrder.upsert({
    where: { purchaseOrderId: order.purchaseOrderId },
    create: {
      purchaseOrderId: order.purchaseOrderId,
      customerOrderId: order.customerOrderId,
      customerEmailId: order.customerEmailId,
      storeIndex,
      status: order.status,
      shipNodeType: order.shipNodeType,
      orderType: order.orderType,
      orderDate: order.orderDate,
      estimatedShipDate: order.shippingInfo?.estimatedShipDate,
      estimatedDeliveryDate: order.shippingInfo?.estimatedDeliveryDate,
      orderTotal: order.orderTotal,
      currency: order.currency || "USD",
      shipCity: ship?.city,
      shipState: ship?.state,
      shipZip: ship?.postalCode,
      shipCountry: ship?.country,
      numberOfItems: order.orderLines.reduce(
        (s, l) => s + (l.orderedQty || 0),
        0
      ),
      rawData: JSON.stringify(order.raw),
    },
    update: {
      status: order.status,
      orderTotal: order.orderTotal,
      rawData: JSON.stringify(order.raw),
    },
  });
}

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await ctx.params;
  let client: WalmartClient;
  try {
    client = new WalmartClient(1);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  try {
    const order = await new WalmartOrdersApi(client).getOrderById(orderId);
    return NextResponse.json({ ok: true, order });
  } catch (err) {
    const status = err instanceof WalmartApiError ? err.status : 500;
    return NextResponse.json(
      { error: (err as Error).message },
      { status: status === 404 ? 404 : 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await ctx.params;
  let body: ActionBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !("action" in body)) {
    return NextResponse.json(
      { error: "Body must include `action`" },
      { status: 400 }
    );
  }

  let client: WalmartClient;
  try {
    client = new WalmartClient(1);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const api = new WalmartOrdersApi(client);

  try {
    let updated: WalmartOrder;
    switch (body.action) {
      case "acknowledge":
        updated = await api.acknowledgeOrder(orderId);
        break;
      case "cancel":
        if (!Array.isArray(body.lines) || body.lines.length === 0) {
          return NextResponse.json(
            { error: "cancel requires `lines` array" },
            { status: 400 }
          );
        }
        updated = await api.cancelOrderLines(orderId, body.lines);
        break;
      case "refund":
        if (!Array.isArray(body.lines) || body.lines.length === 0) {
          return NextResponse.json(
            { error: "refund requires `lines` array" },
            { status: 400 }
          );
        }
        updated = await api.refundOrderLines(orderId, body.lines);
        break;
      default:
        return NextResponse.json(
          { error: `Unknown action: ${(body as { action?: string }).action}` },
          { status: 400 }
        );
    }

    await persistAfterMutation(updated, 1);
    return NextResponse.json({ ok: true, action: body.action, order: updated });
  } catch (err) {
    const status = err instanceof WalmartApiError ? err.status : 500;
    const errorBody =
      err instanceof WalmartApiError ? err.errorBody : undefined;
    return NextResponse.json(
      { error: (err as Error).message, errorBody },
      { status: status >= 400 ? status : 500 }
    );
  }
}
