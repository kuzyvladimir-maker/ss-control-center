/**
 * Walmart Orders API wrapper.
 * Endpoints: /v3/orders, /v3/orders/released, /v3/orders/{po}/...
 *
 * Pagination: Walmart returns `meta.nextCursor` when more pages exist. When
 * present it is an opaque string you pass as-is to the next call. The cursor
 * already encodes the original filter — do NOT send createdStartDate etc
 * alongside it.
 */

import type { WalmartClient } from "./client";
import { mapOrder, unwrapList } from "./mappers";
import type {
  WalmartCancelLineInput,
  WalmartOrder,
  WalmartOrderStatus,
  WalmartRefundLineInput,
  WalmartShipLineInput,
  WalmartShipNodeType,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OrdersListParams {
  createdStartDate?: string;      // ISO 8601 (YYYY-MM-DD or full)
  createdEndDate?: string;
  fromExpectedShipDate?: string;
  toExpectedShipDate?: string;
  status?: WalmartOrderStatus;
  shipNodeType?: WalmartShipNodeType;
  purchaseOrderId?: string;
  customerOrderId?: string;
  sku?: string;
  limit?: number;                 // 1..200, default 100
  nextCursor?: string;
  productInfo?: boolean;
  replacementInfo?: boolean;
}

export interface OrdersPage {
  orders: WalmartOrder[];
  nextCursor?: string;
  totalCount: number;
}

function buildOrdersQuery(params: OrdersListParams): Record<string, string | number> {
  // When nextCursor is present, Walmart says send ONLY the cursor.
  if (params.nextCursor) {
    return { nextCursor: params.nextCursor };
  }
  const q: Record<string, string | number> = {};
  if (params.createdStartDate) q.createdStartDate = params.createdStartDate;
  if (params.createdEndDate) q.createdEndDate = params.createdEndDate;
  if (params.fromExpectedShipDate) q.fromExpectedShipDate = params.fromExpectedShipDate;
  if (params.toExpectedShipDate) q.toExpectedShipDate = params.toExpectedShipDate;
  if (params.status) q.status = params.status;
  if (params.shipNodeType) q.shipNodeType = params.shipNodeType;
  if (params.purchaseOrderId) q.purchaseOrderId = params.purchaseOrderId;
  if (params.customerOrderId) q.customerOrderId = params.customerOrderId;
  if (params.sku) q.sku = params.sku;
  if (params.limit) q.limit = params.limit;
  if (params.productInfo) q.productInfo = "true";
  if (params.replacementInfo) q.replacementInfo = "true";
  return q;
}

function parseOrdersPage(payload: any): OrdersPage {
  const rawOrders = unwrapList<any>(payload?.list?.elements, "order");
  const orders = rawOrders.map(mapOrder);
  return {
    orders,
    nextCursor: payload?.list?.meta?.nextCursor || undefined,
    totalCount: Number(payload?.list?.meta?.totalCount ?? orders.length),
  };
}

export class WalmartOrdersApi {
  constructor(private client: WalmartClient) {}

  async getAllOrders(params: OrdersListParams = {}): Promise<OrdersPage> {
    const data = await this.client.request<any>("GET", "/orders", {
      params: buildOrdersQuery(params),
    });
    return parseOrdersPage(data);
  }

  async getReleasedOrders(params: OrdersListParams = {}): Promise<OrdersPage> {
    const data = await this.client.request<any>("GET", "/orders/released", {
      params: buildOrdersQuery(params),
    });
    return parseOrdersPage(data);
  }

  async getOrderById(purchaseOrderId: string): Promise<WalmartOrder> {
    const data = await this.client.request<any>(
      "GET",
      `/orders/${encodeURIComponent(purchaseOrderId)}`
    );
    // Single-order response is either `{ order: {...} }` or the order directly
    const rawOrder = data?.order ?? data;
    return mapOrder(rawOrder);
  }

  /** Async generator that walks through every page. */
  async *paginate(params: OrdersListParams = {}): AsyncGenerator<WalmartOrder> {
    let cursor: string | undefined;
    let first = true;
    do {
      const page = await this.getAllOrders(
        first ? params : { nextCursor: cursor }
      );
      first = false;
      for (const o of page.orders) yield o;
      cursor = page.nextCursor;
    } while (cursor);
  }

  async acknowledgeOrder(purchaseOrderId: string): Promise<WalmartOrder> {
    const data = await this.client.request<any>(
      "POST",
      `/orders/${encodeURIComponent(purchaseOrderId)}/acknowledge`
    );
    return mapOrder(data?.order ?? data);
  }

  async cancelOrderLines(
    purchaseOrderId: string,
    lines: WalmartCancelLineInput[]
  ): Promise<WalmartOrder> {
    const body = {
      orderCancellation: {
        orderLines: {
          orderLine: lines.map((l) => ({
            lineNumber: l.lineNumber,
            orderLineStatuses: {
              orderLineStatus: [
                {
                  status: "Cancelled",
                  cancellationReason:
                    l.reason || "CUSTOMER_REQUESTED_SELLER_TO_CANCEL",
                  statusQuantity: {
                    unitOfMeasurement: "EACH",
                    amount: String(l.quantity),
                  },
                },
              ],
            },
          })),
        },
      },
    };
    const data = await this.client.request<any>(
      "POST",
      `/orders/${encodeURIComponent(purchaseOrderId)}/cancel`,
      { body }
    );
    return mapOrder(data?.order ?? data);
  }

  async shipOrderLines(
    purchaseOrderId: string,
    lines: WalmartShipLineInput[]
  ): Promise<WalmartOrder> {
    const body = {
      orderShipment: {
        orderLines: {
          orderLine: lines.map((l) => ({
            lineNumber: l.lineNumber,
            orderLineStatuses: {
              orderLineStatus: [
                {
                  status: "Shipped",
                  statusQuantity: {
                    unitOfMeasurement: "EACH",
                    amount: String(l.quantity),
                  },
                  trackingInfo: {
                    shipDateTime: l.shipDateTime.toISOString(),
                    carrierName: { carrier: l.carrierName },
                    methodCode: l.methodCode,
                    trackingNumber: l.trackingNumber,
                    trackingURL: l.trackingUrl,
                  },
                },
              ],
            },
          })),
        },
      },
    };
    const data = await this.client.request<any>(
      "POST",
      `/orders/${encodeURIComponent(purchaseOrderId)}/shipping`,
      { body }
    );
    return mapOrder(data?.order ?? data);
  }

  async refundOrderLines(
    purchaseOrderId: string,
    lines: WalmartRefundLineInput[]
  ): Promise<WalmartOrder> {
    const body = {
      orderRefund: {
        orderLines: {
          orderLine: lines.map((l) => ({
            lineNumber: l.lineNumber,
            refunds: {
              refund: [
                {
                  refundComments: l.reason,
                  refundCharges: {
                    refundCharge: [
                      {
                        refundReason: l.reason,
                        charge: {
                          chargeType: "PRODUCT",
                          chargeAmount: {
                            currency: l.currency ?? "USD",
                            amount: l.amount,
                          },
                          tax:
                            l.tax !== undefined
                              ? {
                                  taxName: "Tax1",
                                  taxAmount: {
                                    currency: l.currency ?? "USD",
                                    amount: l.tax,
                                  },
                                }
                              : undefined,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          })),
        },
      },
    };
    const data = await this.client.request<any>(
      "POST",
      `/orders/${encodeURIComponent(purchaseOrderId)}/refund`,
      { body }
    );
    return mapOrder(data?.order ?? data);
  }
}
