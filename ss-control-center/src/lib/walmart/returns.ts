/**
 * Walmart Returns API wrapper.
 * Endpoints: /v3/returns, /v3/returns/{id}/refund
 *
 * Returns carry an `eventTag` on each line with the detailed lifecycle state
 * (e.g. INITIATED / PICKED_UP / DELIVERED / REFUND_ISSUED) — prefer that
 * over the coarse `status` field when deciding on Customer Hub actions.
 */

import type { WalmartClient } from "./client";
import { mapReturn, unwrapList } from "./mappers";
import type { WalmartReturn } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ReturnsListParams {
  returnCreationStartDate?: string;
  returnCreationEndDate?: string;
  returnType?: "RETURN" | "REFUND" | "REPLACEMENT";
  status?: "INITIATED" | "DELIVERED" | "COMPLETED";
  returnOrderId?: string;
  customerOrderId?: string;
  limit?: number;
  nextCursor?: string;
  isWFSEnabled?: boolean;
  replacementInfo?: boolean;
}

export interface ReturnsPage {
  returns: WalmartReturn[];
  nextCursor?: string;
  totalCount: number;
}

function buildQuery(params: ReturnsListParams): Record<string, string | number> {
  if (params.nextCursor) return { nextCursor: params.nextCursor };
  const q: Record<string, string | number> = {};
  if (params.returnCreationStartDate)
    q.returnCreationStartDate = params.returnCreationStartDate;
  if (params.returnCreationEndDate)
    q.returnCreationEndDate = params.returnCreationEndDate;
  if (params.returnType) q.returnType = params.returnType;
  if (params.status) q.status = params.status;
  if (params.returnOrderId) q.returnOrderId = params.returnOrderId;
  if (params.customerOrderId) q.customerOrderId = params.customerOrderId;
  if (params.limit) q.limit = params.limit;
  if (params.isWFSEnabled) q.isWFSEnabled = "Y";
  if (params.replacementInfo) q.replacementInfo = "true";
  return q;
}

function parsePage(payload: any): ReturnsPage {
  const raw = unwrapList<any>(payload?.returnOrders, "returnOrder");
  const returns = raw.map(mapReturn);
  return {
    returns,
    nextCursor: payload?.meta?.nextCursor || undefined,
    totalCount: Number(payload?.meta?.totalCount ?? returns.length),
  };
}

export class WalmartReturnsApi {
  constructor(private client: WalmartClient) {}

  async getAllReturns(params: ReturnsListParams = {}): Promise<ReturnsPage> {
    const data = await this.client.request<any>("GET", "/returns", {
      params: buildQuery(params),
    });
    return parsePage(data);
  }

  async *paginate(params: ReturnsListParams = {}): AsyncGenerator<WalmartReturn> {
    let cursor: string | undefined;
    let first = true;
    do {
      const page = await this.getAllReturns(
        first ? params : { nextCursor: cursor }
      );
      first = false;
      for (const r of page.returns) yield r;
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * Issue a refund against a return order. `lines` describes which return
   * lines to refund (by line number) and how much.
   */
  async issueReturnRefund(
    returnOrderId: string,
    lines: Array<{
      lineNumber: string;
      quantity: number;
      reason: string;
      amount: number;
      currency?: string;
      tax?: number;
    }>
  ): Promise<WalmartReturn> {
    const body = {
      orderRefund: {
        refundInfo: lines.map((l) => ({
          lineNumber: l.lineNumber,
          refundQuantity: {
            unitOfMeasurement: "EACH",
            amount: String(l.quantity),
          },
          refundAmount: {
            currency: l.currency ?? "USD",
            amount: l.amount,
          },
          refundTax:
            l.tax !== undefined
              ? { currency: l.currency ?? "USD", amount: l.tax }
              : undefined,
          refundReason: l.reason,
        })),
      },
    };
    const data = await this.client.request<any>(
      "POST",
      `/returns/${encodeURIComponent(returnOrderId)}/refund`,
      { body }
    );
    return mapReturn(data?.returnOrder ?? data);
  }
}
