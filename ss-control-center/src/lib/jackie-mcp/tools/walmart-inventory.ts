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
import { searchWalmartItems } from "@/lib/walmart/items";
import {
  setInventoryAllNodes,
  readInventoryAcrossNodes,
  verifyInventoryAllNodes,
} from "@/lib/walmart/inventory";
import {
  searchWalmartCatalogCache,
  catalogCacheSize,
  syncWalmartCatalog,
} from "@/lib/walmart/catalog-cache";
import { prisma } from "@/lib/prisma";
import { optionalNumber, optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

const STORE_INDEX = 1;

const walmartItemsSearch: JackieTool = {
  name: "walmart_items_search",
  description:
    "Find every Walmart SKU whose title or SKU contains the query. Use this BEFORE walmart_inventory_update when the operator says a product name — multi-packs, bundles, and variants of the same product live under different SKUs. Reads from a nightly-refreshed local mirror of the catalog, so it answers in well under a second (NOT the old 40-60s live scan). By default returns only PUBLISHED items (the listings customers can actually buy); pass include_unpublished=true to also include UNPUBLISHED.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Product name fragment OR exact SKU, case-insensitive. e.g. "Arnold Potato Buns" matches every SKU whose title contains those words; "CAPSL-KIT-PACK4" matches that exact SKU.',
      },
      limit: {
        type: "number",
        default: 50,
        description: "Max matches to return. Default 50.",
      },
      include_unpublished: {
        type: "boolean",
        default: false,
        description:
          "Set true to also scan items with publishedStatus=UNPUBLISHED (slower; pulls ~5300 items vs ~4000 by default). Use only when the operator says they're searching for an inactive listing.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const query = requireString(args, "query");
    const limit = optionalNumber(args, "limit") ?? 50;
    const includeUnpublished = args.include_unpublished === true;

    // The catalog cache (WalmartCatalogItem) is refreshed nightly by
    // /api/cron/walmart. If it's never been populated (size 0), fall back
    // to the old live scan so the tool still works on a fresh deploy /
    // before the first cron run.
    const cacheSize = await catalogCacheSize(prisma, STORE_INDEX);
    if (cacheSize === 0) {
      const client = getWalmartClient(STORE_INDEX);
      try {
        const r = await searchWalmartItems(client, query, {
          limit,
          includeUnpublished,
        });
        return {
          query,
          source: "live_scan_fallback",
          count: r.matches.length,
          items_scanned: r.itemsScanned,
          total_items_in_catalog: r.totalItemsAvailable,
          truncated_scan: r.truncated,
          matches: r.matches,
          note:
            "Catalog cache is empty — ran a slow live scan instead. Trigger /api/cron/walmart (or wait for the nightly run) to populate the cache; after that this tool answers instantly.",
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
    }

    // Fast path: query the local mirror.
    const r = await searchWalmartCatalogCache(prisma, STORE_INDEX, query, {
      limit,
      includeUnpublished,
    });

    // Safety net: a brand-new SKU created since the last sync won't be in
    // the mirror yet. If the cache found nothing and the query looks like an
    // exact SKU (no whitespace), do a single live exact-SKU lookup.
    if (r.matches.length === 0 && !/\s/.test(query.trim())) {
      const client = getWalmartClient(STORE_INDEX);
      try {
        const live = await searchWalmartItems(client, query, { limit: 1 });
        if (live.matches.length > 0 && live.shortcutUsed === "exact_sku") {
          return {
            query,
            source: "live_exact_sku",
            count: live.matches.length,
            matches: live.matches,
            cache_last_synced_at: r.lastSyncedAt,
            note:
              "Not in the local mirror (likely created since the last nightly sync) — confirmed via a live exact-SKU lookup.",
          };
        }
      } catch {
        // Ignore — fall through to the empty cache result below.
      }
    }

    return {
      query,
      source: "cache",
      count: r.matches.length,
      total_items_in_cache: r.totalInCache,
      cache_last_synced_at: r.lastSyncedAt,
      matches: r.matches,
      note:
        r.matches.length === 0
          ? "No matches in the catalog mirror. Check spelling, try a shorter fragment, set include_unpublished=true, or ask the operator for the exact SKU."
          : undefined,
    };
  },
};

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
          "Optional fulfillment node id. Omit to update the default ship node. Ignored when all_ship_nodes is true.",
      },
      all_ship_nodes: {
        type: "boolean",
        default: false,
        description:
          "When true, fan out the PUT to EVERY ship node the account has inventory in (auto-discovered via /v3/inventories scan + cached 1h). Use this for 'mark out of stock everywhere' / retire flows — the default ship_node-omitted PUT only touches one warehouse and leaves stock in others, which is how previous retire calls silently let listings keep selling.",
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
    const allShipNodes = args.all_ship_nodes === true;
    const dryRun = args.dry_run === true;

    const body = {
      sku,
      quantity: { unit: "EACH", amount: quantity },
    };

    // The shared client auto-prepends /v3 and serialises params; build
    // the human-readable URL here just for the dry-run preview so the
    // operator sees exactly what would be called.
    const params: Record<string, string> = { sku };
    if (shipNode && !allShipNodes) params.shipNode = shipNode;
    const endpointPreview =
      `PUT https://marketplace.walmartapis.com/v3/inventory?` +
      new URLSearchParams(params).toString();

    if (dryRun) {
      return {
        dry_run: true,
        endpoint: allShipNodes
          ? "PUT https://marketplace.walmartapis.com/v3/inventory?sku=... (fanned out to every known ship node)"
          : endpointPreview,
        body,
        all_ship_nodes: allShipNodes,
        note: "No changes made. Call again with dry_run=false to apply.",
      };
    }

    const client = getWalmartClient(STORE_INDEX);

    if (allShipNodes) {
      // Fan-out across every known ship node. This is the right path
      // for "mark out of stock" / retire workflows in a multi-warehouse
      // account — default-node-only PUTs leave stock live elsewhere.
      const writes = await setInventoryAllNodes(client, STORE_INDEX, sku, quantity);
      const okCount = writes.filter((w) => w.ok).length;
      // Walmart applies inventory PUTs asynchronously — readback right
      // after PUT returns stale values. verifyInventoryAllNodes polls
      // with exponential backoff up to ~17s until totals match expected.
      const expectedTotal = quantity * writes.length;
      const verify = await verifyInventoryAllNodes(
        client,
        STORE_INDEX,
        sku,
        expectedTotal,
      );
      const success =
        writes.length > 0 &&
        okCount === writes.length &&
        verify.totalQty === expectedTotal;
      return {
        ok: success,
        sku,
        quantity_set: quantity,
        ship_nodes_attempted: writes.length,
        ship_nodes_succeeded: okCount,
        writes,
        verified_total_qty: verify.totalQty,
        verified_per_node: verify.nodes,
        verify_attempts: verify.attempts,
        ...(success
          ? {}
          : {
              error:
                okCount < writes.length
                  ? `${writes.length - okCount}/${writes.length} ship-node PUT(s) failed; see writes[]`
                  : `Walmart accepted every PUT but verify total qty = ${verify.totalQty} (expected ${quantity * writes.length}); see verified_per_node[]`,
            }),
      };
    }

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

const walmartCatalogRefresh: JackieTool = {
  name: "walmart_catalog_refresh",
  description:
    "Refresh the local Walmart catalog mirror that walmart_items_search reads from. Pages the full catalog from Walmart (~5000 items, takes 40-60s) and updates the local copy. Normally runs automatically every night — only call this manually if walmart_items_search reports the cache is empty, or right after the operator has added/renamed listings and wants search to see them immediately.",
  write: true,
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async () => {
    const client = getWalmartClient(STORE_INDEX);
    try {
      const r = await syncWalmartCatalog(prisma, client, STORE_INDEX);
      return {
        ok: true,
        items_in_cache: r.written,
        previous_rows_replaced: r.replaced,
        note: `Catalog mirror refreshed: ${r.written} items cached (replaced ${r.replaced} previous rows). walmart_items_search is now up to date.`,
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

export const tools: JackieTool[] = [
  walmartItemsSearch,
  walmartInventoryUpdate,
  walmartCatalogRefresh,
];
