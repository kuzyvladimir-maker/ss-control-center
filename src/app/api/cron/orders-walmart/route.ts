/**
 * GET /api/cron/orders-walmart
 *
 * Lightweight Walmart orders refresh — pulls just the last 3 days of orders
 * for the configured Walmart account and upserts to `walmartOrder`. Sized
 * to stay well under the 300s function timeout so it can run every 2h.
 *
 * Why this exists: Dashboard's "Sales today" card sums orderTotal from
 * `walmartOrder`. The heavier nightly cron (/api/cron/walmart) only runs
 * once a day at 06:00 UTC, so until ~7 AM ET next morning Vladimir sees
 * today's actual Walmart revenue as ~$0. This lightweight cron tops up
 * the same table every 2 hours so the dashboard tracks the day in real
 * time without rewriting the heavy nightly job.
 *
 * The nightly cron still owns the 30-day reconcile sweep + returns +
 * shipment monitor + adjustments + catalog sync — anything that benefits
 * from a longer lookback or a slower cadence stays there.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type { WalmartOrder } from "@/lib/walmart/types";

export const maxDuration = 60;

const STORE_INDEX = 1;
const WINDOW_DAYS = 3;

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

async function upsertOrder(order: WalmartOrder, storeIndex: number) {
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
        (s, l) => s + (l.orderedQty || 0),
        0,
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

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const startedAt = Date.now();
  const log = await prisma.syncLog.create({
    data: {
      jobName: "orders-walmart-light",
      storeIndex: STORE_INDEX,
      status: "running",
    },
  });

  let synced = 0;
  try {
    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);

    for await (const order of api.paginate({
      createdStartDate: isoDaysAgo(WINDOW_DAYS),
      limit: 100,
      productInfo: true,
    })) {
      await upsertOrder(order, STORE_INDEX);
      synced++;
    }

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "done",
        completedAt: new Date(),
        itemsSynced: synced,
      },
    });

    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      windowDays: WINDOW_DAYS,
      synced,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron orders-walmart]", msg);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", completedAt: new Date(), error: msg, itemsSynced: synced },
    });
    return NextResponse.json({ ok: false, error: msg, synced }, { status: 500 });
  }
}
