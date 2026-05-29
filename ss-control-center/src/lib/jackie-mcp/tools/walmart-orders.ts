/**
 * Jackie MCP tool — walmart_order_ship.
 *
 * Marks Walmart order lines as Shipped with tracking, via
 * POST /v3/orders/{purchaseOrderId}/shipping. WRITE tool, gated by dry_run.
 *
 * Reuses WalmartOrdersApi.shipOrderLines (which builds Walmart's nested
 * orderShipment payload) and getOrderById (to resolve each line's shipped
 * quantity from the order — Walmart's payload requires statusQuantity, and
 * the caller shouldn't have to know the ordered qty).
 *
 * Like the other walmart_* tools this hardcodes storeIndex=1 (the single
 * Walmart account). When a second account is added, all walmart_* tools
 * should gain a channel/store_index input together.
 */

import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import type { WalmartShipLineInput } from "@/lib/walmart/types";
import { optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

const STORE_INDEX = 1;

// Walmart expects specific carrier casing in carrierName.carrier. Normalise
// the common ones; anything else is passed through as-is so unusual carriers
// (DHL, OnTrac, …) still work.
function normaliseCarrier(input: string): string {
  switch (input.trim().toUpperCase()) {
    case "UPS":
      return "UPS";
    case "USPS":
      return "USPS";
    case "FEDEX":
      return "FedEx";
    case "DHL":
      return "DHL";
    default:
      return input.trim();
  }
}

const walmartOrderShip: JackieTool = {
  name: "walmart_order_ship",
  description:
    "Mark Walmart order lines as Shipped with tracking (POST /v3/orders/{id}/shipping). Each line needs line_number, tracking_number, carrier_name (UPS|USPS|FedEx), and method_code (default Standard). The shipped quantity is taken from the order automatically. Set dry_run=true to preview the request without calling Walmart.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      purchase_order_id: {
        type: "string",
        description: "Walmart purchaseOrderId of the order to ship.",
      },
      lines: {
        type: "array",
        description: "Order lines to mark shipped, each with its own tracking.",
        items: {
          type: "object",
          properties: {
            line_number: { type: "string" },
            tracking_number: { type: "string" },
            carrier_name: {
              type: "string",
              description: "UPS | USPS | FedEx (other carriers passed through).",
            },
            method_code: {
              type: "string",
              default: "Standard",
              description: "Walmart shipping method code. Default 'Standard'.",
            },
          },
          required: ["line_number", "tracking_number", "carrier_name"],
        },
      },
      dry_run: {
        type: "boolean",
        default: false,
        description:
          "When true, return the resolved per-line payload + endpoint without calling Walmart.",
      },
    },
    required: ["purchase_order_id", "lines"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const purchaseOrderId = requireString(args, "purchase_order_id");
    const linesRaw = Array.isArray(args.lines) ? args.lines : [];
    if (linesRaw.length === 0) {
      throw new Error("'lines' must be a non-empty array.");
    }
    const dryRun = args.dry_run === true;

    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);

    // Pull the order so we can (a) validate the line numbers and (b) resolve
    // the shipped quantity for each line — Walmart's payload requires it.
    let order;
    try {
      order = await api.getOrderById(purchaseOrderId);
    } catch (err) {
      if (err instanceof WalmartApiError) {
        return {
          ok: false,
          error:
            err.status === 404
              ? `Order "${purchaseOrderId}" not found in this Walmart account`
              : `Walmart API ${err.status} fetching order`,
          walmart_status: err.status,
          walmart_correlation_id: err.correlationId,
          walmart_response: err.errorBody,
        };
      }
      throw err;
    }

    const qtyByLine = new Map(
      order.orderLines.map((l) => [String(l.lineNumber), l.orderedQty]),
    );

    const shipDateTime = new Date();
    const shipLines: WalmartShipLineInput[] = [];
    for (const raw of linesRaw) {
      const l = raw as Record<string, unknown>;
      const lineNumber = String(l.line_number ?? "").trim();
      const trackingNumber = String(l.tracking_number ?? "").trim();
      const carrierName = normaliseCarrier(String(l.carrier_name ?? ""));
      const methodCode =
        typeof l.method_code === "string" && l.method_code.trim()
          ? l.method_code.trim()
          : "Standard";

      if (!lineNumber || !trackingNumber || !carrierName) {
        throw new Error(
          "Each line needs line_number, tracking_number, and carrier_name.",
        );
      }
      const quantity = qtyByLine.get(lineNumber);
      if (quantity === undefined) {
        return {
          ok: false,
          error: `Line ${lineNumber} is not on order ${purchaseOrderId}. Available lines: ${[...qtyByLine.keys()].join(", ") || "none"}.`,
        };
      }

      shipLines.push({
        lineNumber,
        quantity,
        shipDateTime,
        carrierName,
        methodCode,
        trackingNumber,
      });
    }

    if (dryRun) {
      return {
        dry_run: true,
        endpoint: `POST https://marketplace.walmartapis.com/v3/orders/${purchaseOrderId}/shipping`,
        purchase_order_id: purchaseOrderId,
        lines: shipLines.map((l) => ({
          line_number: l.lineNumber,
          quantity: l.quantity,
          tracking_number: l.trackingNumber,
          carrier_name: l.carrierName,
          method_code: l.methodCode,
          ship_date_time: l.shipDateTime.toISOString(),
        })),
        note: "No changes made. Call again with dry_run=false to ship.",
      };
    }

    try {
      const updated = await api.shipOrderLines(purchaseOrderId, shipLines);
      return {
        ok: true,
        purchase_order_id: purchaseOrderId,
        lines_shipped: shipLines.length,
        order_status: updated.status,
        walmart_response: updated,
      };
    } catch (err) {
      if (err instanceof WalmartApiError) {
        return {
          ok: false,
          purchase_order_id: purchaseOrderId,
          error:
            err.status === 401 || err.status === 403
              ? "Walmart auth failed — check WALMART_CLIENT_ID_STORE1 / WALMART_CLIENT_SECRET_STORE1"
              : `Walmart API ${err.status}`,
          walmart_status: err.status,
          walmart_correlation_id: err.correlationId,
          walmart_response: err.errorBody,
        };
      }
      throw err;
    }
  },
};

export const tools: JackieTool[] = [walmartOrderShip];
