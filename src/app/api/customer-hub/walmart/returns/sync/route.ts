/**
 * POST /api/customer-hub/walmart/returns/sync
 *
 * Pulls Walmart returns from the Marketplace API and creates a BuyerMessage
 * for any return we haven't seen before.
 *
 * Body (optional):
 *   { storeIndex?: number, daysBack?: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartReturnsApi } from "@/lib/walmart/returns";
import type { WalmartReturn } from "@/lib/walmart/types";

const STORE_NAME_PREFIX = "Walmart";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
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
      quantity: ret.returnLines.reduce(
        (sum, l) => sum + (l.returnQuantity || 0),
        0
      ),
      problemType: "RETURN",
      problemTypeName: `Return ${ret.status}`,
      category: "C5",
      priority: "MEDIUM",
      status: "NEW",
      direction: "incoming",
      customerMessage: firstLine?.customerReturnReason || firstLine?.returnReason,
      reasoning: `[walmart-sync] Return initiated: ${ret.status}; line0=${firstLine?.eventTag ?? "?"}`,
    },
  });
}

export async function POST(request: NextRequest) {
  let body: { storeIndex?: number; daysBack?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body
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

  const api = new WalmartReturnsApi(client);

  let synced = 0;
  let messagesCreated = 0;
  const errors: string[] = [];

  try {
    for await (const ret of api.paginate({
      returnCreationStartDate: isoDaysAgo(daysBack),
      returnCreationEndDate: new Date().toISOString(),
      limit: 100,
    })) {
      try {
        synced++;
        const m = await maybeCreateBuyerMessageForReturn(
          ret,
          storeIndex,
          client.credentials.storeName
        );
        if (m) messagesCreated++;
      } catch (err) {
        errors.push(
          `${ret.returnOrderId}: ${(err as Error).message}`.slice(0, 200)
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
    description: "POST to sync Walmart returns for the given store",
    body: { storeIndex: "default 1", daysBack: "default 30" },
  });
}
