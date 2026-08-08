/**
 * Jackie MCP tool — walmart_price_get (READ).
 *
 * Jackie could already WRITE Walmart prices (walmart_update_price) but had no
 * way to READ them, so every price audit had to infer "current price" from the
 * last order that sold — i.e. the price at time of sale, not today's. This
 * closes that gap.
 *
 * Source endpoint. Walmart has no `GET /v3/price`: probed live 2026-08-08 and
 * it answers 404 CONTENT_NOT_FOUND ("No static resource v3/price") — /v3/price
 * is PUT-only. The item endpoint is the readable one and it carries the live
 * price alongside the publish state:
 *
 *   GET /v3/items/{sku} → ItemResponse[0].price = { currency, amount }
 *
 * Read-only: it issues GETs and never touches the price-write contract that
 * the `walmart-price-ramp-breadline` cron depends on.
 *
 * Like the other walmart_* tools this hardcodes storeIndex=1 (the single
 * Walmart account).
 */

import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { requireString } from "../channels";
import type { JackieTool } from "../registry";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STORE_INDEX = 1;

/** Walmart's per-token rate bucket is small; a handful of parallel GETs keeps
 *  a 100-SKU batch reasonable without tripping 429 backoff. */
const CONCURRENCY = 4;

/** Guard against a caller asking for the whole catalog in one MCP response. */
export const MAX_PRICE_SKUS = 100;

export interface WalmartPriceRow {
  sku: string;
  current_price: number | null;
  currency: string | null;
  effective_date: string | null;
  published_status: string | null;
  lifecycle_status: string | null;
  availability: string | null;
  wpid: string | null;
  upc: string | null;
  product_name: string | null;
  error?: string;
  walmart_status?: number;
}

function unwrapItem(payload: any): any | null {
  const list = payload?.ItemResponse ?? payload?.itemResponse ?? payload?.items;
  if (Array.isArray(list)) return list[0] ?? null;
  if (list && typeof list === "object") return list;
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Read one SKU's live price. Never throws — a per-SKU failure is reported in
 *  the row so one retired SKU can't take a 100-SKU batch down. */
export async function readWalmartPrice(sku: string): Promise<WalmartPriceRow> {
  const empty: WalmartPriceRow = {
    sku,
    current_price: null,
    currency: null,
    effective_date: null,
    published_status: null,
    lifecycle_status: null,
    availability: null,
    wpid: null,
    upc: null,
    product_name: null,
  };
  const client = getWalmartClient(STORE_INDEX);
  try {
    const data = await client.request<any>(
      "GET",
      `/items/${encodeURIComponent(sku)}`,
    );
    const item = unwrapItem(data);
    if (!item) {
      return { ...empty, error: `SKU "${sku}" not found in this Walmart account` };
    }
    const price = item.price ?? {};
    const amount = Number(price.amount);
    return {
      ...empty,
      // Walmart echoes the canonical SKU casing — prefer it over the input.
      sku: str(item.sku) ?? sku,
      current_price: Number.isFinite(amount) ? amount : null,
      currency: str(price.currency),
      // Walmart's item payload has no price-effective timestamp; the field is
      // kept in the contract (and filled when Walmart does send one) so the
      // shape doesn't change if they add it.
      effective_date: str(price.effectiveDate) ?? str(item.priceEffectiveDate),
      published_status: str(item.publishedStatus),
      lifecycle_status: str(item.lifecycleStatus),
      availability: str(item.availability),
      wpid: str(item.wpid),
      upc: str(item.upc) ?? str(item.gtin),
      product_name: str(item.productName),
    };
  } catch (err) {
    if (err instanceof WalmartApiError) {
      return {
        ...empty,
        error:
          err.status === 404
            ? `SKU "${sku}" not found in this Walmart account`
            : err.status === 401 || err.status === 403
              ? "Walmart auth failed — check WALMART_CLIENT_ID_STORE1 / WALMART_CLIENT_SECRET_STORE1"
              : `Walmart API ${err.status}`,
        walmart_status: err.status,
      };
    }
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Fixed-size worker pool — preserves input order in the output array. */
async function mapPool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const walmartPriceGet: JackieTool = {
  name: "walmart_price_get",
  description:
    "Read the CURRENT live Walmart price for one SKU (`sku`) or a batch (`skus`, up to 100). Source: GET /v3/items/{sku} — the live catalog record, so this is today's price, not the price at time of sale. Returns current_price, currency, effective_date (null — Walmart's item payload carries no price timestamp), published_status, lifecycle_status, availability, wpid, upc and product_name per SKU. Read-only; per-SKU errors are reported inline so one bad SKU never fails the batch.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      sku: { type: "string", description: "Single Walmart seller SKU." },
      skus: {
        type: "array",
        items: { type: "string" },
        description: `Batch of Walmart seller SKUs (max ${MAX_PRICE_SKUS}). Use instead of \`sku\`.`,
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const batchRaw = Array.isArray(args.skus) ? args.skus : null;

    let skus: string[];
    if (batchRaw) {
      skus = batchRaw
        .map((s) => String(s ?? "").trim())
        .filter((s) => s.length > 0);
      if (skus.length === 0) {
        throw new Error("'skus' was provided but contains no non-empty SKU.");
      }
      if (skus.length > MAX_PRICE_SKUS) {
        throw new Error(
          `'skus' has ${skus.length} entries; max is ${MAX_PRICE_SKUS} per call. Split the batch.`,
        );
      }
      // De-dup so a repeated SKU doesn't burn a second Walmart call.
      skus = [...new Set(skus)];
    } else {
      // No batch → `sku` is mandatory (requireString gives the clear error).
      skus = [requireString(args, "sku").trim()];
    }

    const prices = await mapPool(skus, CONCURRENCY, readWalmartPrice);
    const found = prices.filter((p) => p.current_price !== null).length;
    return {
      count: prices.length,
      found,
      missing: prices.length - found,
      source: "GET /v3/items/{sku}",
      prices,
    };
  },
};

export const tools: JackieTool[] = [walmartPriceGet];
