/**
 * Jackie MCP tools — Walmart "Ship with Walmart" (Buy Shipping).
 *
 *   walmart_label_rates  (read-only) — rate-shop an order, return carrier/
 *                         service options + price. Free quote, buys nothing.
 *   walmart_buy_label    (WRITE, dry_run) — buy the chosen label. Does NOT
 *                         mark the order Shipped (it stays Acknowledged) —
 *                         the walmart-ship-confirm cron marks it Shipped once
 *                         the package actually moves.
 *
 * Flow: walmart_label_rates → SSCC/Jackie picks a service → walmart_buy_label
 * with that carrier_name + carrier_service_type. See lib/walmart/shipping.ts.
 *
 * Hardcodes storeIndex=1 like the other walmart_* tools.
 */

import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import {
  estimateShippingRates,
  buyShippingLabel,
  type BoxInput,
} from "@/lib/walmart/shipping";
import { optionalNumber, optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

const STORE_INDEX = 1;

function requireNum(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`'${key}' must be a number.`);
  }
  return v;
}

function boxFromArgs(args: Record<string, unknown>): BoxInput {
  return {
    length: requireNum(args, "length"),
    width: requireNum(args, "width"),
    height: requireNum(args, "height"),
    weight: requireNum(args, "weight"),
    dimUnit: (optionalString(args, "dim_unit") as BoxInput["dimUnit"]) ?? "IN",
    weightUnit:
      (optionalString(args, "weight_unit") as BoxInput["weightUnit"]) ?? "LB",
  };
}

const BOX_PROPS = {
  length: { type: "number", description: "Package length." },
  width: { type: "number", description: "Package width." },
  height: { type: "number", description: "Package height." },
  weight: { type: "number", description: "Package weight." },
  dim_unit: {
    type: "string",
    enum: ["IN", "FT", "CM"],
    default: "IN",
    description: "Dimension unit. Default IN.",
  },
  weight_unit: {
    type: "string",
    enum: ["LB", "KG", "OZ"],
    default: "LB",
    description: "Weight unit. Default LB.",
  },
} as const;

const walmartLabelRates: JackieTool = {
  name: "walmart_label_rates",
  description:
    "Rate-shop a Walmart order via Ship with Walmart (POST /v3/shipping/labels/shipping-estimates). Returns the available carrier+service options with prices and delivery dates, cheapest first. Read-only — buys nothing. Pass the package dimensions + weight. The destination address and ship/deliver dates are pulled from the order automatically. Feed a chosen option's carrier_name + service_type into walmart_buy_label.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      purchase_order_id: {
        type: "string",
        description: "Walmart purchaseOrderId to rate-shop.",
      },
      ...BOX_PROPS,
      ship_by_date: {
        type: "string",
        description:
          "Optional ISO date to ship by. Defaults to the order's estimated ship date.",
      },
      deliver_by_date: {
        type: "string",
        description:
          "Optional ISO date to deliver by. Defaults to the order's estimated delivery date.",
      },
    },
    required: ["purchase_order_id", "length", "width", "height", "weight"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const purchaseOrderId = requireString(args, "purchase_order_id");
    const box = boxFromArgs(args);
    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);

    let order;
    try {
      order = await api.getOrderById(purchaseOrderId);
    } catch (err) {
      if (err instanceof WalmartApiError) {
        return {
          ok: false,
          error:
            err.status === 404
              ? `Order "${purchaseOrderId}" not found`
              : `Walmart API ${err.status} fetching order`,
          walmart_status: err.status,
        };
      }
      throw err;
    }

    const addr = order.shippingInfo?.postalAddress;
    if (!addr?.postalCode || !addr?.city || !addr?.state) {
      return { ok: false, error: "Order has no usable shipping address." };
    }

    const now = Date.now();
    const shipBy =
      optionalString(args, "ship_by_date") ??
      order.shippingInfo?.estimatedShipDate ??
      new Date(now + 24 * 3600 * 1000);
    const deliverBy =
      optionalString(args, "deliver_by_date") ??
      order.shippingInfo?.estimatedDeliveryDate ??
      new Date(now + 5 * 24 * 3600 * 1000);

    try {
      const rates = await estimateShippingRates(client, {
        box,
        to: {
          addressLines: [addr.address1, addr.address2].filter(Boolean) as string[],
          city: addr.city,
          state: addr.state,
          postalCode: addr.postalCode,
          countryCode: addr.country === "USA" ? "US" : addr.country ?? "US",
        },
        shipByDate: shipBy,
        deliverByDate: deliverBy,
      });
      rates.sort((a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity));
      return {
        ok: true,
        purchase_order_id: purchaseOrderId,
        rate_count: rates.length,
        rates: rates.map((r) => ({
          carrier_name: r.carrierName,
          service_type: r.serviceType,
          display_name: r.displayName,
          amount: r.amount,
          currency: r.currency,
          delivery_date: r.deliveryDate,
          meets_delivery_promise: r.deliveryPromiseFulfilled,
        })),
        note:
          "Pass a chosen option's carrier_name + service_type to walmart_buy_label. Buying does NOT mark the order Shipped.",
      };
    } catch (err) {
      if (err instanceof WalmartApiError) {
        return {
          ok: false,
          error: `Walmart API ${err.status}`,
          walmart_correlation_id: err.correlationId,
          walmart_response: err.errorBody,
        };
      }
      throw err;
    }
  },
};

