/**
 * POST /api/shipping/nan-rates/refresh  {order: "#1374", shopifyOrderId?, package?}
 * Queue a Shopify rate re-quote for the collector (it polls
 * /api/shipping/nan-rates/pending). `package` = {l,w,h,weight_lb} from the
 * card's Package tile: from now on this order is quoted with that box/weight.
 * Buys nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normOrderNumber } from "@/lib/shipping/nan-rates";

function cleanPackage(p: unknown): string | undefined {
  if (!p || typeof p !== "object") return undefined;
  const o = p as Record<string, unknown>;
  const n = (k: string) => Number(o[k]);
  const pkg = { l: n("l"), w: n("w"), h: n("h"), weight_lb: n("weight_lb") };
  return Object.values(pkg).every((v) => Number.isFinite(v) && v > 0)
    ? JSON.stringify(pkg)
    : undefined;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const orderNumber = normOrderNumber(body?.order);
  if (!orderNumber) {
    return NextResponse.json({ error: "order is required" }, { status: 400 });
  }
  const now = new Date();
  const shopifyOrderId = body?.shopifyOrderId ? String(body.shopifyOrderId) : undefined;
  const packageOverrideJson = cleanPackage(body?.package);
  await prisma.nanRateSnapshot.upsert({
    where: { orderNumber },
    create: {
      orderNumber,
      refreshRequestedAt: now,
      shopifyOrderId: shopifyOrderId ?? null,
      packageOverrideJson: packageOverrideJson ?? null,
    },
    update: {
      refreshRequestedAt: now,
      ...(shopifyOrderId ? { shopifyOrderId } : {}),
      ...(packageOverrideJson ? { packageOverrideJson } : {}),
    },
  });
  return NextResponse.json({ ok: true, orderNumber, refreshRequestedAt: now.toISOString() });
}
