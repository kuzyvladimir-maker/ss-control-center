/**
 * Rate snapshots from a marketplace admin UI (NAN Health / Shopify) — the
 * rates Shopify's API won't list. Read-only reference for the owner, who buys
 * these labels himself; nothing here buys anything.
 *
 *   POST /api/shipping/rate-snapshots   {order, rates, captured, dest?, pkg?, source?, channel?}
 *        auth: the usual session, or SSCC_API_TOKEN / JACKIE_API_TOKEN bearer
 *   GET  /api/shipping/rate-snapshots?orders=1374,1375   → latest per order
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  normOrderNumber,
  normalizeSnapshotRates,
} from "@/lib/shipping/rate-snapshot";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const orderNumber = normOrderNumber(body?.order ?? body?.orderNumber);
  const rates = normalizeSnapshotRates(body?.rates);
  const capturedAt = String(body?.captured ?? body?.capturedAt ?? "").trim();
  if (!orderNumber || rates.length === 0 || !capturedAt) {
    return NextResponse.json(
      { error: "order, captured and a non-empty rates list are required" },
      { status: 400 },
    );
  }
  const row = await prisma.shippingRateSnapshot.create({
    data: {
      orderNumber,
      channel: String(body?.channel ?? "NAN health"),
      source: body?.source ? String(body.source) : null,
      capturedAt,
      dest: body?.dest ? String(body.dest) : null,
      pkg: body?.pkg ? String(body.pkg) : null,
      ratesJson: JSON.stringify(rates),
    },
  });
  return NextResponse.json({ ok: true, id: row.id, orderNumber, rates: rates.length });
}

export async function GET(request: NextRequest) {
  const orders = (request.nextUrl.searchParams.get("orders") ?? "")
    .split(",")
    .map(normOrderNumber)
    .filter(Boolean)
    .slice(0, 200);
  if (orders.length === 0) return NextResponse.json({ snapshots: {} });
  const rows = await prisma.shippingRateSnapshot.findMany({
    where: { orderNumber: { in: orders } },
    orderBy: { createdAt: "desc" },
  });
  const latest: Record<string, unknown> = {};
  for (const r of rows) {
    if (latest[r.orderNumber]) continue; // newest first
    latest[r.orderNumber] = {
      orderNumber: r.orderNumber,
      capturedAt: r.capturedAt,
      dest: r.dest,
      pkg: r.pkg,
      source: r.source,
      rates: JSON.parse(r.ratesJson),
    };
  }
  return NextResponse.json({ snapshots: latest });
}
