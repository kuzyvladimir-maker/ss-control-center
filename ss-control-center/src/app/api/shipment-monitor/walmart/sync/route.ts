/**
 * POST /api/shipment-monitor/walmart/sync
 *
 * Pulls Shipped/Delivered Walmart orders from the last N days, refreshes
 * their tracking info from Walmart, and writes a snapshot back into the
 * WalmartOrder table. This is the Level-1.5 layer above Veeqo: Walmart's
 * own status often reflects buyer-side tracking events sooner than Veeqo's
 * carrier polling does.
 *
 * For each order we also flag mismatch when Walmart marks an order
 * "Delivered" while our local copy still shows it Shipped — so the operator
 * can sweep stale shipments without manually clicking each one.
 *
 * Body (optional):
 *   { storeIndex?: number, daysBack?: number }
 *
 * Returns:
 *   {
 *     ok: true,
 *     totalSeen: N,
 *     updated: N,
 *     newlyDelivered: N,                  // local→delivered transitions
 *     mismatches: [{ purchaseOrderId, walmartStatus, localStatus }],
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type { WalmartOrder } from "@/lib/walmart/types";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

interface Mismatch {
  purchaseOrderId: string;
  walmartStatus: string;
  localStatus: string;
}

export async function POST(request: NextRequest) {
  let body: { storeIndex?: number; daysBack?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body
  }
  const storeIndex = body.storeIndex ?? 1;
  const daysBack = body.daysBack ?? 7;

  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }

  const api = new WalmartOrdersApi(client);
  const mismatches: Mismatch[] = [];
  let totalSeen = 0;
  let updated = 0;
  let newlyDelivered = 0;
  const errors: string[] = [];

  // We're interested in orders that should have moved on the carrier side
  // recently — Shipped or Delivered. Created/Acknowledged are pre-shipment.
  for (const status of ["Shipped", "Delivered"] as const) {
    try {
      for await (const order of api.paginate({
        createdStartDate: isoDaysAgo(daysBack),
        status,
        limit: 100,
      })) {
        totalSeen++;
        try {
          const result = await syncOne(order, storeIndex);
          if (result.updated) updated++;
          if (result.newlyDelivered) newlyDelivered++;
          if (result.mismatch) mismatches.push(result.mismatch);
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
      errors.push(`status=${status}: ${msg}`.slice(0, 200));
    }
  }

  return NextResponse.json({
    ok: true,
    storeIndex,
    daysBack,
    totalSeen,
    updated,
    newlyDelivered,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 20),
    errorCount: errors.length,
    errors: errors.slice(0, 10),
  });
}

async function syncOne(
  order: WalmartOrder,
  storeIndex: number
): Promise<{
  updated: boolean;
  newlyDelivered: boolean;
  mismatch?: Mismatch;
}> {
  const ship = order.shippingInfo?.postalAddress;

  const existing = await prisma.walmartOrder.findUnique({
    where: { purchaseOrderId: order.purchaseOrderId },
  });

  // Detect mismatch BEFORE updating: if local says Shipped and Walmart says
  // Delivered, that's a stale local row we want to flag.
  let mismatch: Mismatch | undefined;
  let newlyDelivered = false;
  if (existing) {
    if (existing.status !== order.status) {
      mismatch = {
        purchaseOrderId: order.purchaseOrderId,
        walmartStatus: order.status,
        localStatus: existing.status,
      };
      if (
        existing.status === "Shipped" &&
        order.status === "Delivered"
      ) {
        newlyDelivered = true;
      }
    }
  }

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

  return { updated: true, newlyDelivered, mismatch };
}

export async function GET() {
  return NextResponse.json({
    description:
      "POST to refresh tracking + status for Shipped/Delivered Walmart orders. Detects local↔Walmart status drift.",
    body: { storeIndex: "default 1", daysBack: "default 7" },
  });
}
