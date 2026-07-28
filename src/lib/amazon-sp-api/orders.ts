/**
 * Amazon Orders API
 * Role required: Inventory and Order Tracking
 */

import { spApiGet, MARKETPLACE_ID } from "./client";

export interface AmazonOrder {
  AmazonOrderId: string;
  OrderStatus: string;
  PurchaseDate: string;
  LastUpdateDate: string;
  OrderTotal?: { Amount: string; CurrencyCode: string };
  ShippingAddress?: {
    Name: string;
    AddressLine1: string;
    City: string;
    StateOrRegion: string;
    PostalCode: string;
    CountryCode: string;
  };
  BuyerInfo?: { BuyerEmail: string; BuyerName: string };
  EarliestShipDate?: string;
  LatestShipDate?: string;
  EarliestDeliveryDate?: string;
  LatestDeliveryDate?: string;
  NumberOfItemsShipped?: number;
  NumberOfItemsUnshipped?: number;
  PaymentMethod?: string;
  MarketplaceId?: string;
  SalesChannel?: string;
}

/** Get a single order by Amazon Order ID */
export async function getOrder(
  amazonOrderId: string,
  storeId = "store1"
): Promise<AmazonOrder> {
  const response = await spApiGet(`/orders/v0/orders/${amazonOrderId}`, {
    storeId,
  });
  return response.payload;
}

/** Get order items for an order */
export async function getOrderItems(
  amazonOrderId: string,
  storeId = "store1"
) {
  const response = await spApiGet(
    `/orders/v0/orders/${amazonOrderId}/orderItems`,
    { storeId }
  );
  return response.payload?.OrderItems || [];
}

/** Get orders with filters */
export async function getOrders(options: {
  storeId?: string;
  createdAfter?: string;
  orderStatuses?: string[];
  maxResults?: number;
}) {
  const {
    storeId = "store1",
    createdAfter,
    orderStatuses,
    maxResults = 100,
  } = options;

  const params: Record<string, string> = {
    MarketplaceIds: MARKETPLACE_ID,
    MaxResultsPerPage: String(maxResults),
  };

  if (createdAfter) params.CreatedAfter = createdAfter;
  if (orderStatuses?.length) params.OrderStatuses = orderStatuses.join(",");

  const allOrders: AmazonOrder[] = [];
  let nextToken: string | undefined;

  do {
    if (nextToken) params.NextToken = nextToken;

    const response = await spApiGet("/orders/v0/orders", { storeId, params });
    const orders = response.payload?.Orders || [];
    allOrders.push(...orders);
    nextToken = response.payload?.NextToken;
  } while (nextToken);

  return allOrders;
}
