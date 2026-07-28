/**
 * Multi-ship-node inventory helpers.
 *
 * The reason this file exists: Walmart's `/v3/inventory` endpoint takes
 * an optional `shipNode` parameter. Without it, GET reads / PUT writes
 * the seller's *default* ship node only. If the account has multiple
 * fulfillment centers (which ours does — Warehouse 1162 +
 * STARFITSTORE 10001624309 + a third 3PL node), the default-only
 * variant leaves the other nodes untouched. That's how a "retire
 * listing" call zeroed one node, returned 200 OK on the verify
 * read-back (because the read also only saw the default), and the
 * listing kept selling stock from the other warehouse.
 *
 * Walmart does not expose a "list ship nodes for this account"
 * endpoint (we tried /v3/shipnodes, /v3/ship-nodes, /v3/seller/shipnodes
 * — all 404). The only reliable way to discover the full node set is
 * to paginate `/v3/inventories` (plural, ignores the sku filter) and
 * collect distinct `shipNode` IDs from the response. We cache that
 * list in-process for an hour so retire calls don't pay the discovery
 * cost on every click.
 */

import type { WalmartClient } from "./client";

const NODE_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const DISCOVERY_MAX_PAGES = 3; // ~30 SKUs covers all nodes in practice

interface NodeCacheEntry {
  nodes: string[];
  fetchedAt: number;
}
const nodeCache = new Map<number, NodeCacheEntry>();

/**
 * Discover every shipNode this Walmart account has inventory in.
 * Scans the first few pages of /v3/inventories — each entry has a
 * `nodes[]` array; we union them. Cached in-process for 1h.
 *
 * Returns an empty array (without throwing) if Walmart errors out;
 * callers should treat that as "fall back to default-node behaviour"
 * rather than failing the whole flow.
 */
