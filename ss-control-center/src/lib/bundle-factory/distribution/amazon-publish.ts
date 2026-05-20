/**
 * Phase 2.5 Stage 7 — Amazon publish via Listings Items 2021-08-01 PUT.
 *
 * PUT vs PATCH: we use PUT here because this is a CREATE-OR-REPLACE on
 * the seller-owned SKU listing. PUT is idempotent per Amazon docs —
 * the same payload to the same SKU produces the same submission_id on
 * retry, so re-running publish on an already-LIVE SKU is a safe no-op.
 *
 * Flow:
 *   1. Build the attributes block from ChannelSKU
 *   2. (optional) VALIDATION_PREVIEW first — catches schema errors
 *      before the real PUT mutates the listing
 *   3. Real PUT — returns { sku, status, submissionId, issues? }
 *
 * No automatic productType lookup — we accept productType as input so
 * the orchestrator can plumb the right one through from the master
 * bundle's category (and the operator can override on a per-SKU basis).
 *
 * Failure modes:
 *   - DRY_RUN: skip the PUT entirely; return a simulated payload
 *   - VALIDATION_PREVIEW returns status='INVALID' → caller treats as
 *     FAILED with the issues array on distribution_errors
 *   - PUT throws (network/auth) → caller treats as FAILED and records
 *     the error message
 */

