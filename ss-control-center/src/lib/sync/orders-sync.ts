import { prisma } from "@/lib/prisma";
import { spApiGet } from "@/lib/amazon-sp-api/client";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function syncOrders(storeIndex: number): Promise<number> {
  const storeId = `store${storeIndex}`;
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allOrders: any[] = [];
  let nextToken: string | undefined;

  do {
    const params: Record<string, string> = {
      MarketplaceIds: process.env.AMAZON_SP_MARKETPLACE_ID || "ATVPDKIKX0DER",
      CreatedAfter: thirtyDaysAgo,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
