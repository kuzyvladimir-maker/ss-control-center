/**
 * Jackie MCP tool — Walmart inventory update.
 *
 * Sets the available quantity for one Walmart SKU. Mark Out of Stock by
 * passing quantity=0. WRITE tool — gated by dry_run preview.
 *
 * Walmart endpoint:
 *   PUT /v3/inventory?sku={sku}[&shipNode={node}]
 *
 * The shared WalmartClient adds the required header set
 * (WM_SEC.ACCESS_TOKEN / WM_QOS.CORRELATION_ID / WM_SVC.NAME / Auth) and
 * handles 401 token refresh + 429/5xx retries; we just hand it the body.
 *
 * Note on `channel` arg: the existing walmart_* tools hardcode
 * storeIndex=1 (Vladimir only has one Walmart account). This tool
 * follows the same pattern — no channel/store_index input. When a
 * second Walmart account is added, all four walmart_* tools should be
 * updated together.
 */

import {
  getWalmartClient,
  WalmartApiError,
} from "@/lib/walmart/client";
import { optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

const STORE_INDEX = 1;

const walmartInventoryUpdate: JackieTool = {
  name: "walmart_inventory_update",
  description:
    "Update inventory quantity for one Walmart SKU. Set amount=0 to mark Out of Stock. Set dry_run=true to preview the request body without calling Walmart.",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      sku: {
        type: "string",
        description:
          "Seller SKU exactly as listed in Walmart Seller Center.",
      },
      quantity: {
        type: "number",
        description: "New on-hand amount. 0 marks the SKU Out of Stock.",
      },
      ship_node: {
        type: "string",
        description:
          "Optional fulfillment node id. Omit to update the default ship node.",
      },
      dry_run: {
        type: "boolean",
        default: false,
        description:
          "When true, return the would-be payload + endpoint without calling Walmart.",
      },
    },
    required: ["sku", "quantity"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const sku = requireString(args, "sku");
    const quantityRaw = args.quantity;
    if (typeof quantityRaw !== "number" || !Number.isFinite(quantityRaw)) {
      throw new Error("'quantity' must be a finite number (0 = Out of Stock).");
    }
    if (quantityRaw < 0) {
      throw new Error("'quantity' must be ≥ 0.");
    }
    const quantity = Math.floor(quantityRaw);
    const shipNode = optionalString(args, "ship_node");
    const dryRun = args.dry_run === true;

    const body = {
      sku,
      quantity: { unit: "EACH", amount: quantity },
    };

    // The shared client auto-prepends /v3 and serialises params; build
    // the human-readable URL here just for the dry-run preview so the
    // operator sees exactly what would be called.
    const params: Record<string, string> = { sku };
    if (shipNode) params.shipNode = shipNode;
    const endpointPreview =
      `PUT https://marketplace.walmartapis.com/v3/inventory?` +
      new URLSearchParams(params).toString();

    if (dryRun) {
      return {
        dry_run: true,
        endpoint: endpointPreview,
        body,
        note: "No changes made. Call again with dry_run=false to apply.",
      };
    }

    const client = getWalmartClient(STORE_INDEX);
    let walmartResponse: unknown;
    try {
      walmartResponse = await client.request("PUT", "/inventory", {
        params,
        body,
      });
    } catch (err) {
      if (err instanceof WalmartApiError) {
        // Surface Walmart's own body verbatim so Jackie can show the
        // operator the real error (4-hour-window message for new items,
        // ItemNotFound for typo'd SKUs, AuthorizationFailure, etc.) —
        // any post-processing here would hide useful detail.
        const reason =
          err.status === 401 || err.status === 403
            ? "Walmart auth failed — check WALMART_CLIENT_ID_STORE1 / WALMART_CLIENT_SECRET_STORE1"
            : err.status === 404
              ? `SKU "${sku}" not found in this Walmart account`
              : `Walmart API ${err.status}`;
        return {
          ok: false,
          sku,
          error: reason,
          walmart_status: err.status,
          walmart_correlation_id: err.correlationId,
          walmart_response: err.errorBody,
        };
      }
      throw err;
    }

    return {
      ok: true,
      sku,
      quantity_set: quantity,
      walmart_response: walmartResponse,
    };
  },
};

export const tools: JackieTool[] = [walmartInventoryUpdate];
