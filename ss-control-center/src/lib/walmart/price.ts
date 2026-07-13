/**
 * Walmart price updates — the WRITE path for List Price.
 *
 * Two Walmart mechanisms, both covered here:
 *   1. PUT /v3/price          — single SKU, synchronous ("Thank you" response
 *                               means the price is applied within minutes).
 *   2. POST /v3/feeds?feedType=price — bulk Price feed (spec 1.7). Async:
 *                               returns a feedId; poll GET /v3/feeds/{feedId}
 *                               for per-item results.
 *
 * The token for store1 (Sirius Trading International LLC) already carries
 * price=full_access + feeds=full_access (verified via /v3/token/detail
 * 2026-07-13), so no separate credential set is needed for writes.
 */

import type { WalmartClient } from "./client";

export interface PriceUpdate {
  sku: string;
  /** New List Price in dollars, e.g. 12.99 */
  price: number;
}

const PRICE_FEED_VERSION = "1.7";
/** Walmart caps price feeds well above this, but keep batches modest so a
 *  single bad feed doesn't take thousands of SKUs down with it. */
export const MAX_PRICE_FEED_ITEMS = 1000;

/** Body for PUT /v3/price (single-SKU synchronous update). */
export function buildSinglePriceBody(u: PriceUpdate, currency = "USD") {
  return {
    sku: u.sku,
    pricing: [
      {
        currentPriceType: "BASE",
        currentPrice: { currency, amount: u.price },
      },
    ],
  };
}

/** Payload for POST /v3/feeds?feedType=price (bulk Price feed 1.7). */
export function buildPriceFeedPayload(updates: PriceUpdate[], currency = "USD") {
  return {
    PriceHeader: { version: PRICE_FEED_VERSION },
    Price: updates.map((u) => ({
      itemIdentifier: { sku: u.sku },
      pricingList: {
        pricing: [
          {
            currentPriceType: "BASE",
            currentPrice: { currency, amount: u.price },
          },
        ],
      },
    })),
  };
}

/** Reject obviously broken inputs before anything reaches Walmart:
 *  non-finite / ≤ 0 / > $10k prices and empty SKUs are always fat-fingers
 *  in this catalog (food bundles), never intentional. */
export function validatePriceUpdates(updates: PriceUpdate[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const u of updates) {
    if (!u.sku || typeof u.sku !== "string" || !u.sku.trim()) {
      problems.push(`empty sku (price=${u.price})`);
      continue;
    }
    if (seen.has(u.sku)) problems.push(`duplicate sku "${u.sku}"`);
    seen.add(u.sku);
    if (typeof u.price !== "number" || !Number.isFinite(u.price)) {
      problems.push(`"${u.sku}": price is not a number`);
    } else if (u.price <= 0) {
      problems.push(`"${u.sku}": price must be > 0 (got ${u.price})`);
    } else if (u.price > 10000) {
      problems.push(`"${u.sku}": price ${u.price} > $10,000 — looks like a typo`);
    }
  }
  return problems;
}

/** Single synchronous price update. Throws WalmartApiError on failure. */
export async function updateSinglePrice(
  client: WalmartClient,
  update: PriceUpdate,
  currency = "USD",
): Promise<unknown> {
  return client.request("PUT", "/price", {
    body: buildSinglePriceBody(update, currency),
  });
}

/** Bulk price feed. Returns the feedId to poll, or throws WalmartApiError. */
export async function submitPriceFeed(
  client: WalmartClient,
  updates: PriceUpdate[],
  currency = "USD",
): Promise<{ feedId: string | null; raw: unknown }> {
  const resp = await client.requestRaw("POST", "/feeds", {
    params: { feedType: "price" },
    body: buildPriceFeedPayload(updates, currency),
  });
  const body = resp.body as { feedId?: string } | null;
  return { feedId: body?.feedId ?? null, raw: resp.body };
}
