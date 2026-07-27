/**
 * POST /api/customer-hub/walmart/orders/sync
 *
 * Pulls Walmart orders from the Marketplace API and:
 *  1. Upserts every order into the WalmartOrder table.
 *  2. Creates a BuyerMessage record for any "interesting" order — currently:
 *     - Cancelled orders (customer cancellation we need to acknowledge)
 *     - Shipped orders past their estimatedDeliveryDate (delivery problem)
 *
 * Body (all optional):
 *   { storeIndex?: number, daysBack?: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type { WalmartOrder } from "@/lib/walmart/types";

const STORE_NAME_PREFIX = "Walmart"; // e.g. BuyerMessage.storeName = "Walmart - Sirius..."

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function customerName(order: WalmartOrder): string | undefined {
  const ship = order.shippingInfo?.postalAddress?.name;
  if (ship) return ship;
  return undefined;
}

function topProductLabel(order: WalmartOrder): string | undefined {
  return order.orderLines[0]?.productName;
}

async function upsertWalmartOrder(order: WalmartOrder, storeIndex: number) {
  const ship = order.shippingInfo?.postalAddress;
  return prisma.walmartOrder.upsert({
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
        (sum, l) => sum + (l.orderedQty || 0),
        0
      ),
      rawData: JSON.stringify(order.raw),
    },
    update: {
      status: order.status,
      orderTotal: order.orderTotal,
      estimatedShipDate: order.shippingInfo?.estimatedShipDate,
      estimatedDeliveryDate: order.shippingInfo?.estimatedDeliveryDate,
      rawData: JSON.stringify(order.raw),
    },
  });
}

interface MessageTrigger {
  reason: string;
  problemType: string;
  category: string;
  priority: string;
}

function detectMessageTrigger(order: WalmartOrder): MessageTrigger | null {
  // Customer cancelled — we need to handle in Customer Hub
  if (order.status === "Cancelled") {
    return {
      reason: "Order cancelled by customer / system",
      problemType: "CANCEL",
      category: "C7",
      priority: "MEDIUM",
    };
  }

  // Shipped but past EDD by 1+ day — possible delivery problem
  const edd = order.shippingInfo?.estimatedDeliveryDate;
  if (order.status === "Shipped" && edd) {
    const oneDayAfter = new Date(edd.getTime() + 86400 * 1000);
    if (oneDayAfter < new Date()) {
      return {
        reason: "Shipped but past estimated delivery date",
        problemType: "DELAY",
        category: "C2",
        priority: "HIGH",
      };
    }
  }

  return null;
}

async function maybeCreateBuyerMessage(
  order: WalmartOrder,
  storeIndex: number,
  storeName: string
) {
  const trigger = detectMessageTrigger(order);
  if (!trigger) return null;

  // Already have a message for this PO?
  const existing = await prisma.buyerMessage.findFirst({
    where: { walmartOrderId: order.purchaseOrderId },
  });
  if (existing) return null;

  return prisma.buyerMessage.create({
    data: {
      channel: "Walmart",
      source: "walmart_api",
      storeIndex,
      storeName: `${STORE_NAME_PREFIX} - ${storeName}`,
      walmartOrderId: order.purchaseOrderId,
      customerName: customerName(order),
      customerEmail: order.customerEmailId,
      orderDate: order.orderDate.toISOString().slice(0, 10),
      orderTotal: order.orderTotal,
      product: topProductLabel(order),
      quantity: order.orderLines.reduce(
        (sum, l) => sum + (l.orderedQty || 0),
        0
      ),
      problemType: trigger.problemType,
      problemTypeName: trigger.reason,
      category: trigger.category,
      priority: trigger.priority,
      status: "NEW",
      direction: "incoming",
      reasoning: `[walmart-sync] ${trigger.reason}`,
    },
  });
}

export async function POST(request: NextRequest) {
  let body: { storeIndex?: number; daysBack?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine
  }
  const storeIndex = body.storeIndex ?? 1;
  const daysBack = body.daysBack ?? 30;

  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }

  const ordersApi = new WalmartOrdersApi(client);
  const startDate = isoDaysAgo(daysBack);

  let synced = 0;
  let messagesCreated = 0;
  const errors: string[] = [];

  try {
    for await (const order of ordersApi.paginate({
      createdStartDate: startDate,
      limit: 100,
      productInfo: true,
    })) {
      try {
        await upsertWalmartOrder(order, storeIndex);
        const msg = await maybeCreateBuyerMessage(
          order,
          storeIndex,
          client.credentials.storeName
        );
        if (msg) messagesCreated++;
        synced++;
      } catch (err) {
        errors.push(
          `${order.purchaseOrderId}: ${(err as Error).message}`.slice(0, 200)
        );
      }
    }
  } catch (err) {
    const msg =
      err instanceof WalmartApiError
        ? `${err.message} (cid=${err.correlationId})`
        : (err as Error).message;
    return NextResponse.json(
      { error: msg, synced, messagesCreated, errors },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    storeIndex,
    daysBack,
    synced,
    messagesCreated,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
  });
}

export async function GET() {
  return NextResponse.json({
    description: "POST to sync Walmart orders for the given store",
    body: { storeIndex: "default 1", daysBack: "default 30" },
  });
}
