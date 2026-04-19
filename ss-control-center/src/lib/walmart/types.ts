/**
 * Typed shapes for Walmart Marketplace API responses we actually consume.
 * Field names are camelCase in our domain — the wire format is snake_case
 * and gets converted in mappers.ts.
 */

export type WalmartOrderStatus =
  | "Created"
  | "Acknowledged"
  | "Shipped"
  | "Delivered"
  | "Cancelled";

export type WalmartShipNodeType =
  | "SellerFulfilled"
  | "WFSFulfilled"
  | "3PLFulfilled";

export interface WalmartCharge {
  chargeType: string;          // PRODUCT | SHIPPING | TAX | ...
  chargeName?: string;
  chargeAmount: number;
  currency: string;
  tax?: { taxName?: string; taxAmount: number };
}

export interface WalmartTrackingInfo {
  shipDateTime?: Date;
  carrierName?: string;
  methodCode?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

export interface WalmartOrderLineStatus {
  status: WalmartOrderStatus | string;
  statusQuantity: number;
  cancellationReason?: string;
  trackingInfo?: WalmartTrackingInfo;
}

export interface WalmartOrderLine {
  lineNumber: string;
  sku?: string;
  productName?: string;
  itemCondition?: string;
  orderedQty: number;
  charges: WalmartCharge[];
  refunds?: WalmartRefund[];
  statuses: WalmartOrderLineStatus[];
  fulfillmentOption?: string;        // S2H | C&C | etc.
  shippingProgramType?: string;
}

export interface WalmartShippingInfo {
  phone?: string;
  estimatedDeliveryDate?: Date;
  estimatedShipDate?: Date;
  methodCode?: string;
  postalAddress: {
    name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    addressType?: string;
  };
}

export interface WalmartRefund {
  refundId?: string;
  refundComments?: string;
  refundCharges: Array<{
    refundReason: string;
    charge: WalmartCharge;
  }>;
}

export interface WalmartOrder {
  purchaseOrderId: string;
  customerOrderId: string;
  customerEmailId?: string;
  orderType?: string;
  shipNodeType?: WalmartShipNodeType | string;
  originalCustomerOrderID?: string;
  orderDate: Date;
  shippingInfo?: WalmartShippingInfo;
  orderLines: WalmartOrderLine[];
  /** Computed top-level status: most-advanced status across line items. */
  status: WalmartOrderStatus;
  /** Sum of charges across all order lines (excluding refunds). */
  orderTotal: number;
  currency?: string;
  /** Original raw payload for debugging / audit. */
  raw: unknown;
}

export interface WalmartReturnTrackingDetail {
  carrierName?: { code?: string; name?: string };
  methodCode?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

export interface WalmartReturnLine {
  lineNumber: string;
  itemId?: string;
  productName?: string;
  sku?: string;
  returnReason?: string;
  returnReasonCode?: string;
  customerReturnReason?: string;
  returnQuantity?: number;
  returnType?: string;          // RETURN | REFUND | REPLACEMENT
  refund?: { refundComments?: string; refundCharges: WalmartCharge[] };
  returnTrackingDetail?: WalmartReturnTrackingDetail;
  status?: string;              // INITIATED | DELIVERED | COMPLETED | ...
  eventTag?: string;            // detailed lifecycle marker
}

export interface WalmartReturn {
  returnOrderId: string;
  customerOrderId: string;
  purchaseOrderId?: string;
  customerEmail?: string;
  returnDate: Date;
  returnLines: WalmartReturnLine[];
  /** Roll-up status from return lines. */
  status: string;
  raw: unknown;
}

export interface WalmartReconReportMeta {
  fileSize: number;
  totalRows: number;
  totalPages: number;
  rowsOnThisPage: number;
  pageNo: number;
}

export interface WalmartReconTransaction {
  transactionPostedTimestamp: Date;
  transactionType: string;       // Sales | Refunds | Adjustments | Fees
  transactionDescription?: string;
  purchaseOrderId?: string;
  customerOrderId?: string;
  sku?: string;
  productName?: string;
  quantity?: number;
  amount: number;
  feeType?: string;
  /** Original report row for audit. */
  raw: unknown;
}

export interface WalmartPerformanceMetricValue {
  metric: string;                // canonical name (camelCase)
  value: number;                 // percent or ratio
  threshold?: number;            // Walmart's threshold for healthy
  isHealthy: boolean;
  windowDays: number;
  /** Original metric block, for audit. */
  raw?: unknown;
}

export interface WalmartPerformanceSummary {
  windowDays: number;
  metrics: WalmartPerformanceMetricValue[];
  capturedAt: Date;
  raw: unknown;
}

// Cancel / Ship / Refund body helpers — used by Orders API wrapper

export interface WalmartCancelLineInput {
  lineNumber: string;
  quantity: number;
  reason?: string;             // default: CUSTOMER_REQUESTED_SELLER_TO_CANCEL
}

export interface WalmartShipLineInput {
  lineNumber: string;
  quantity: number;
  shipDateTime: Date;
  carrierName: string;
  methodCode: string;
  trackingNumber: string;
  trackingUrl?: string;
}

export interface WalmartRefundLineInput {
  lineNumber: string;
  reason: string;
  amount: number;
  currency?: string;
  tax?: number;
  shipping?: number;
}
