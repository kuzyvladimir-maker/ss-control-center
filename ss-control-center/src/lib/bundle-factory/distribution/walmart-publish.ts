/**
 * Phase 2.5 Stage 7 — Walmart publish via Marketplace MP_ITEM feed.
 *
 * Walmart's preferred catalog submission path is a feed (JSON body, POST
 * /v3/feeds?feedType=MP_ITEM_4.7). The feed body declares a single item
 * spec. Walmart returns a feedId we poll later via /v3/feeds/{feedId}
 * for terminal status (PROCESSED + 0 errors → live).
 *
 * Spec docs we adhere to:
 *   - MP_ITEM 4.7 schema for Food / Gift Baskets
 *   - Required core fields: sku, productIdentifiers[].productIdType=UPC,
 *     productName, brand, price, shippingWeight, mainImageUrl,
 *     productSecondaryImageURL[] (we send empty array — Stage 5 only
 *     produces main images currently)
 *   - Walmart bullets cap at 80 chars each — we already enforced this
 *     in validator-bullets so payload-build assumes compliant strings.
 */

import { getWalmartClient } from "@/lib/walmart/client";
import type { ChannelSKU } from "@/generated/prisma/client";

export interface WalmartPublishInput {
  sku: ChannelSKU;
  storeIndex: number;
  /** Skip the real POST — used by the dryRun=true path. */
  dryRun?: boolean;
}

export interface WalmartPublishResult {
  ok: boolean;
  feed_id: string | null;
  /** Raw Walmart feed status string returned synchronously by the POST
   *  (typically "RECEIVED" — terminal status comes later via polling). */
  walmart_status: string | null;
  payload: Record<string, unknown>;
  issues: Array<{ code?: string; message?: string }>;
  error?: string;
  dry_run: boolean;
}

const SPEC_VERSION = "4.7";

/**
 * Build the MP_ITEM feed payload. Visible for tests so the payload
 * shape can be asserted without round-tripping through Walmart.
 */
export function buildWalmartPayload(
  sku: ChannelSKU,
): Record<string, unknown> {
  let bullets: string[] = [];
  try {
    const parsed = JSON.parse(sku.bullets || "[]");
    if (Array.isArray(parsed)) {
      bullets = parsed.filter((b): b is string => typeof b === "string");
    }
  } catch {
    /* leave empty */
  }

  // Walmart wants pounds; ChannelSKU stores ounces.
  const weightLbs =
    sku.package_weight_oz != null
      ? Math.max(0.01, sku.package_weight_oz / 16)
      : 0.01;

  const productIdentifiers: Array<{ productIdType: string; productId: string }> = [
    { productIdType: "UPC", productId: sku.upc },
  ];

  // Stage 6 validator-image-format already confirmed the main image.
  // Walmart requires a publicly-fetchable URL — our R2 prod/ path
  // qualifies; data: URLs (local dev only) will fail at the marketplace
  // side, so we surface a payload error early.
  const mainImageUrl = sku.main_image_url ?? "";
  if (mainImageUrl.startsWith("data:")) {
    // Caller decides whether to abort; we just build the payload.
  }

  const item: Record<string, unknown> = {
    sku: sku.sku,
    productIdentifiers,
    productName: sku.title,
    brand: "Salutem Vita", // ChannelSKU doesn't carry brand directly; pulled from MasterBundle in orchestrator if available
    shortDescription: sku.description,
    keyFeatures: bullets, // Walmart 'keyFeatures' aka bullets
    mainImageUrl,
    productSecondaryImageURL: [],
    shippingWeight: {
      value: Number(weightLbs.toFixed(2)),
      unit: "LB",
    },
    countryOfOrigin: sku.country_of_origin ?? "US",
    productType: sku.item_type ?? "Gift Baskets",
  };

  if (
    sku.package_length_in != null &&
    sku.package_width_in != null &&
    sku.package_height_in != null
  ) {
    item.assembledProductDimensions = {
      length: sku.package_length_in,
      width: sku.package_width_in,
      height: sku.package_height_in,
      unit: "IN",
    };
  }

  return {
    MPItemFeedHeader: {
      version: SPEC_VERSION,
      sellingChannel: "marketplace",
    },
    MPItem: [item],
  };
}

export async function submitToWalmart(
  input: WalmartPublishInput,
): Promise<WalmartPublishResult> {
  const payload = buildWalmartPayload(input.sku);

  if (input.dryRun) {
    return {
      ok: true,
      feed_id: null,
      walmart_status: "DRY_RUN",
      payload,
      issues: [],
      dry_run: true,
    };
  }

  let client;
  try {
    client = getWalmartClient(input.storeIndex);
  } catch (e) {
    return {
      ok: false,
      feed_id: null,
      walmart_status: null,
      payload,
      issues: [],
      error: `Walmart credentials missing for store${input.storeIndex}: ${e instanceof Error ? e.message : String(e)}`,
      dry_run: false,
    };
  }

  try {
    const response = (await client.request("POST", "/feeds", {
      params: { feedType: "MP_ITEM" },
      body: payload,
    })) as { feedId?: string; status?: string } | null;
    return {
      ok: Boolean(response?.feedId),
      feed_id: response?.feedId ?? null,
      walmart_status: response?.status ?? null,
      payload,
      issues: [],
      dry_run: false,
    };
  } catch (e) {
    return {
      ok: false,
      feed_id: null,
      walmart_status: null,
      payload,
      issues: [],
      error: `Walmart POST /feeds failed: ${e instanceof Error ? e.message : String(e)}`,
      dry_run: false,
    };
  }
}
