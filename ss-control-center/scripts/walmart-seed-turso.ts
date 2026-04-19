/**
 * One-shot seed: pull first 30 Walmart orders and upsert into Turso.
 * Used to verify the end-to-end integration after deploy.
 * Run: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/walmart-seed-turso.ts
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { WalmartClient } from "../src/lib/walmart/client";
import { WalmartOrdersApi } from "../src/lib/walmart/orders";

async function main() {
  const client = new WalmartClient(1);
  const api = new WalmartOrdersApi(client);

  let count = 0;
  let stored = 0;
  for await (const order of api.paginate({
    createdStartDate: new Date(Date.now() - 30 * 86400000).toISOString(),
    limit: 100,
    productInfo: true,
  })) {
    count++;
    if (count > 30) break;
    try {
      await prisma.walmartOrder.upsert({
        where: { purchaseOrderId: order.purchaseOrderId },
        create: {
          purchaseOrderId: order.purchaseOrderId,
          customerOrderId: order.customerOrderId,
          customerEmailId: order.customerEmailId,
          storeIndex: 1,
          status: order.status,
          shipNodeType: order.shipNodeType,
          orderType: order.orderType,
          orderDate: order.orderDate,
          estimatedShipDate: order.shippingInfo?.estimatedShipDate,
          estimatedDeliveryDate: order.shippingInfo?.estimatedDeliveryDate,
          orderTotal: order.orderTotal,
          currency: order.currency || "USD",
          shipCity: order.shippingInfo?.postalAddress?.city,
          shipState: order.shippingInfo?.postalAddress?.state,
          shipZip: order.shippingInfo?.postalAddress?.postalCode,
          shipCountry: order.shippingInfo?.postalAddress?.country,
          numberOfItems: order.orderLines.reduce(
            (s, l) => s + (l.orderedQty || 0),
            0
          ),
          rawData: JSON.stringify(order.raw),
        },
        update: { status: order.status, orderTotal: order.orderTotal },
      });
      stored++;
    } catch (e) {
      console.error(
        "Failed:",
        order.purchaseOrderId,
        (e as Error).message.slice(0, 200)
      );
      break;
    }
  }

  const total = await prisma.walmartOrder.count();
  console.log(`processed=${count} stored=${stored} totalInDb=${total}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
