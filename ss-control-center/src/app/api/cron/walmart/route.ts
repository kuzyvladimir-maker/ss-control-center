/**
 * GET /api/cron/walmart
 *
 * Single nightly cron entry point for all Walmart sync jobs:
 *   - Orders (last 30d) — Customer Hub ingest
 *   - Returns (last 30d) — Customer Hub ingest
 *   - Shipment Monitor (last 7d) — tracking drift detection
 *   - Adjustments (all new recon dates)
 *   - Performance snapshots (30d + 90d)
 *
 * Auth: Vercel cron adds an `authorization: Bearer ${CRON_SECRET}` header
 * when CRON_SECRET is set. We validate it so nobody outside the platform
 * can trigger the job. Configured via vercel.json → crons.
 *
 * Each sub-sync runs independently; a failure in one doesn't stop the rest.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { WalmartReturnsApi } from "@/lib/walmart/returns";
import { WalmartReportsApi } from "@/lib/walmart/reports";
import { WalmartSellerPerformanceApi } from "@/lib/walmart/seller-performance";
import type {
  WalmartOrder,
  WalmartReturn,
  WalmartReconTransaction,
} from "@/lib/walmart/types";

const STORE_NAME_PREFIX = "Walmart";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // dev/local: no gate
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

// --- Sub-jobs (each returns a small summary, never throws to the caller) ---

async function syncOrders(client: WalmartClient, storeIndex: number, storeName: string) {
  const api = new WalmartOrdersApi(client);
  let synced = 0;
  let messagesCreated = 0;
  try {
    for await (const order of api.paginate({
      createdStartDate: isoDaysAgo(30),
      limit: 100,
      productInfo: true,
    })) {
      await upsertOrder(order, storeIndex);
      const m = await maybeCreateBuyerMessageForOrder(order, storeIndex, storeName);
      if (m) messagesCreated++;
      synced++;
    }
    return { name: "orders", ok: true, synced, messagesCreated };
  } catch (err) {
    return { name: "orders", ok: false, error: (err as Error).message, synced };
  }
}

async function syncReturns(client: WalmartClient, storeIndex: number, storeName: string) {
  const api = new WalmartReturnsApi(client);
  let synced = 0;
  let messagesCreated = 0;
  try {
    for await (const ret of api.paginate({
      returnCreationStartDate: isoDaysAgo(30),
      returnCreationEndDate: new Date().toISOString(),
      limit: 100,
    })) {
      const m = await maybeCreateBuyerMessageForReturn(ret, storeIndex, storeName);
      if (m) messagesCreated++;
      synced++;
    }
    return { name: "returns", ok: true, synced, messagesCreated };
  } catch (err) {
    return { name: "returns", ok: false, error: (err as Error).message, synced };
  }
}

async function syncShipmentMonitor(client: WalmartClient, storeIndex: number) {
  const api = new WalmartOrdersApi(client);
  let updated = 0;
  let mismatches = 0;
  try {
    for (const status of ["Shipped", "Delivered"] as const) {
      for await (const order of api.paginate({
        createdStartDate: isoDaysAgo(7),
        status,
        limit: 100,
      })) {
        const existing = await prisma.walmartOrder.findUnique({
          where: { purchaseOrderId: order.purchaseOrderId },
        });
        if (existing && existing.status !== order.status) mismatches++;
        await upsertOrder(order, storeIndex);
        updated++;
      }
    }
    return { name: "shipmentMonitor", ok: true, updated, mismatches };
  } catch (err) {
    return {
      name: "shipmentMonitor",
      ok: false,
      error: (err as Error).message,
      updated,
    };
  }
}

async function syncAdjustments(client: WalmartClient, storeIndex: number) {
  const reports = new WalmartReportsApi(client);
  try {
    const dates = await reports.getAvailableReconReportDates();
    let inserted = 0;
    let skipped = 0;
    for (const date of dates) {
      // Skip dates we already ingested entirely
      const already = await prisma.walmartReconTransaction.count({
        where: { storeIndex, reportDate: new Date(date) },
      });
      if (already > 0) {
        skipped += already;
        continue;
      }
      const txs = await reports.getFullReconReport(date);
      const r = await persistRecon(txs, date, storeIndex);
      inserted += r.inserted;
    }
    return { name: "adjustments", ok: true, inserted, skipped };
  } catch (err) {
    return { name: "adjustments", ok: false, error: (err as Error).message };
  }
}

async function syncPerformance(client: WalmartClient, storeIndex: number) {
  const api = new WalmartSellerPerformanceApi(client);
  try {
    let snapshots = 0;
    for (const w of [30, 90] as const) {
      const summary = await api.getSummary(w);
      for (const m of summary.metrics) {
        await prisma.walmartPerformanceSnapshot.create({
          data: {
            storeIndex,
            windowDays: m.windowDays,
            metric: m.metric,
            value: m.value,
            threshold: m.threshold,
            isHealthy: m.isHealthy,
            rawData: JSON.stringify(m.raw ?? null),
          },
        });
        snapshots++;
      }
    }
    return { name: "performance", ok: true, snapshots };
  } catch (err) {
    return { name: "performance", ok: false, error: (err as Error).message };
  }
}

// --- DB helpers shared with per-endpoint routes ---

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

async function maybeCreateBuyerMessageForOrder(
  order: WalmartOrder,
  storeIndex: number,
  storeName: string
) {
  let trigger: { reason: string; problemType: string; category: string; priority: string } | null = null;
  if (order.status === "Cancelled") {
    trigger = {
      reason: "Order cancelled",
      problemType: "CANCEL",
      category: "C7",
      priority: "MEDIUM",
    };
  } else if (order.status === "Shipped") {
    const edd = order.shippingInfo?.estimatedDeliveryDate;
    if (edd && edd.getTime() + 86400 * 1000 < Date.now()) {
      trigger = {
        reason: "Shipped but past estimated delivery date",
        problemType: "DELAY",
        category: "C2",
        priority: "HIGH",
      };
    }
  }
  if (!trigger) return null;

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
      customerName: order.shippingInfo?.postalAddress?.name,
      customerEmail: order.customerEmailId,
      orderDate: order.orderDate.toISOString().slice(0, 10),
      orderTotal: order.orderTotal,
      product: order.orderLines[0]?.productName,
      quantity: order.orderLines.reduce((s, l) => s + (l.orderedQty || 0), 0),
      problemType: trigger.problemType,
      problemTypeName: trigger.reason,
      category: trigger.category,
      priority: trigger.priority,
      status: "NEW",
      direction: "incoming",
      reasoning: `[cron] ${trigger.reason}`,
    },
  });
}

async function maybeCreateBuyerMessageForReturn(
  ret: WalmartReturn,
  storeIndex: number,
  storeName: string
) {
  const existing = await prisma.buyerMessage.findFirst({
    where: { walmartReturnId: ret.returnOrderId },
  });
  if (existing) return null;
  const firstLine = ret.returnLines[0];
  return prisma.buyerMessage.create({
    data: {
      channel: "Walmart",
      source: "walmart_api",
      storeIndex,
      storeName: `${STORE_NAME_PREFIX} - ${storeName}`,
      walmartReturnId: ret.returnOrderId,
      walmartOrderId: ret.purchaseOrderId,
      customerEmail: ret.customerEmail,
      orderDate: ret.returnDate.toISOString().slice(0, 10),
      product: firstLine?.productName,
      quantity: ret.returnLines.reduce((s, l) => s + (l.returnQuantity || 0), 0),
      problemType: "RETURN",
      problemTypeName: `Return ${ret.status}`,
      category: "C5",
      priority: "MEDIUM",
      status: "NEW",
      direction: "incoming",
      customerMessage: firstLine?.customerReturnReason || firstLine?.returnReason,
      reasoning: `[cron] Return initiated: ${ret.status}`,
    },
  });
}

async function persistRecon(
  txs: WalmartReconTransaction[],
  reportDate: string,
  storeIndex: number
) {
  let inserted = 0;
  const dt = new Date(reportDate);
  for (const tx of txs) {
    try {
      await prisma.walmartReconTransaction.create({
        data: {
          storeIndex,
          reportDate: dt,
          transactionPostedTimestamp: tx.transactionPostedTimestamp,
          transactionType: tx.transactionType,
          transactionDescription: tx.transactionDescription,
          purchaseOrderId: tx.purchaseOrderId,
          customerOrderId: tx.customerOrderId,
          sku: tx.sku,
          productName: tx.productName,
          quantity: tx.quantity,
          amount: tx.amount,
          feeType: tx.feeType,
          rawData: JSON.stringify(tx.raw),
        },
      });
      inserted++;
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes("Unique") && !msg.includes("UNIQUE")) throw err;
    }
  }
  return { inserted };
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  let client: WalmartClient;
  try {
    client = new WalmartClient(1);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }

  const startedAt = Date.now();
  const results = await Promise.all([
    syncOrders(client, 1, client.credentials.storeName),
    syncReturns(client, 1, client.credentials.storeName),
    syncShipmentMonitor(client, 1),
    syncAdjustments(client, 1),
    syncPerformance(client, 1),
  ]);

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    durationMs: Date.now() - startedAt,
    results,
  });
}