export async function getKnownShipNodes(
  client: WalmartClient,
  storeIndex: number,
): Promise<string[]> {
  const cached = nodeCache.get(storeIndex);
  if (cached && Date.now() - cached.fetchedAt < NODE_CACHE_TTL_MS) {
    return cached.nodes;
  }
  const seen = new Set<string>();
  try {
    let cursor: string | undefined;
    for (let i = 0; i < DISCOVERY_MAX_PAGES; i++) {
      const params: Record<string, string> = {};
      if (cursor) params.nextCursor = cursor;
      const r = (await client.request("GET", "/inventories", { params })) as {
        meta?: { nextCursor?: string };
        elements?: {
          inventories?: Array<{
            nodes?: Array<{ shipNode?: string }>;
          }>;
        };
      };
      const items = r?.elements?.inventories ?? [];
      for (const it of items) {
        for (const n of it.nodes ?? []) {
          if (n.shipNode) seen.add(n.shipNode);
        }
      }
      cursor = r?.meta?.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    console.warn(
      `[walmart/inventory] getKnownShipNodes(${storeIndex}) failed:`,
      e instanceof Error ? e.message : e,
    );
  }
  const nodes = Array.from(seen);
  nodeCache.set(storeIndex, { nodes, fetchedAt: Date.now() });
  return nodes;
}

/** Force a refresh on the next call — used by manual diag endpoints. */
export function invalidateShipNodeCache(storeIndex: number) {
  nodeCache.delete(storeIndex);
}

export interface PerNodeQty {
  shipNode: string;
  qty: number | null; // null = GET failed for this node
}

/**
 * Read inventory for a single SKU across every known ship node.
 * Returns one entry per discovered ship node (qty=null means the GET
 * for that node failed — usually 404 if the SKU isn't stocked there).
 *
 * If discovery returns empty (no nodes found at all — broken account
 * or Walmart hiccup), falls back to a single default-node read so the
 * caller still gets something.
 */
export async function readInventoryAcrossNodes(
  client: WalmartClient,
  storeIndex: number,
  sku: string,
): Promise<{ nodes: PerNodeQty[]; totalQty: number }> {
  const shipNodes = await getKnownShipNodes(client, storeIndex);

  if (shipNodes.length === 0) {
    // Discovery dry — fall back to default-node so the caller still
    // sees a number, even if it's incomplete.
    try {
      const r = (await client.request("GET", "/inventory", {
        params: { sku },
      })) as { quantity?: { amount?: number } };
      const amt = typeof r?.quantity?.amount === "number" ? r.quantity.amount : null;
      return {
        nodes: [{ shipNode: "default", qty: amt }],
        totalQty: amt ?? 0,
      };
    } catch {
      return { nodes: [], totalQty: 0 };
    }
  }

  const out: PerNodeQty[] = [];
  let total = 0;
  for (const sn of shipNodes) {
    try {
      const r = (await client.request("GET", "/inventory", {
        params: { sku, shipNode: sn },
      })) as { quantity?: { amount?: number } };
      const amt = typeof r?.quantity?.amount === "number" ? r.quantity.amount : 0;
      out.push({ shipNode: sn, qty: amt });
      total += amt;
    } catch {
      out.push({ shipNode: sn, qty: null });
    }
  }
  return { nodes: out, totalQty: total };
}

export interface PerNodeWriteResult {
  shipNode: string;
  ok: boolean;
  error?: string;
}

/**
 * Wait + retry readback. Walmart processes inventory PUTs
 * asynchronously — their own Seller Center UI explicitly warns
 * "Updates may take up to 1 hour". A read fired ~500ms after PUT
 * almost always returns the stale pre-PUT value, which made our
 * single-shot verification falsely report a silent-fail.
 *
 * This polls /v3/inventory across all known nodes a few times,
 * exponentially backing off, until either:
 *   - totalQty equals the expected amount (success), or
 *   - we exhaust the retry budget (caller surfaces silent-fail).
 *
 * Defaults: 4 attempts at 1.5s, 3s, 5s, 7s ≈ 17s worst-case. The
 * common path returns on attempt 2-3 (≈4-9s), which is well inside
 * what the operator already expects from the spinner.
 */
export async function verifyInventoryAllNodes(
  client: WalmartClient,
  storeIndex: number,
  sku: string,
  expectedTotalQty: number,
  opts: { delaysMs?: number[] } = {},
): Promise<{ nodes: PerNodeQty[]; totalQty: number; attempts: number }> {
  const delays = opts.delaysMs ?? [1500, 3000, 5000, 7000];
  let last: { nodes: PerNodeQty[]; totalQty: number } = {
    nodes: [],
    totalQty: -1,
  };
  for (let i = 0; i < delays.length; i++) {
    await new Promise((r) => setTimeout(r, delays[i]));
    last = await readInventoryAcrossNodes(client, storeIndex, sku);
    if (last.totalQty === expectedTotalQty) {
      return { ...last, attempts: i + 1 };
    }
  }
  return { ...last, attempts: delays.length };
}

/**
 * Set inventory to `amount` on every known ship node for one SKU.
 * Returns one entry per ship node attempted; the caller is expected
 * to follow up with `readInventoryAcrossNodes` for verification (so
 * silent-no-op nodes are caught the way the single-node path was).
 *
 * Continues past per-node failures — retiring 2/3 nodes is still
 * better than aborting after the first error and leaving inventory
 * partly live.
 */
export async function setInventoryAllNodes(
  client: WalmartClient,
  storeIndex: number,
  sku: string,
  amount: number,
): Promise<PerNodeWriteResult[]> {
  const shipNodes = await getKnownShipNodes(client, storeIndex);

  // If discovery failed, still attempt a default-node write so the
  // operator gets at least the old behaviour rather than nothing.
  const nodes = shipNodes.length > 0 ? shipNodes : [null];
  const results: PerNodeWriteResult[] = [];

  for (const sn of nodes) {
    const params: Record<string, string> = { sku };
    if (sn) params.shipNode = sn;
    const body = { sku, quantity: { unit: "EACH", amount } };
    try {
      await client.request("PUT", "/inventory", { params, body });
      results.push({ shipNode: sn ?? "default", ok: true });
    } catch (e) {
      results.push({
        shipNode: sn ?? "default",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}
