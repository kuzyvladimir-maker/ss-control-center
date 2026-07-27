/**
 * Jackie MCP tool — walmart_label_tracking.
 *
 * Returns the tracking number(s) of the "Ship with Walmart" (Buy Shipping)
 * label(s) purchased for a Walmart order, via
 * GET /v3/shipping/labels/purchase-orders/{po}.
 *
 * This is the piece that the order resource does NOT give you: tracking is
 * present here as soon as the label is bought (in Seller Center or via API),
 * BEFORE the order is marked shipped. GET /orders/{po} only fills in tracking
 * after the ship write-call, so this is the read path for the
 * "label created → is it actually moving?" ship-confirm workflow:
 *   walmart_label_tracking → carrier_track → walmart_order_ship.
 *
 * Read-only. Hardcodes storeIndex=1 like the other walmart_* tools.
 */

import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { requireString } from "../channels";
import type { JackieTool } from "../registry";

const STORE_INDEX = 1;

const walmartLabelTracking: JackieTool = {
  name: "walmart_label_tracking",
  description:
    "Get the tracking number(s) for the shipping label(s) bought for a Walmart order via Walmart's 'Buy Shipping' / Ship with Walmart (GET /v3/shipping/labels/purchase-orders/{id}). Works while the order is still Acknowledged — unlike walmart_order_get, which only shows tracking after the order is marked shipped. Returns one entry per box. Empty list = no label bought yet (or a non-Walmart carrier). Use this BEFORE carrier_track + walmart_order_ship.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      purchase_order_id: {
        type: "string",
        description: "Walmart purchaseOrderId to look up labels for.",
      },
    },
    required: ["purchase_order_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const purchaseOrderId = requireString(args, "purchase_order_id");
    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);
    try {
      const labels = await api.getLabelsByPurchaseOrder(purchaseOrderId);
      return {
        ok: true,
        purchase_order_id: purchaseOrderId,
        label_count: labels.length,
        labels: labels.map((l) => ({
          tracking_number: l.trackingNumber,
          carrier_name: l.carrierName,
          carrier_service_type: l.carrierServiceType ?? null,
          tracking_url: l.trackingUrl ?? null,
          box_items: l.boxItems,
        })),
        note:
          labels.length === 0
            ? "No Buy Shipping label found for this order yet (none purchased, or shipped with a carrier outside Ship with Walmart)."
            : undefined,
      };
    } catch (err) {
      if (err instanceof WalmartApiError) {
        return {
          ok: false,
          purchase_order_id: purchaseOrderId,
          error:
            err.status === 404
              ? `No labels found for order "${purchaseOrderId}"`
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

export const tools: JackieTool[] = [walmartLabelTracking];
