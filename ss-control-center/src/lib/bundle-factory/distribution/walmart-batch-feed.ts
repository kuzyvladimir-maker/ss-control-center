/**
 * Many listings, one feed.
 *
 * Walmart's documented baseline is roughly ten feeds per hour, and the factory's
 * target is ten LISTINGS per hour. One feed per listing therefore spends the
 * entire allowance to publish the smallest batch the owner asked for, and any
 * larger run queues behind the rate limiter instead of behind Walmart's
 * processing. MP_ITEM carries an array; sellers load thousands that way.
 *
 * The dangerous part of batching is not the array — it is what happens when a
 * feed is wrong. So this module is only the composer, and it is deliberately
 * strict: everything it can check before the POST, it checks, because after the
 * POST a single mistake costs every listing in the feed rather than one.
 *
 * The per-item half of the contract already exists on the read side: the poller
 * resolves each listing by its exact seller SKU inside `itemIngestionStatus`,
 * so twenty listings sharing one feed ID each read their own result and their
 * own errors. That is what makes this safe to compose.
 */

/** Feed size. Twenty is the plan's starting point — small enough that one bad
 * feed is a contained loss, large enough to buy 20× the publishing rate. */
export const WALMART_BATCH_FEED_MAX_ITEMS = 20;

export interface WalmartBatchFeedEntry {
  /** Seller SKU, exactly as it will appear in the feed and in the poll. */
  sku: string;
  /** A single-item payload from `buildWalmartPayload`. */
  payload: Record<string, unknown>;
}

export interface WalmartBatchFeed {
  payload: Record<string, unknown>;
  /** The seller SKUs carried, in feed order — the binding for the attempts. */
  skus: string[];
  filename: string;
  contentType: "application/json";
  content: string;
}

export class WalmartBatchFeedError extends Error {}

interface SingleItemPayload {
  MPItemFeedHeader?: { businessUnit?: unknown; locale?: unknown; version?: unknown };
  MPItem?: unknown[];
}

/**
 * Compose one MP_ITEM feed from single-item payloads.
 *
 * Refuses anything it cannot prove is safe rather than sending a feed that is
 * only probably right:
 *
 * - a payload that is not exactly one item — the caller built it wrong;
 * - two entries with the same seller SKU, which Walmart resolves
 *   unpredictably and which would make the per-item read ambiguous;
 * - two entries with the same product ID, which is our own duplicate arriving
 *   in a single feed where no live-listing check can see it;
 * - headers that disagree, since a feed has exactly one.
 */
export function buildWalmartBatchFeed(
  entries: WalmartBatchFeedEntry[],
  maxItems: number = WALMART_BATCH_FEED_MAX_ITEMS,
): WalmartBatchFeed {
  if (entries.length === 0) {
    throw new WalmartBatchFeedError("A Walmart feed needs at least one item.");
  }
  if (entries.length > maxItems) {
    throw new WalmartBatchFeedError(
      `A Walmart feed carries at most ${maxItems} items; got ${entries.length}.`,
    );
  }

  let header: Record<string, unknown> | null = null;
  const items: unknown[] = [];
  const seenSkus = new Set<string>();
  const seenProductIds = new Set<string>();

  for (const entry of entries) {
    const payload = entry.payload as SingleItemPayload;
    const own = payload.MPItem;
    if (!Array.isArray(own) || own.length !== 1) {
      throw new WalmartBatchFeedError(
        `${entry.sku}: expected exactly one MPItem in the built payload, got `
        + `${Array.isArray(own) ? own.length : "none"}.`,
      );
    }
    const candidateHeader = payload.MPItemFeedHeader;
    if (!candidateHeader || typeof candidateHeader !== "object") {
      throw new WalmartBatchFeedError(`${entry.sku}: payload has no MPItemFeedHeader.`);
    }
    const normalized = JSON.stringify(candidateHeader);
    if (header === null) {
      header = candidateHeader as Record<string, unknown>;
    } else if (JSON.stringify(header) !== normalized) {
      // Most likely two different spec versions. A feed declares one version,
      // and validating half the items against the wrong schema is how a whole
      // batch fails on something that was never wrong.
      throw new WalmartBatchFeedError(
        `${entry.sku}: feed header differs from the rest of the batch — `
        + "items built against different specs cannot share a feed.",
      );
    }

    const feedSku = orderableSku(own[0]);
    if (feedSku !== entry.sku) {
      throw new WalmartBatchFeedError(
        `${entry.sku}: the payload carries seller SKU ${feedSku ?? "none"}; the `
        + "poller resolves results by exact SKU and would never find this one.",
      );
    }
    if (seenSkus.has(entry.sku)) {
      throw new WalmartBatchFeedError(`${entry.sku} appears twice in one feed.`);
    }
    seenSkus.add(entry.sku);

    const productId = orderableProductId(own[0]);
    if (productId) {
      if (seenProductIds.has(productId)) {
        throw new WalmartBatchFeedError(
          `Product ID ${productId} is used by two items in one feed (${entry.sku}).`,
        );
      }
      seenProductIds.add(productId);
    }

    items.push(own[0]);
  }

  const payload = { MPItemFeedHeader: header, MPItem: items };
  const skus = entries.map((entry) => entry.sku);
  return {
    payload,
    skus,
    filename: `batch-${skus.length}-mp-item.json`,
    contentType: "application/json",
    content: JSON.stringify(payload),
  };
}

function orderableSku(item: unknown): string | null {
  const orderable = (item as { Orderable?: { sku?: unknown } })?.Orderable;
  const sku = orderable?.sku;
  return typeof sku === "string" && sku.trim() ? sku : null;
}

function orderableProductId(item: unknown): string | null {
  const orderable = (item as {
    Orderable?: { productIdentifiers?: { productId?: unknown } };
  })?.Orderable;
  const value = orderable?.productIdentifiers?.productId;
  return typeof value === "string" && value.trim() ? value : null;
}
