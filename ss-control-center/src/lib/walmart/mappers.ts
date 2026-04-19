/**
 * Wire-format ↔ domain converters.
 *
 * Walmart returns snake_case-ish camelCase (e.g. `purchaseOrderId`) but order
 * dates as Unix epoch milliseconds and many fields are deeply nested
 * "list of one" structures (`{ orderLines: { orderLine: [...] } }`).
 * These mappers normalize that into the shapes in types.ts.
 */

import type {
  WalmartCharge,
  WalmartOrder,
  WalmartOrderLine,
  WalmartOrderLineStatus,
  WalmartOrderStatus,
  WalmartPerformanceMetricValue,
  WalmartPerformanceSummary,
  WalmartReconTransaction,
  WalmartRefund,
  WalmartReturn,
  WalmartReturnLine,
  WalmartReturnTrackingDetail,
  WalmartShippingInfo,
  WalmartTrackingInfo,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function epochMsToDate(ms: number | string | null | undefined): Date | undefined {
  if (ms === null || ms === undefined || ms === "") return undefined;
  const n = typeof ms === "string" ? Number(ms) : ms;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n);
}

/** Walmart returns dates either as ISO strings or epoch ms. Handle both. */
export function parseWalmartDate(v: unknown): Date | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "number") return epochMsToDate(v);
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return epochMsToDate(v);
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/** Walmart frequently wraps single items as `{ thing: { item: [...] } }`. Unwrap to []. */
export function unwrapList<T = any>(value: any, key: string): T[] {
  if (!value) return [];
  const inner = value[key];
  if (!inner) return [];
  return Array.isArray(inner) ? inner : [inner];
}

function mapCharge(raw: any): WalmartCharge {
  return {
    chargeType: raw?.chargeType ?? "",
    chargeName: raw?.chargeName,
    chargeAmount: Number(raw?.chargeAmount?.amount ?? 0),
    currency: raw?.chargeAmount?.currency ?? "USD",
    tax: raw?.tax
      ? {
          taxName: raw.tax.taxName,
          taxAmount: Number(raw.tax.taxAmount?.amount ?? 0),
        }
      : undefined,
  };
}

function mapTrackingInfo(raw: any): WalmartTrackingInfo | undefined {
  if (!raw) return undefined;
  return {
    shipDateTime: parseWalmartDate(raw.shipDateTime),
    carrierName: raw.carrierName?.carrier ?? raw.carrierName,
    methodCode: raw.methodCode,
    trackingNumber: raw.trackingNumber,
    trackingUrl: raw.trackingURL,
  };
}

function mapLineStatus(raw: any): WalmartOrderLineStatus {
  return {
    status: raw?.status ?? "",
    statusQuantity: Number(raw?.statusQuantity?.amount ?? 0),
    cancellationReason: raw?.cancellationReason,
    trackingInfo: mapTrackingInfo(raw?.trackingInfo),
  };
}

function mapRefund(raw: any): WalmartRefund {
  const refundCharges = unwrapList<any>(raw?.refundCharges, "refundCharge").map(
    (rc) => ({
      refundReason: rc?.refundReason ?? "",
      charge: mapCharge(rc?.charge),
    })
  );
  return {
    refundId: raw?.refundId,
    refundComments: raw?.refundComments,
    refundCharges,
  };
}

function mapOrderLine(raw: any): WalmartOrderLine {
  const charges = unwrapList<any>(raw?.charges, "charge").map(mapCharge);
  const refunds = unwrapList<any>(raw?.refund, "refunds").map(mapRefund);
  const statuses = unwrapList<any>(
    raw?.orderLineStatuses,
    "orderLineStatus"
  ).map(mapLineStatus);
  return {
    lineNumber: String(raw?.lineNumber ?? ""),
    sku: raw?.item?.sku,
    productName: raw?.item?.productName,
    itemCondition: raw?.item?.condition,
    orderedQty: Number(raw?.orderLineQuantity?.amount ?? 0),
    charges,
    refunds: refunds.length ? refunds : undefined,
    statuses,
    fulfillmentOption: raw?.fulfillment?.fulfillmentOption,
    shippingProgramType: raw?.fulfillment?.shipMethod,
  };
}