const walmartBuyLabel: JackieTool = {
  name: "walmart_buy_label",
  description:
    "Buy a Ship with Walmart shipping label for an order (POST /v3/shipping/labels). Pick carrier_name + service_type from walmart_label_rates. Returns the tracking number. IMPORTANT: this does NOT mark the order Shipped — it stays Acknowledged; the ship-confirm cron marks it Shipped once the package moves. WRITE + costs real money — set dry_run=true to preview the exact request without buying.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      purchase_order_id: { type: "string", description: "Walmart purchaseOrderId." },
      carrier_name: {
        type: "string",
        description: "Carrier from walmart_label_rates, e.g. FedEx | USPS.",
      },
      service_type: {
        type: "string",
        description:
          "Service code from walmart_label_rates (the 'service_type' field, e.g. GROUND_ADVANTAGE).",
      },
      ...BOX_PROPS,
      package_type: {
        type: "string",
        default: "CUSTOM_PACKAGE",
        description: "Walmart packageTypeShortName. Default CUSTOM_PACKAGE.",
      },
      dry_run: {
        type: "boolean",
        default: false,
        description: "When true, return the request body without buying.",
      },
    },
    required: [
      "purchase_order_id",
      "carrier_name",
      "service_type",
      "length",
      "width",
      "height",
      "weight",
    ],
    additionalProperties: false,
  },
  handler: async (args) => {
    const purchaseOrderId = requireString(args, "purchase_order_id");
    const carrierName = requireString(args, "carrier_name");
    const serviceType = requireString(args, "service_type");
    const packageType = optionalString(args, "package_type") ?? "CUSTOM_PACKAGE";
    const box = boxFromArgs(args);
    const dryRun = args.dry_run === true;

    const client = getWalmartClient(STORE_INDEX);
    const api = new WalmartOrdersApi(client);

    let order;
    try {
      order = await api.getOrderById(purchaseOrderId);
    } catch (err) {
      if (err instanceof WalmartApiError) {
        return {
          ok: false,
          error:
            err.status === 404
              ? `Order "${purchaseOrderId}" not found`
              : `Walmart API ${err.status} fetching order`,
          walmart_status: err.status,
        };
      }
      throw err;
    }

    const boxItems = order.orderLines.map((l) => ({
      sku: l.sku,
      quantity: l.orderedQty,
      lineNumber: String(l.lineNumber),
    }));

    if (dryRun) {
      return {
        dry_run: true,
        endpoint: "POST https://marketplace.walmartapis.com/v3/shipping/labels",
        body_preview: {
          purchaseOrderId,
          packageType,
          carrierName,
          carrierServiceType: serviceType,
          boxDimensions: {
            boxLength: box.length,
            boxWidth: box.width,
            boxHeight: box.height,
            boxWeight: box.weight,
            boxDimensionUnit: box.dimUnit,
            boxWeightUnit: box.weightUnit,
          },
          boxItems,
        },
        note: "No label bought. Call again with dry_run=false to purchase. Order will remain Acknowledged.",
      };
    }

    try {
      const result = await buyShippingLabel(client, {
        purchaseOrderId,
        carrierName,
        carrierServiceType: serviceType,
        box,
        boxItems,
        packageType,
      });
      return {
        ok: true,
        purchase_order_id: result.purchaseOrderId,
        tracking_number: result.trackingNumber,
        carrier_name: result.carrierName,
        service_type: result.carrierServiceType,
        note: "Label bought. Order is still Acknowledged — the ship-confirm cron will mark it Shipped once the package is moving.",
      };
    } catch (err) {
      if (err instanceof WalmartApiError) {
        return {
          ok: false,
          purchase_order_id: purchaseOrderId,
          error: `Walmart API ${err.status}`,
          walmart_correlation_id: err.correlationId,
          walmart_response: err.errorBody,
        };
      }
      throw err;
    }
  },
};

export const tools: JackieTool[] = [walmartLabelRates, walmartBuyLabel];
