/**
 * Live NAN Health (Shopify) rates — the latest snapshot per order.
 *
 *   POST /api/shipping/nan-rates   collector → us (header x-nan-rates-secret)
 *        {captured_at, orders:[{order_name, shopify_order_id, dest, package, rates}]}
 *        Upserts one row per order and clears its refresh request when the
 *        snapshot is newer than the request.
 *   GET  /api/shipping/nan-rates?orders=1374,1375   the card (session)
 *
 * Read-only reference: nothing here buys a label; the owner buys in Shopify.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normOrderNumber, parseNanPayload } from "@/lib/shipping/nan-rates";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const { capturedAt, orders } = parseNanPayload(body);
  if (!capturedAt || orders.length === 0) {
    return NextResponse.json(
      { error: "captured_at (ISO) and at least one order with rates are required" },
      { status: 400 },
    );
  }
  const saved: string[] = [];
  for (const o of orders) {
    const prev = await prisma.nanRateSnapshot.findUnique({
      where: { orderNumber: o.orderNumber },
      select: { capturedAt: true, refreshRequestedAt: true },
    });
    // Never let an older capture overwrite a newer one.
    if (prev?.capturedAt && prev.capturedAt > capturedAt) continue;
    const clearRequest =
      !prev?.refreshRequestedAt || prev.refreshRequestedAt <= capturedAt;
    const data = {
      shopifyOrderId: o.shopifyOrderId,
      capturedAt,
      destJson: o.dest ? JSON.stringify(o.dest) : null,
      packageJson: o.pkg ? JSON.stringify(o.pkg) : null,
      ratesJson: JSON.stringify(o.rates),
      ...(clearRequest ? { refreshRequestedAt: null } : {}),
    };
    await prisma.nanRateSnapshot.upsert({
      where: { orderNumber: o.orderNumber },
      create: { orderNumber: o.orderNumber, ...data },
      update: data,
    });
    saved.push(o.orderNumber);
  }
  return NextResponse.json({ ok: true, saved });
}

export async function GET(request: NextRequest) {
  const orders = (request.nextUrl.searchParams.get("orders") ?? "")
    .split(",")
    .map(normOrderNumber)
    .filter(Boolean)
    .slice(0, 200);
  if (orders.length === 0) return NextResponse.json({ snapshots: {} });
  const rows = await prisma.nanRateSnapshot.findMany({
    where: { orderNumber: { in: orders } },
  });
  const snapshots: Record<string, unknown> = {};
  for (const r of rows) {
    snapshots[r.orderNumber] = {
      orderNumber: r.orderNumber,
      shopifyOrderId: r.shopifyOrderId,
      capturedAt: r.capturedAt?.toISOString() ?? null,
      refreshRequestedAt: r.refreshRequestedAt?.toISOString() ?? null,
      dest: r.destJson ? JSON.parse(r.destJson) : null,
      pkg: r.packageJson ? JSON.parse(r.packageJson) : null,
      rates: JSON.parse(r.ratesJson),
    };
  }
  return NextResponse.json({ snapshots });
}
