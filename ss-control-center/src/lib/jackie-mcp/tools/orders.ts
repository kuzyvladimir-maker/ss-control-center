/**
 * Jackie MCP tools — Orders.
 *
 * Amazon path uses SP-API /orders/v0/orders; Walmart uses
 * WalmartOrdersApi. Both are read-only here — fulfilment / cancellation
 * mutations live in the shipping module and are out of scope for V1.
 */

import { getOrder, getOrderItems, getOrders } from "@/lib/amazon-sp-api/orders";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { getWalmartClient } from "@/lib/walmart/client";
import {
  amazonChannelToStoreIndex,
  optionalNumber,
  optionalString,
  requireAmazonChannel,
  requireChannel,
  requireString,
} from "../channels";
import type { JackieTool } from "../registry";

const amazonOrdersList: JackieTool = {
  name: "amazon_orders_list",
  description:
    "List recent Amazon orders for one channel. days=7 default; statuses filter optional. Returns up to maxResults (default 100).",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      days: { type: "number", default: 7 },
      statuses: { type: "array", items: { type: "string" } },
      max_results: { type: "number", default: 100 },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const channel = requireAmazonChannel(args);
    const storeIndex = amazonChannelToStoreIndex(channel);
    const days = optionalNumber(args, "days") ?? 7;
    const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const statuses = Array.isArray(args.statuses)
      ? (args.statuses as string[]).filter((s) => typeof s === "string")
      : undefined;
    const maxResults = optionalNumber(args, "max_results") ?? 100;
    const orders = await getOrders({
      storeId: `store${storeIndex}`,
      createdAfter,
      orderStatuses: statuses,
      maxResults,
    });
    return { count: orders.length, orders };
  },
};

const amazonOrderGet: JackieTool = {
  name: "amazon_order_get",
  description: "Get one Amazon order by amazon_order_id, plus its OrderItems.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      amazon_order_id: { type: "string" },
    },
    required: ["channel", "amazon_order_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const channel = requireAmazonChannel(args);
    const orderId = requireString(args, "amazon_order_id");
    const storeIndex = amazonChannelToStoreIndex(channel);
    const storeId = `store${storeIndex}`;
    const [order, items] = await Promise.all([
      getOrder(orderId, storeId),
      getOrderItems(orderId, storeId),
    ]);
    return { order, items };
  },
};

const walmartOrdersList: JackieTool = {
  name: "walmart_orders_list",
  description:
    "List Walmart orders, one page at a time. status filter optional ('Created'|'Acknowledged'|'Shipped'|'Cancelled'|'Refund'|'Delivered'). PAGINATION: the response always carries `next_cursor`; when it is non-null, call this tool again with `cursor` set to that value (and nothing else — Walmart's cursor already encodes days/status/limit) to get the next page. Repeat until next_cursor is null to walk the full history.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Must be WALMART" },
      days: { type: "number", default: 7, description: "Look-back window for the FIRST page. Ignored when `cursor` is supplied." },
      created_start_date: {
        type: "string",
        description:
          "Optional explicit ISO start date (YYYY-MM-DD or full ISO) for the first page. Overrides `days`. Ignored when `cursor` is supplied.",
      },
      created_end_date: {
        type: "string",
        description: "Optional ISO end date for the first page. Ignored when `cursor` is supplied.",
      },
      status: { type: "string" },
      limit: { type: "number", default: 100, description: "Page size, 1..200 (Walmart's own cap). Ignored when `cursor` is supplied." },
      cursor: {
        type: "string",
        description:
          "Opaque `next_cursor` value returned by the previous call. When present every other filter is ignored — Walmart's cursor carries them.",
      },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const channel = requireChannel(args);
    if (channel !== "WALMART") throw new Error("channel must be WALMART");
    const cursor = optionalString(args, "cursor");
    const api = new WalmartOrdersApi(getWalmartClient(1));

    // Walmart's cursor is opaque and already encodes the original filter —
    // sending createdStartDate alongside it is rejected. So a cursor call
    // carries the cursor and nothing else.
    let page;
    if (cursor) {
      page = await api.getAllOrders({ nextCursor: cursor });
    } else {
      const days = optionalNumber(args, "days") ?? 7;
      const createdStartDate =
        optionalString(args, "created_start_date") ??
        new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const createdEndDate = optionalString(args, "created_end_date");
      const status = optionalString(args, "status");
      const limit = optionalNumber(args, "limit") ?? 100;
      page = await api.getAllOrders({
        createdStartDate,
        createdEndDate,
        status,
        limit,
      } as Parameters<WalmartOrdersApi["getAllOrders"]>[0]);
    }

    return {
      count: page.orders.length,
      // `total` is Walmart's meta.totalCount — the size of the whole result
      // set, not of this page. Present on the first page; cursor pages repeat it.
      total: page.totalCount,
      orders: page.orders,
      next_cursor: page.nextCursor ?? null,
    };
  },
};

const walmartOrderGet: JackieTool = {
  name: "walmart_order_get",
  description: "Get one Walmart order by purchase_order_id.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Must be WALMART" },
      purchase_order_id: { type: "string" },
    },
    required: ["channel", "purchase_order_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const channel = requireChannel(args);
    if (channel !== "WALMART") throw new Error("channel must be WALMART");
    const id = requireString(args, "purchase_order_id");
    const api = new WalmartOrdersApi(getWalmartClient(1));
    const order = await api.getOrderById(id);
    return { order };
  },
};

export const tools: JackieTool[] = [
  amazonOrdersList,
  amazonOrderGet,
  walmartOrdersList,
  walmartOrderGet,
];