function mapShippingInfo(raw: any): WalmartShippingInfo | undefined {
  if (!raw) return undefined;
  return {
    phone: raw.phone,
    estimatedDeliveryDate: parseWalmartDate(raw.estimatedDeliveryDate),
    estimatedShipDate: parseWalmartDate(raw.estimatedShipDate),
    methodCode: raw.methodCode,
    postalAddress: {
      name: raw.postalAddress?.name,
      address1: raw.postalAddress?.address1,
      address2: raw.postalAddress?.address2,
      city: raw.postalAddress?.city,
      state: raw.postalAddress?.state,
      postalCode: raw.postalAddress?.postalCode,
      country: raw.postalAddress?.country,
      addressType: raw.postalAddress?.addressType,
    },
  };
}

const STATUS_PRIORITY: Record<string, number> = {
  Created: 1,
  Acknowledged: 2,
  Shipped: 3,
  Delivered: 4,
  Cancelled: 5,
};

/** Roll up a single top-level status from line item statuses. */
function rollupOrderStatus(lines: WalmartOrderLine[]): WalmartOrderStatus {
  let best = "Created";
  let bestRank = 0;
  for (const line of lines) {
    for (const s of line.statuses) {
      const rank = STATUS_PRIORITY[s.status] ?? 0;
      if (rank > bestRank) {
        bestRank = rank;
        best = s.status;
      }
    }
  }
  return best as WalmartOrderStatus;
}

export function mapOrder(raw: any): WalmartOrder {
  const orderLines = unwrapList<any>(raw?.orderLines, "orderLine").map(
    mapOrderLine
  );

  let orderTotal = 0;
  let currency: string | undefined;
  for (const line of orderLines) {
    for (const c of line.charges) {
      orderTotal += c.chargeAmount;
      if (!currency) currency = c.currency;
    }
  }

  return {
    purchaseOrderId: String(raw?.purchaseOrderId ?? ""),
    customerOrderId: String(raw?.customerOrderId ?? ""),
    customerEmailId: raw?.customerEmailId,
    orderType: raw?.orderType,
    shipNodeType: raw?.shipNode?.type,
    originalCustomerOrderID: raw?.originalCustomerOrderID,
    orderDate: parseWalmartDate(raw?.orderDate) ?? new Date(0),
    shippingInfo: mapShippingInfo(raw?.shippingInfo),
    orderLines,
    status: rollupOrderStatus(orderLines),
    orderTotal: Number(orderTotal.toFixed(2)),
    currency,
    raw,
  };
}

function mapReturnTrackingDetail(raw: any): WalmartReturnTrackingDetail | undefined {
  if (!raw) return undefined;
  return {
    carrierName: raw.carrierName,
    methodCode: raw.methodCode,
    trackingNumber: raw.trackingNumber,
    trackingUrl: raw.trackingURL,
  };
}

function mapReturnLine(raw: any): WalmartReturnLine {
  const refundCharges = unwrapList<any>(
    raw?.refund?.refundCharges,
    "refundCharge"
  ).map((rc) => mapCharge(rc?.charge));
  return {
    lineNumber: String(raw?.lineNumber ?? ""),
    itemId: raw?.item?.itemId,
    productName: raw?.item?.productName,
    sku: raw?.item?.sku,
    returnReason: raw?.returnReason,
    returnReasonCode: raw?.returnReasonCode,
    customerReturnReason: raw?.customerReturnReason,
    returnQuantity: Number(raw?.returnQuantity?.amount ?? 0) || undefined,
    returnType: raw?.returnType,
    refund: raw?.refund
      ? {
          refundComments: raw.refund.refundComments,
          refundCharges,
        }
      : undefined,
    returnTrackingDetail: mapReturnTrackingDetail(raw?.returnTrackingDetail),
    status: raw?.status,
    eventTag: raw?.eventTag,
  };
}

