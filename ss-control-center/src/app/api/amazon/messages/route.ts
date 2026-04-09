import { NextRequest, NextResponse } from "next/server";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { spApiGet } from "@/lib/amazon-sp-api/client";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = parseInt(sp.get("store") || "1");
  const limit = parseInt(sp.get("limit") || "30");

  const creds = getStoreCredentials(storeIndex);
  if (!creds) {
    return NextResponse.json({
      orders: [],
      error: "Store not configured",
    });
  }

  try {
    const storeId = `store${storeIndex}`;
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();

    const data = await spApiGet("/orders/v0/orders", {
      storeId,
      params: {
        MarketplaceIds:
          process.env.AMAZON_SP_MARKETPLACE_ID || "ATVPDKIKX0DER",
        CreatedAfter: thirtyDaysAgo,
        MaxResultsPerPage: String(Math.min(limit, 50)),
      },
    });

    const orders = (data.payload?.Orders || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o: any) => ({
        orderId: o.AmazonOrderId,
        buyerName: o.BuyerInfo?.BuyerName || "Customer",
        orderDate: o.PurchaseDate,
        orderStatus: o.OrderStatus,
        orderTotal: o.OrderTotal?.Amount
          ? `$${parseFloat(o.OrderTotal.Amount).toFixed(2)}`
          : null,
        currency: o.OrderTotal?.CurrencyCode || "USD",
        shipBy: o.LatestShipDate,
        deliverBy: o.LatestDeliveryDate,
        itemCount: o.NumberOfItemsShipped || o.NumberOfItemsUnshipped || 0,
        salesChannel: o.SalesChannel,
      })
    );

    return NextResponse.json({
      storeIndex,
      orders,
      total: orders.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Messages fetch error:", error);
    return NextResponse.json({
      orders: [],
      error: error instanceof Error ? error.message : "Failed to fetch orders",
    });
  }
}
