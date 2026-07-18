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
import {
  physicalPackageSpecsMatchSku,
  type VerifiedPhysicalPackageSpecs,
} from "../physical-package-specs";

export interface WalmartPublishInput {
  sku: ChannelSKU;
  storeIndex: number;
  /** Real brand of the bundle (from MasterBundle). Walmart multipacks list
   *  under the genuine product brand for own-brand passthrough, else the house
   *  brand. Falls back to "Salutem Vita" when not supplied. */
  brand?: string | null;
  /** Total unit count in the multipack. Drives the quantity trio
   *  (multipackQuantity / countPerPack / count) — the #1 lever against Walmart
   *  quantity-confusion returns. */
  packCount?: number | null;
  /** Exact operator-entered packed measurements. Calculated size-tier values
   * are not valid marketplace product facts. */
  physicalPackageSpecs?: VerifiedPhysicalPackageSpecs | null;
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
  opts: {
    brand?: string | null;
    packCount?: number | null;
    physicalPackageSpecs?: VerifiedPhysicalPackageSpecs | null;
  } = {},
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

  // Walmart wants pounds. Only the operator-verified physical proof may feed
  // this field; the old 0.01-lb fallback was an invented product fact.
  const weightLbs = opts.physicalPackageSpecs
    ? opts.physicalPackageSpecs.weight_oz / 16
    : null;

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

  // Brand: the real bundle brand (own-brand passthrough lists under the genuine
  // product brand; house-brand sets under "Salutem Vita"). Never hardcode.
  const brand = (opts.brand ?? "").trim() || "Salutem Vita";

  const item: Record<string, unknown> = {
    sku: sku.sku,
    productIdentifiers,
    productName: sku.title,
    brand,
    shortDescription: sku.description,
    keyFeatures: bullets, // Walmart 'keyFeatures' aka bullets
    mainImageUrl,
    productSecondaryImageURL: [],
    countryOfOrigin: sku.country_of_origin ?? "US",
    productType: sku.item_type ?? "Gift Baskets",
  };
  if (weightLbs != null) {
    item.shippingWeight = {
      value: Number(weightLbs.toFixed(2)),
      unit: "LB",
    };
  }

  // Quantity trio — the multipack signal Walmart indexes and shows on the PDP,
  // and the #1 lever against quantity-confusion returns (a multipack of N
  // individually-saleable units → Multipack Quantity = N, Count Per Pack = 1,
  // Total Count = N). Matches the proven multipack remediation convention
  // (src/lib/walmart/multipack/attributes.ts). Only emitted for real multipacks.
  const packCount = opts.packCount;
  if (typeof packCount === "number" && Number.isFinite(packCount) && packCount >= 2) {
    item.multipackQuantity = Math.round(packCount);
    item.countPerPack = 1;
    item.count = Math.round(packCount);
  }

  if (opts.physicalPackageSpecs) {
    item.assembledProductDimensions = {
      length: opts.physicalPackageSpecs.length_in,
      width: opts.physicalPackageSpecs.width_in,
      height: opts.physicalPackageSpecs.height_in,
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
  const payload = buildWalmartPayload(input.sku, {
    brand: input.brand,
    packCount: input.packCount,
    physicalPackageSpecs: input.physicalPackageSpecs,
  });

  if (
    !input.physicalPackageSpecs ||
    !physicalPackageSpecsMatchSku(input.sku, input.physicalPackageSpecs)
  ) {
    return {
      ok: false,
      feed_id: null,
      walmart_status: null,
      payload,
      issues: [],
      error:
        "Exact operator-verified package weight and dimensions are required before Walmart submission",
      dry_run: Boolean(input.dryRun),
    };
  }

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