export function mapReturn(raw: any): WalmartReturn {
  const returnLines = unwrapList<any>(raw?.returnLines, "returnLine").map(
    mapReturnLine
  );
  // Pick the most "advanced" line status for the return
  const priority: Record<string, number> = {
    INITIATED: 1,
    DELIVERED: 2,
    COMPLETED: 3,
  };
  let best = returnLines[0]?.status ?? "INITIATED";
  let bestRank = priority[best] ?? 0;
  for (const line of returnLines) {
    const r = priority[line.status ?? ""] ?? 0;
    if (r > bestRank) {
      bestRank = r;
      best = line.status!;
    }
  }
  return {
    returnOrderId: String(raw?.returnOrderId ?? ""),
    customerOrderId: String(raw?.customerOrderId ?? ""),
    purchaseOrderId: raw?.purchaseOrderId,
    customerEmail: raw?.customerEmail,
    returnDate: parseWalmartDate(raw?.returnDate) ?? new Date(0),
    returnLines,
    status: best,
    raw,
  };
}

export function mapReconTx(raw: any): WalmartReconTransaction {
  const ts =
    parseWalmartDate(raw?.transaction_posted_timestamp) ??
    parseWalmartDate(raw?.transactionPostedTimestamp) ??
    new Date(0);
  return {
    transactionPostedTimestamp: ts,
    transactionType:
      raw?.transaction_type ?? raw?.transactionType ?? "Unknown",
    transactionDescription:
      raw?.transaction_description ?? raw?.transactionDescription,
    purchaseOrderId: raw?.purchase_order_id ?? raw?.purchaseOrderId,
    customerOrderId: raw?.customer_order_id ?? raw?.customerOrderId,
    sku: raw?.item_sku ?? raw?.sku,
    productName: raw?.product_name ?? raw?.productName,
    quantity:
      raw?.quantity !== undefined ? Number(raw.quantity) : undefined,
    amount: Number(raw?.amount ?? raw?.transaction_amount ?? 0),
    feeType: raw?.fee_type ?? raw?.feeType,
    raw,
  };
}

const PERFORMANCE_THRESHOLDS: Record<string, { healthyAtOrAbove?: number; healthyAtOrBelow?: number }> = {
  onTimeDelivery: { healthyAtOrAbove: 95 },
  validTrackingRate: { healthyAtOrAbove: 99 },
  responseRate: { healthyAtOrAbove: 95 },
  cancellationRate: { healthyAtOrBelow: 2 },
  refundRate: {}, // monitored, no hard threshold
  carrierMethodAccuracy: { healthyAtOrAbove: 95 },
  onTimeShipment: { healthyAtOrAbove: 99 },
  shipFromLocationAccuracy: { healthyAtOrAbove: 99 },
};

function isHealthy(metric: string, value: number): boolean {
  const t = PERFORMANCE_THRESHOLDS[metric];
  if (!t) return true;
  if (t.healthyAtOrAbove !== undefined) return value >= t.healthyAtOrAbove;
  if (t.healthyAtOrBelow !== undefined) return value <= t.healthyAtOrBelow;
  return true;
}

/**
 * Map a Walmart Performance summary payload to our flat metric list.
 * The exact response shape varies — we tolerate several common layouts:
 *   { metrics: [{ name, value, target }] }
 *   { onTimeDelivery: { value, target }, ... }
 */
export function mapPerformanceSummary(
  raw: any,
  windowDays: number
): WalmartPerformanceSummary {
  const metrics: WalmartPerformanceMetricValue[] = [];

  const pushMetric = (name: string, value: number, threshold?: number, sub?: any) => {
    metrics.push({
      metric: name,
      value,
      threshold,
      isHealthy: isHealthy(name, value),
      windowDays,
      raw: sub,
    });
  };

  if (Array.isArray(raw?.metrics)) {
    for (const m of raw.metrics) {
      const name = String(m.name ?? m.metric ?? "");
      if (!name) continue;
      pushMetric(
        name,
        Number(m.value ?? m.actual ?? 0),
        m.target ?? m.threshold,
        m
      );
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === "object" && "value" in (v as any)) {
        const obj = v as any;
        pushMetric(k, Number(obj.value ?? 0), obj.target ?? obj.threshold, obj);
      }
    }
  }

  return {
    windowDays,
    metrics,
    capturedAt: new Date(),
    raw,
  };
}
