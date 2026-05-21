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
    "List recent Walmart orders. status filter optional ('Created'|'Acknowledged'|'Shipped'|'Cancelled'|'Refund'|'Delivered').",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Must be WALMART" },
      days: { type: "number", default: 7 },
      status: { type: "string" },
      limit: { type: "number", default: 100 },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const channel = requireChannel(args);
    if (channel !== "WALMART") throw new Error("channel must be WALMART");
    const days = optionalNumber(args, "days") ?? 7;
    const createdStartDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const status = optionalString(args, "status");
    const limit = optionalNumber(args, "limit") ?? 100;
    const api = new WalmartOrdersApi(getWalmartClient(1));
    const page = await api.getAllOrders({
      createdStartDate,
      status,
      limit,
    } as Parameters<WalmartOrdersApi["getAllOrders"]>[0]);
    return { count: page.orders.length, orders: page.orders, next_cursor: page.nextCursor ?? null };
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
