/**
 * GET /api/shipping/nan-rates/pending   (collector, header x-nan-rates-secret)
 * Orders whose rates the owner asked to refresh, oldest request first:
 *   {pending:[{order_name:"#1374", shopify_order_id, refresh_requested_at}]}
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rows = await prisma.nanRateSnapshot.findMany({
    where: { refreshRequestedAt: { not: null } },
    orderBy: { refreshRequestedAt: "asc" },
    take: 50,
  });
  return NextResponse.json({
    pending: rows.map((r) => ({
      order_name: `#${r.orderNumber}`,
      shopify_order_id: r.shopifyOrderId,
      refresh_requested_at: r.refreshRequestedAt?.toISOString() ?? null,
    })),
  });
}
