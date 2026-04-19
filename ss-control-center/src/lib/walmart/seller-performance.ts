/**
 * Walmart Seller Performance API.
 *
 * Two flavours of endpoints:
 *   - Summary  → JSON with aggregated metric percentages
 *   - Report   → XLSX file with order-level detail (for root-cause analysis)
 *
 * Exact paths per Walmart docs
 * (https://developer.walmart.com/doc/us/mp/us-mp-seller-performance/). If a
 * path changes, the fix is local to this file.
 */

import type { WalmartClient } from "./client";
import { mapPerformanceSummary } from "./mappers";
import type { WalmartPerformanceSummary } from "./types";

export type PerformanceMetric =
  | "onTimeDelivery"
  | "validTrackingRate"
  | "responseRate"
  | "refundRate"
  | "cancellationRate"
  | "carrierMethodAccuracy"
  | "onTimeShipment"
  | "shipFromLocationAccuracy";

export type PerformanceWindow = 14 | 30 | 60 | 90;

export class WalmartSellerPerformanceApi {
  constructor(private client: WalmartClient) {}

  /** Aggregated performance metrics for the given window. */
  async getSummary(
    windowDays: PerformanceWindow,
    orderTypes?: string[]
  ): Promise<WalmartPerformanceSummary> {
    const params: Record<string, string | number> = {
      windowDays,
    };
    if (orderTypes?.length) params.orderTypes = orderTypes.join(",");

    const data = await this.client.request<unknown>(
      "GET",
      "/sellerPerformance/summary",
      { params }
    );
    return mapPerformanceSummary(data, windowDays);
  }

  /** Download the XLSX drill-down report for a metric. Returns raw Buffer. */
  async getMetricReport(
    metric: PerformanceMetric,
    windowDays: PerformanceWindow,
    orderTypes?: string[]
  ): Promise<Buffer> {
    const params: Record<string, string | number> = {
      metric,
      windowDays,
    };
    if (orderTypes?.length) params.orderTypes = orderTypes.join(",");

    const res = await this.client.request<Response>(
      "GET",
      "/sellerPerformance/report",
      {
        params,
        accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        raw: true,
      }
    );
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /** Simplified Shipping Settings compliance summary. */
  async getSimplifiedShippingSettingsReport(): Promise<WalmartPerformanceSummary> {
    const data = await this.client.request<unknown>(
      "GET",
      "/sellerPerformance/simplifiedShippingSettings"
    );
    // windowDays is not meaningful here; use 30 as a neutral default so the
    // metric snapshot rows stay consistent with the rest of Account Health.
    return mapPerformanceSummary(data, 30);
  }
}