import { spApiPut, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import type { ChannelSKU } from "@/generated/prisma/client";

export type ProductTypeDefault = "PRODUCT" | string;

export interface AmazonPublishInput {
  sku: ChannelSKU;
  storeIndex: number;
  /** Amazon Product Type — e.g. POULTRY, GROCERY, GIFT_BASKET. Defaults
   *  to "PRODUCT" which lets Amazon's classifier choose; that's
   *  acceptable for the first submission but operators should pin it
   *  to the right slug for repeatable behaviour. */
  productType?: ProductTypeDefault;
  /** Skip the real PUT — used by the API route's dryRun=true path. */
  dryRun?: boolean;
  /** When true, also run a VALIDATION_PREVIEW before the real PUT. */
  validatePreviewFirst?: boolean;
}

export interface AmazonPublishResult {
  ok: boolean;
  submission_id: string | null;
  /** Raw Amazon status string. ACCEPTED is the happy path; INVALID,
   *  IN_PROGRESS, EXPIRED also possible. */
  amazon_status: string | null;
  /** Final payload that was (or would have been) PUT. Always returned
   *  so the dry-run / smoke / UI preview can show it. */
  payload: Record<string, unknown>;
  /** Issues array from VALIDATION_PREVIEW or the real PUT. */
  issues: Array<{
    code?: string;
    severity?: string;
    message?: string;
    attributeNames?: string[];
  }>;
  /** Set when the request failed entirely (network, auth, dry-run). */
  error?: string;
  dry_run: boolean;
}

/**
 * Build the attributes block. Each value array is shape
 *   { value, language_tag, marketplace_id }
 * or for the image:
 *   { media_location, language_tag, marketplace_id }
 *
 * Visible for tests so payload structure can be asserted without
 * round-tripping through SP-API.
 */
export function buildAmazonAttributes(
  sku: ChannelSKU,
): Record<string, unknown> {
  let bullets: string[] = [];
  try {
    const parsed = JSON.parse(sku.bullets || "[]");
    if (Array.isArray(parsed)) {
      bullets = parsed.filter((b): b is string => typeof b === "string");
    }
  } catch {
    /* leave empty; caller already validated bullets in Stage 6 */
  }

  const lt = (value: string) => ({
    value,
    language_tag: "en_US",
    marketplace_id: MARKETPLACE_ID,
  });

  const attrs: Record<string, unknown> = {
    item_name: [lt(sku.title)],
    brand: [lt("Salutem Vita")], // overridden below if master_bundle brand differs
    bullet_point: bullets.map(lt),
    product_description: [lt(sku.description)],
  };

  if (sku.main_image_url) {
    attrs.main_product_image_locator = [
      {
        media_location: sku.main_image_url,
        language_tag: "en_US",
        marketplace_id: MARKETPLACE_ID,
      },
    ];
  }

  // UPC. Amazon requires either an externally assigned product identifier
  // (UPC/EAN/GTIN) OR a GTIN exemption. We always have a UPC at this
  // stage (validator-upc-format checked it).
  attrs.externally_assigned_product_identifier = [
    {
      type: "upc",
      value: sku.upc,
      marketplace_id: MARKETPLACE_ID,
    },
  ];

  // Package dimensions + weight — validator-packaging-dims + -weight
  // already enforced positive non-null at this stage.
  if (
    sku.package_length_in != null &&
    sku.package_width_in != null &&
    sku.package_height_in != null
  ) {
    attrs.item_package_dimensions = [
      {
        length: { value: sku.package_length_in, unit: "inches" },
        width: { value: sku.package_width_in, unit: "inches" },
        height: { value: sku.package_height_in, unit: "inches" },
        marketplace_id: MARKETPLACE_ID,
      },
    ];
  }
  if (sku.package_weight_oz != null) {
    attrs.item_package_weight = [
      {
        value: sku.package_weight_oz,
        unit: "ounces",
        marketplace_id: MARKETPLACE_ID,
      },
    ];
  }

  if (sku.country_of_origin) {
    attrs.country_of_origin = [lt(sku.country_of_origin)];
  }

  if (sku.channel_browse_node) {
    attrs.recommended_browse_nodes = [
      { value: sku.channel_browse_node, marketplace_id: MARKETPLACE_ID },
    ];
  }

  return attrs;
}

export function buildAmazonPayload(
  sku: ChannelSKU,
  productType: string,
): Record<string, unknown> {
  return {
    productType,
    requirements: "LISTING",
    attributes: buildAmazonAttributes(sku),
  };
}

export async function submitToAmazon(
  input: AmazonPublishInput,
): Promise<AmazonPublishResult> {
  const productType = input.productType ?? "PRODUCT";
  const payload = buildAmazonPayload(input.sku, productType);

  if (input.dryRun) {
    return {
      ok: true,
      submission_id: null,
      amazon_status: "DRY_RUN",
      payload,
      issues: [],
      dry_run: true,
    };
  }

  // Resolve seller id (auto-discovered from Sellers API or env override).
  let sellerId: string;
  try {
    sellerId = await getMerchantToken(input.storeIndex);
  } catch (e) {
    return {
      ok: false,
      submission_id: null,
      amazon_status: null,
      payload,
      issues: [],
      error: `Failed to resolve sellerId for store${input.storeIndex}: ${e instanceof Error ? e.message : String(e)}`,
      dry_run: false,
    };
  }

  const url = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(input.sku.sku)}`;
  const storeId = `store${input.storeIndex}`;

  // VALIDATION_PREVIEW first if requested. Defaults to off for PUT
  // because the SP-API mode=VALIDATION_PREVIEW gate is well-tested via
  // the disclaimer-injection-execute path and an extra round-trip
  // doubles publish latency. The orchestrator turns it on by default
  // for the first submission of every SKU; per-SKU retries skip it.
  if (input.validatePreviewFirst) {
    try {
      const preview = await spApiPut(url, payload, {
        storeId,
        params: { marketplaceIds: MARKETPLACE_ID, mode: "VALIDATION_PREVIEW" },
      });
      if (preview?.status === "INVALID") {
        return {
          ok: false,
          submission_id: preview?.submissionId ?? null,
          amazon_status: "INVALID",
          payload,
          issues: Array.isArray(preview?.issues) ? preview.issues : [],
          error: "VALIDATION_PREVIEW rejected",
          dry_run: false,
        };
      }
    } catch (e) {
      return {
        ok: false,
        submission_id: null,
        amazon_status: null,
        payload,
        issues: [],
        error: `VALIDATION_PREVIEW failed: ${e instanceof Error ? e.message : String(e)}`,
        dry_run: false,
      };
    }
  }

  // Real PUT.
  try {
    const response = await spApiPut(url, payload, {
      storeId,
      params: { marketplaceIds: MARKETPLACE_ID },
    });
    const status =
      typeof response?.status === "string" ? response.status : "UNKNOWN";
    const issues = Array.isArray(response?.issues) ? response.issues : [];
    return {
      ok: status === "ACCEPTED" || status === "IN_PROGRESS",
      submission_id: response?.submissionId ?? null,
      amazon_status: status,
      payload,
      issues,
      dry_run: false,
    };
  } catch (e) {
    return {
      ok: false,
      submission_id: null,
      amazon_status: null,
      payload,
      issues: [],
      error: `PUT failed: ${e instanceof Error ? e.message : String(e)}`,
      dry_run: false,
    };
  }
}
