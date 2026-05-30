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
import type {
  WalmartCancelLineInput,
  WalmartShipLineInput,
} from "@/lib/walmart/types";
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

/**
 * Walmart cancellation reason codes Walmart's API accepts. We expose
 * friendly aliases on the input (CUSTOMER_CHANGED_MIND, OUT_OF_STOCK,
 * SELLER_CANCELLED) and map them to the wire format below. Source of
 * truth: Walmart Marketplace API "OrderCancellationReason" enum.
 */
const REASON_MAP: Record<string, string> = {
  // friendly → Walmart wire format
  CUSTOMER_CHANGED_MIND: "CUSTOMER_REQUESTED_SELLER_TO_CANCEL",
  CUSTOMER_REQUESTED_SELLER_TO_CANCEL: "CUSTOMER_REQUESTED_SELLER_TO_CANCEL",
  OUT_OF_STOCK: "MERCHANDISE_NOT_IN_STOCK",
  MERCHANDISE_NOT_IN_STOCK: "MERCHANDISE_NOT_IN_STOCK",
  SELLER_CANCELLED: "CANNOT_SHIP_ORDER",
  CANNOT_SHIP_ORDER: "CANNOT_SHIP_ORDER",
  SHIPPING_ADDRESS_UNDELIVERABLE: "SHIPPING_ADDRESS_UNDELIVERABLE",
};

const walmartOrderCancel: JackieTool = {
  name: "walmart_order_cancel",
  description:
    "Cancel one or more lines of a Walmart order (POST /v3/orders/{id}/cancel). Use this when the buyer requested a cancellation (red exclamation icon in Seller Center) and you want to honour it. If `lines` is omitted, ALL lines on the order are cancelled with their full ordered quantity. `reason` accepts CUSTOMER_CHANGED_MIND (default — for buyer-requested cancellations), OUT_OF_STOCK, or SELLER_CANCELLED. Set dry_run=true to preview the request without calling Walmart.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      purchase_order_id: {
        type: "string",
        description: "Walmart purchaseOrderId of the order to cancel.",
      },
      lines: {
        type: "array",
        description:
          "Optional. Specific lines to cancel. Each item: { line_number, quantity }. Omit to cancel every line on the order with its full ordered quantity.",
        items: {
          type: "object",
          properties: {
            line_number: { type: "string" },
            quantity: { type: "number" },
          },
          required: ["line_number", "quantity"],
        },
      },
      reason: {
        type: "string",
        default: "CUSTOMER_CHANGED_MIND",
        description:
          "Why the order is being cancelled. CUSTOMER_CHANGED_MIND (= buyer-requested) | OUT_OF_STOCK | SELLER_CANCELLED. Default CUSTOMER_CHANGED_MIND.",
      },
      dry_run: {
        type: "boolean",
        default: false,
        description:
          "When true, return the resolved per-line payload + endpoint without calling Walmart.",
      },
    },
    required: ["purchase_order_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const purchaseOrderId = requireString(args, "purchase_order_id");
    const reasonInput =
      optionalString(args, "reason") ?? "CUSTOMER_CHANGED_MIND";
    const reason = REASON_MAP[reasonInput.toUpperCase()];
    if (!reason) {
      throw new Error(
        `'reason' must be one of: ${Object.keys(REASON_MAP).join(", ")}. Got: ${reasonInput}`,
      );
    }
    const dryRun = args.dry_run === true;
    const linesRaw = Array.isArray(args.lines) ? args.lines : null;

    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);

    // Pull the order so we can (a) validate the line numbers and (b)
    // default `lines` to "cancel everything" when the caller omits it.
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

    // Resolve which lines to cancel
    const cancelLines: WalmartCancelLineInput[] = [];
    if (linesRaw === null) {
      // Default: cancel every line, full quantity
      for (const [lineNumber, quantity] of qtyByLine) {
        cancelLines.push({ lineNumber, quantity, reason });
      }
    } else {
      if (linesRaw.length === 0) {
        throw new Error(
          "'lines' was provided but empty — omit it entirely to cancel every line, or include at least one entry.",
        );
      }
      for (const raw of linesRaw) {
        const l = raw as Record<string, unknown>;
        const lineNumber = String(l.line_number ?? "").trim();
        const quantity = Number(l.quantity);
        if (!lineNumber || !Number.isFinite(quantity) || quantity <= 0) {
          throw new Error(
            "Each line needs line_number (string) and quantity (positive number).",
          );
        }
        const ordered = qtyByLine.get(lineNumber);
        if (ordered === undefined) {
          return {
            ok: false,
            error: `Line ${lineNumber} is not on order ${purchaseOrderId}. Available lines: ${[...qtyByLine.keys()].join(", ") || "none"}.`,
          };
        }
        if (quantity > ordered) {
          return {
            ok: false,
            error: `Line ${lineNumber}: requested quantity ${quantity} exceeds ordered ${ordered}.`,
          };
        }
        cancelLines.push({ lineNumber, quantity, reason });
      }
    }

    if (dryRun) {
      return {
        dry_run: true,
        endpoint: `POST https://marketplace.walmartapis.com/v3/orders/${purchaseOrderId}/cancel`,
        purchase_order_id: purchaseOrderId,
        reason_alias: reasonInput,
        reason_walmart: reason,
        cancelled_lines: cancelLines.map((l) => ({
          line_number: l.lineNumber,
          quantity: l.quantity,
        })),
        note: "No changes made. Call again with dry_run=false to cancel.",
      };
    }

    try {
      const updated = await api.cancelOrderLines(purchaseOrderId, cancelLines);
      return {
        ok: true,
        purchase_order_id: purchaseOrderId,
        reason_walmart: reason,
        cancelled_lines: cancelLines.map((l) => ({
          line_number: l.lineNumber,
          quantity: l.quantity,
        })),
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
              : err.status === 400
                ? "Walmart rejected the cancellation — likely the order is already shipped/cancelled or the lines are invalid"
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

export const tools: JackieTool[] = [walmartOrderShip, walmartOrderCancel];
