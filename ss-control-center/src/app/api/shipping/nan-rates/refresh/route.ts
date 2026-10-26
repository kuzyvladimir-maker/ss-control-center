/**
 * POST /api/shipping/nan-rates/refresh  {order: "#1374", shopifyOrderId?}
 * The card's "Обновить" button: queue a rate refresh for the collector
 * (it polls /api/shipping/nan-rates/pending). Buys nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normOrderNumber } from "@/lib/shipping/nan-rates";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const orderNumber = normOrderNumber(body?.order);
  if (!orderNumber) {
    return NextResponse.json({ error: "order is required" }, { status: 400 });
  }
  const now = new Date();
  const shopifyOrderId = body?.shopifyOrderId ? String(body.shopifyOrderId) : undefined;
  await prisma.nanRateSnapshot.upsert({
    where: { orderNumber },
    create: { orderNumber, refreshRequestedAt: now, shopifyOrderId: shopifyOrderId ?? null },
    update: { refreshRequestedAt: now, ...(shopifyOrderId ? { shopifyOrderId } : {}) },
  });
  return NextResponse.json({ ok: true, orderNumber, refreshRequestedAt: now.toISOString() });
}
