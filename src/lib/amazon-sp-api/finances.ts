/**
 * Amazon Finances API.
 *
 * Role required: Finance and Accounting (Seller Central → Develop apps → Edit App → Data access).
 *
 * Used by: Adjustments Monitor, A-to-Z Claims tracking.
 *
 * ── Why parseAdjustments looks the way it does ───────────────────────────
 * The original parser filtered on AdjustmentType values that don't exist in
 * the real /finances/v0 response (ShippingChargeback / CarrierAdjustment /
 * WeightAdjustment). The actual API returns ~150 events/week per active
 * store with names like PostageBilling_PostageAdjustment. The 2026-05-22
 * audit (docs/ADJUSTMENTS_DIAGNOSIS_REPORT_2026-05-22.md §5.2) catalogued
 * every observed type. The mapping below is the result.
 *
 * Note on order/SKU linkage: PostageBilling_* events carry NO orderId /
 * SellerSKU — Amazon doesn't expose per-shipment attribution on this
 * endpoint. The Settlement Report (Phase B) is the source of truth for
 * SKU-level analytics. Phase A just gets the dollar totals flowing.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { spApiGet } from "./client";

export interface ParsedAdjustment {
  /** Our display category — what the UI / SKU profile aggregates on. */
  type:
    | "WeightAdjustment"        // PostageBilling_PostageAdjustment (carrier reweigh recharge)
    | "WeightAdjustmentRefund"  // PostageRefund_PostageAdjustment (Amazon refunded an over-charge)
    | "ReturnShipping"          // ReturnPostageBilling_* (carrier-billed return label)
    | "Other";
  /** Original Amazon string, kept verbatim for traceability. */
  rawType: string;
  /** ISO timestamp from AdjustmentEvent.PostedDate. */
  postedDate: string;
  /** USD amount. Negative = charged to us, positive = refunded. */
  amount: number;
  /** ISO 4217 — Amazon always returns USD in the US marketplace. */
  currency: string;
  /** Optional — Amazon's per-event AdjustmentId when present. */
  adjustmentId?: string;
  /** Optional — only present for legacy ShippingChargeback-style events that carry AdjustmentItemList. */
  orderId?: string;
  /** Optional — same caveat as orderId. */
  sku?: string;
  /** Optional — short reason string when Amazon supplies one. */
  reason?: string;
}

/**
 * Maps Amazon's raw AdjustmentType strings to our display categories.
 * Anything not in this map is dropped (e.g. PostageBilling_Postage is the
 * routine label charge — not an adjustment in the Vladimir sense).
 */
const ADJUSTMENT_TYPE_MAP: Record<string, ParsedAdjustment["type"]> = {
  PostageBilling_PostageAdjustment: "WeightAdjustment",
  PostageRefund_PostageAdjustment: "WeightAdjustmentRefund",
  // Return-label charges from the carrier. Distinct from the buyer's refund
  // — these are what UPS/USPS bill us back for processing the return.
  ReturnPostageBilling_Postage: "ReturnShipping",
  ReturnPostageBilling_FuelSurcharge: "ReturnShipping",
  ReturnPostageBilling_OversizeSurcharge: "ReturnShipping",
  ReturnPostageBilling_DeliveryAreaSurcharge: "ReturnShipping",
  ReturnPostageBilling_Insurance: "ReturnShipping",
  ReturnPostageBilling_Tracking: "ReturnShipping",
  ReturnPostageBilling_SignatureConfirmation: "ReturnShipping",
  ReturnPostageBilling_TransactionFee: "ReturnShipping",
  // Pre-2024 spec names. Kept for safety in case Amazon ever sends them.
  ShippingChargeback: "WeightAdjustment",
  CarrierAdjustment: "WeightAdjustment",
  WeightAdjustment: "WeightAdjustment",
};

/** Get financial events (adjustments, charges, refunds). */
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

/** Get financial events for a specific order. */
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
 * Parse adjustment events from getFinancialEvents() output.
 *
 * Walks every AdjustmentEventList page, classifies each event via
 * ADJUSTMENT_TYPE_MAP, expands the (rare) AdjustmentItemList entries into
 * per-order rows. Drops anything not in the map — including the routine
 * PostageBilling_Postage and PostageBilling_Insurance line-items.
 */
export function parseAdjustments(financialEvents: any[]): ParsedAdjustment[] {
  const out: ParsedAdjustment[] = [];

  for (const events of financialEvents) {
    const adjEvents: any[] = events?.AdjustmentEventList || [];
    for (const adj of adjEvents) {
      const rawType = String(adj?.AdjustmentType ?? "");
      const mapped = ADJUSTMENT_TYPE_MAP[rawType];
      if (!mapped) continue;

      const postedDate = String(adj?.PostedDate ?? "");
      const currency = String(
        adj?.AdjustmentAmount?.CurrencyCode ??
          adj?.AdjustmentItemList?.[0]?.TotalAmount?.CurrencyCode ??
          "USD"
      );
      const adjustmentId = adj?.AdjustmentId
        ? String(adj.AdjustmentId)
        : undefined;

      const items: any[] = adj?.AdjustmentItemList || [];
      if (items.length === 0) {
        // The common case for PostageBilling_*: one event, one amount, no
        // per-item breakdown. Emit a single row keyed by date+type+amount.
        const amount = parseFloat(
          adj?.AdjustmentAmount?.CurrencyAmount ?? "0"
        );
        out.push({
          type: mapped,
          rawType,
          postedDate,
          amount,
          currency,
          adjustmentId,
          reason: rawType,
        });
      } else {
        // Legacy / chargeback-style event: expand each line.
        for (const item of items) {
          const amount = parseFloat(item?.TotalAmount?.CurrencyAmount ?? "0");
          out.push({
            type: mapped,
            rawType,
            postedDate,
            amount,
            currency,
            adjustmentId,
            orderId: item?.OrderId ? String(item.OrderId) : undefined,
            sku: item?.SellerSKU ? String(item.SellerSKU) : undefined,
            reason: item?.Title || rawType,
          });
        }
      }
    }
  }

  return out;
}

/**
 * Build the stable externalId used for dedup across re-runs of the scanner.
 * The same formula is reused by the Settlement Reports parser in
 * settlement-reports.ts so settlement-sourced rows match Phase A rows and
 * end up enriching them (order-id, SKU, etc.) via upsert instead of
 * creating duplicates.
 *
 * Formula: `amazon:<storeId>:<rawType>:<isoPostedDate>:<amountCents>`
 *
 * - amount-in-cents disambiguates two events posted in the same second
 *   (Amazon batches separate shipments into one settlement window).
 * - rawType keeps WeightAdjustment vs WeightAdjustmentRefund vs
 *   ReturnShipping separate even when amounts/timestamps collide.
 *
 * AdjustmentId is deliberately NOT included even when present — Settlement
 * Reports don't expose it, and we need the IDs to match across both sources.
 */
export function buildAdjustmentExternalId(
  adj: { rawType: string; postedDate: string; amount: number },
  storeId: string
): string {
  const amountCents = Math.round(adj.amount * 100);
  return `amazon:${storeId}:${adj.rawType}:${adj.postedDate}:${amountCents}`;
}
