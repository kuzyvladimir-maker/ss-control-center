/**
 * GET /api/shipping/nan-rates/pending   (collector, header x-nan-rates-secret)
 * Orders the owner asked to refresh, oldest request first, with the package
 * set on the card (if any):
 *   {pending:[{order_name:"#1374", shopify_order_id, refresh_requested_at, package}],
 *    packages:{"1374": {l,w,h,weight_lb}, …}}   ← every order with a card package
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rows = await prisma.nanRateSnapshot.findMany({
    where: {
      OR: [{ refreshRequestedAt: { not: null } }, { packageOverrideJson: { not: null } }],
    },
    orderBy: { refreshRequestedAt: "asc" },
    take: 200,
  });
  const parse = (s: string | null) => (s ? JSON.parse(s) : null);
  return NextResponse.json({
    pending: rows
      .filter((r) => r.refreshRequestedAt)
      .map((r) => ({
        order_name: `#${r.orderNumber}`,
        shopify_order_id: r.shopifyOrderId,
        refresh_requested_at: r.refreshRequestedAt?.toISOString() ?? null,
        package: parse(r.packageOverrideJson),
      })),
    packages: Object.fromEntries(
      rows
        .filter((r) => r.packageOverrideJson)
        .map((r) => [r.orderNumber, parse(r.packageOverrideJson)]),
    ),
  });
}
