/**
 * Jackie MCP tools — Walmart Returns.
 * Read + refund. Refund is gated by dry_run flag.
 */

import { WalmartReturnsApi } from "@/lib/walmart/returns";
import { getWalmartClient } from "@/lib/walmart/client";
import { optionalNumber, optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

const walmartReturnsList: JackieTool = {
  name: "walmart_returns_list",
  description:
    "List Walmart return orders. Filters: returnType (PREORDER|REFUND|REPLACEMENT), status (INITIATED|DELIVERED|COMPLETED), date range. Default last 30 days.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      days: { type: "number", default: 30 },
      return_type: { type: "string" },
      status: { type: "string" },
      limit: { type: "number", default: 100 },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const days = optionalNumber(args, "days") ?? 30;
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const api = new WalmartReturnsApi(getWalmartClient(1));
    const page = await api.getAllReturns({
      returnCreationStartDate: start.toISOString().slice(0, 10),
      returnType: optionalString(args, "return_type") as "PREORDER" | "REFUND" | "REPLACEMENT" | undefined,
      status: optionalString(args, "status") as "INITIATED" | "DELIVERED" | "COMPLETED" | undefined,
      limit: optionalNumber(args, "limit") ?? 100,
    });
    return {
      count: page.returns.length,
      returns: page.returns,
      next_cursor: page.nextCursor ?? null,
      total_count: page.totalCount,
    };
  },
};

const walmartReturnRefund: JackieTool = {
  name: "walmart_return_refund",
  description:
    "Issue a refund against one Walmart return. `lines` is an array of { line_number, quantity, reason, amount, currency?, tax? }. Set dry_run=true to preview the request body.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      return_order_id: { type: "string" },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line_number: { type: "string" },
            quantity: { type: "number" },
            reason: { type: "string" },
            amount: { type: "number" },
            currency: { type: "string" },
            tax: { type: "number" },
          },
          required: ["line_number", "quantity", "reason", "amount"],
        },
      },
      dry_run: { type: "boolean", default: false },
    },
    required: ["return_order_id", "lines"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = requireString(args, "return_order_id");
    const linesRaw = Array.isArray(args.lines) ? args.lines : [];
    const lines = linesRaw.map((l) => {
      const ln = l as Record<string, unknown>;
      return {
        lineNumber: String(ln.line_number),
        quantity: Number(ln.quantity),
        reason: String(ln.reason),
        amount: Number(ln.amount),
        currency: typeof ln.currency === "string" ? ln.currency : undefined,
        tax: typeof ln.tax === "number" ? ln.tax : undefined,
      };
    });
    const dry_run = args.dry_run === true;
    if (dry_run) {
      return { dry_run: true, would_refund: { return_order_id: id, lines } };
    }
    const api = new WalmartReturnsApi(getWalmartClient(1));
    const result = await api.issueReturnRefund(id, lines);
    return { ok: true, result };
  },
};

export const tools: JackieTool[] = [walmartReturnsList, walmartReturnRefund];
