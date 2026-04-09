/**
 * Amazon Finances API
 * Role required: Finance and Accounting
 * Used for: Adjustments Monitor, A-to-Z Claims tracking
 */

import { spApiGet } from "./client";

/** Get financial events (adjustments, charges, refunds) */
export async function getFinancialEvents(options: {
  storeId?: string;
  postedAfter: string; // ISO 8601 date
  postedBefore?: string;
  maxResults?: number;
}) {
  const {
    storeId = "store1",
    postedAfter,
    postedBefore,
    maxResults = 100,
  } = options;

  const params: Record<string, string> = {
    PostedAfter: postedAfter,
    MaxResultsPerPage: String(maxResults),
  };
  if (postedBefore) params.PostedBefore = postedBefore;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allEvents: any[] = [];
  let nextToken: string | undefined;

  do {
    if (nextToken) params.NextToken = nextToken;
    const response = await spApiGet("/finances/v0/financialEvents", {
      storeId,
      params,
    });
    const events = response.payload?.FinancialEvents;
    if (events) allEvents.push(events);
    nextToken = response.payload?.NextToken;
  } while (nextToken);

  return allEvents;
}

/** Get financial events for a specific order */
export async function getOrderFinancialEvents(
  amazonOrderId: string,
  storeId = "store1"
) {
  const response = await spApiGet(
    `/finances/v0/orders/${amazonOrderId}/financialEvents`,
    { storeId }
  );
  return response.payload?.FinancialEvents;
}

/**
 * Parse adjustment events from financial events response
 * Returns only ShipmentEvents with adjustments (carrier corrections)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseAdjustments(financialEvents: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adjustments: any[] = [];

  for (const events of financialEvents) {
    const adjEvents = events.AdjustmentEventList || [];
    for (const adj of adjEvents) {
      if (
        [
          "ShippingChargeback",
          "CarrierAdjustment",
          "WeightAdjustment",
        ].includes(adj.AdjustmentType)
      ) {
        for (const item of adj.AdjustmentItemList || []) {
          adjustments.push({
            type: adj.AdjustmentType,
            date: adj.PostedDate,
            orderId: item.OrderId,
            sku: item.SellerSKU,
            amount: parseFloat(item.TotalAmount?.CurrencyAmount || "0"),
            reason: item.Title || adj.AdjustmentType,
          });
        }
      }
    }
  }

  return adjustments;
}
