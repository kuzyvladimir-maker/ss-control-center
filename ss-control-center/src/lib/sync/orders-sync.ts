import { prisma } from "@/lib/prisma";
import { spApiGet } from "@/lib/amazon-sp-api/client";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pull Amazon orders for a single store and upsert them to `amazonOrder`.
 *
 * `sinceDays` controls the lookback window. The default of 30 matches what
 * `/api/sync` (Dashboard Refresh, Settings Sync-all) needs to recompute
 * the 30-day KPIs. The cron path (`/api/cron/orders-amazon`) uses a tight
 * 3-day window so it fits inside Vercel's 10s function budget while still
 * keeping "today's sales" and recent status changes fresh.
 */
export async function syncOrders(
  storeIndex: number,
  sinceDays = 30
): Promise<number> {
  const storeId = `store${storeIndex}`;
  const createdAfter = new Date(
    Date.now() - sinceDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allOrders: any[] = [];
  let nextToken: string | undefined;

  do {
    const params: Record<string, string> = {
      MarketplaceIds: process.env.AMAZON_SP_MARKETPLACE_ID || "ATVPDKIKX0DER",
      CreatedAfter: createdAfter,
      MaxResultsPerPage: "100",
    };
    if (nextToken) params.NextToken = nextToken;

    const data = await spApiGet("/orders/v0/orders", { storeId, params });
    const orders = data.payload?.Orders || [];
    allOrders.push(...orders);
    nextToken = data.payload?.NextToken;

    if (nextToken) await sleep(1500);
  } while (nextToken);

  let synced = 0;
  for (const o of allOrders) {
    await prisma.amazonOrder.upsert({
      where: { amazonOrderId: o.AmazonOrderId },
      create: {
        amazonOrderId: o.AmazonOrderId,
        storeIndex,
        status: o.OrderStatus || "Unknown",
        purchaseDate: new Date(o.PurchaseDate),
        lastUpdateDate: o.LastUpdateDate ? new Date(o.LastUpdateDate) : null,
        orderTotal: parseFloat(o.OrderTotal?.Amount || "0"),
        currency: o.OrderTotal?.CurrencyCode || "USD",
        buyerName: o.BuyerInfo?.BuyerName,
        buyerEmail: o.BuyerInfo?.BuyerEmail,
        shipCity: o.ShippingAddress?.City,
        shipState: o.ShippingAddress?.StateOrRegion,
        shipZip: o.ShippingAddress?.PostalCode,
        shipCountry: o.ShippingAddress?.CountryCode,
        latestShipDate: o.LatestShipDate ? new Date(o.LatestShipDate) : null,
        latestDeliveryDate: o.LatestDeliveryDate
          ? new Date(o.LatestDeliveryDate)
          : null,
        numberOfItems:
          (o.NumberOfItemsShipped || 0) + (o.NumberOfItemsUnshipped || 0),
        fulfillmentChannel: o.FulfillmentChannel,
        salesChannel: o.SalesChannel,
        cancellationReason: o.CancellationReason,
      },
      update: {
        status: o.OrderStatus || "Unknown",
        lastUpdateDate: o.LastUpdateDate ? new Date(o.LastUpdateDate) : null,
        cancellationReason: o.CancellationReason,
      },
    });
    synced++;
  }

  return synced;
}
