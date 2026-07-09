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
import { resolveListingBrand } from "../own-brand";
import { isColdCategory } from "../category";
import { appendColdChainBrandCard } from "../attributes/brand-assets";
import { buildSearchTerms } from "../attributes/search-terms";
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
  /** Listing brand from the MasterBundle. Drives the Amazon `brand` attribute
   *  (own-brand carve-out publishes under the donor brand, not Salutem). */
  brand?: string | null;
  /** MasterBundle.category — drives the required `is_heat_sensitive` attribute. */
  category?: string | null;
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
  /** Listing brand from the MasterBundle (e.g. "Salutem Vita", "Starfit", or —
   *  for the Uncrustables own-brand carve-out — "Smucker's"). Falls back to
   *  "Salutem Vita" only when not supplied (legacy callers / tests). */
  brand?: string | null,
  /** MasterBundle.category — drives `is_heat_sensitive`. Optional so legacy
   *  callers/tests keep working (they get the shelf-stable default). */
  category?: string | null,
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

  // Canonicalize at the PUBLISH boundary (owner's standing rule: an own-brand
  // passthrough listing always publishes as "Uncrustables", never "Smucker's").
  // A stale MasterBundle.brand must not leak the wrong brand to Amazon — beyond
  // the brand-voice rule, Amazon cross-checks the UPC against its brand records
  // and rejects the listing with error 8572 when they disagree.
  const rawBrand = (brand ?? "").trim() || "Salutem Vita";
  const listingBrand = resolveListingBrand(rawBrand, rawBrand);

  const attrs: Record<string, unknown> = {
    item_name: [lt(sku.title)],
    brand: [lt(listingBrand)],
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

  // REQUIRED by the GROCERY / food product types (top-level `required` in the
  // live SP-API schema). Without these the PUT is rejected. `food-gifts` is a
  // valid GROCERY item_type_keyword and exactly matches a Salutem gift set.
  attrs.item_type_keyword = [
    { value: "food-gifts", marketplace_id: MARKETPLACE_ID },
  ];
  attrs.supplier_declared_dg_hz_regulation = [
    { value: "not_applicable", marketplace_id: MARKETPLACE_ID },
  ];

  // Amazon's LIVE GROCERY schema requires these two, even though our cached copy
  // in attributes/schemas/GROCERY.json still marks them optional. Omitting them
  // makes SP-API reject the submission with 90220 ("required but missing") — it
  // only bites listings that must CREATE an ASIN, which is why it surfaced on a
  // single stale draft rather than the whole catalog. Set them from facts:
  //   • our bundles are sandwiches/snacks — no liquid contents;
  //   • frozen/refrigerated goods ARE heat sensitive, shelf-stable ones are not.
  // Declared in the base block so a richer per-SKU value (sku.attributes) still
  // overrides them in the merge below.
  attrs.contains_liquid_contents = [
    { value: false, marketplace_id: MARKETPLACE_ID },
  ];
  attrs.is_heat_sensitive = [
    { value: isColdCategory(category), marketplace_id: MARKETPLACE_ID },
  ];

  // Merge the rich attribute set the filler stored on the SKU (Phase 2.1) —
  // ingredients, allergen_information, number_of_items, nutrition, etc., already
  // shaped as Amazon attribute arrays. Overrides the base where keys overlap.
  try {
    const extra = sku.attributes ? JSON.parse(sku.attributes) : null;
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      Object.assign(attrs, extra as Record<string, unknown>);
    }
  } catch {
    /* malformed sku.attributes — ignore, base attrs still valid */
  }

  // Required by the GROCERY/FOOD product type (Amazon 90220 "required but
  // missing" on the first VALIDATION_PREVIEW): price, manufacturer, unit counts,
  // shelf life, melting temperature. Counts derived from the title
  // ("8oz/4ct - Pack of 6" → 4 per box × 6 boxes = 24 total).
  const titleStr = sku.title ?? "";
  const perUnit = parseInt(titleStr.match(/(\d+)\s*ct/i)?.[1] ?? "", 10) || null;
  const boxes = parseInt(titleStr.match(/pack of\s*(\d+)/i)?.[1] ?? "", 10) || null;
  // Fallback to the merged rich-attr number_of_items (the known pack count) when
  // the title carries no "Nct"/"Pack of N" pattern — otherwise a flat multipack
  // ("… 30 Count …") would ship with NO unit_count, weakening the listing.
  const richItemCount = (() => {
    const v = attrs.number_of_items;
    if (Array.isArray(v) && v[0] && typeof v[0] === "object") {
      const n = Number((v[0] as { value?: unknown }).value);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    }
    return null;
  })();
  const totalUnits =
    (perUnit && boxes ? perUnit * boxes : boxes ?? perUnit) ?? richItemCount ?? null;
  const priceUsd = sku.price_cents != null ? sku.price_cents / 100 : null;

  if (priceUsd != null) {
    attrs.list_price = [
      { value: priceUsd, currency: "USD", marketplace_id: MARKETPLACE_ID },
    ];
    // Keep the min/max price band promote-draft stored in the rich attributes
    // (min = ROI-floor, max = target — the band ChannelMAX imports at birth),
    // and set our_price from the SKU's computed price. Guard the band so a
    // stale min/max can never contradict the actual price.
    const richOffer =
      Array.isArray(attrs.purchasable_offer) && attrs.purchasable_offer[0] &&
      typeof attrs.purchasable_offer[0] === "object"
        ? (attrs.purchasable_offer[0] as Record<string, unknown>)
        : {};
    const bandVal = (k: string): number | null => {
      const v = (richOffer[k] as Array<{ schedule?: Array<{ value_with_tax?: number }> }>)?.[0]
        ?.schedule?.[0]?.value_with_tax;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const minBand = bandVal("minimum_seller_allowed_price");
    const maxBand = bandVal("maximum_seller_allowed_price");
    attrs.purchasable_offer = [
      {
        currency: "USD",
        marketplace_id: MARKETPLACE_ID,
        our_price: [{ schedule: [{ value_with_tax: priceUsd }] }],
        ...(minBand != null && minBand <= priceUsd
          ? { minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: minBand }] }] }
          : {}),
        ...(maxBand != null && maxBand >= priceUsd
          ? { maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: maxBand }] }] }
          : {}),
      },
    ];
  }
  attrs.manufacturer = [lt(listingBrand)];
  if (totalUnits) {
    attrs.unit_count = [
      {
        value: totalUnits,
        type: { value: "Count", language_tag: "en_US" }, // nested enum object
        marketplace_id: MARKETPLACE_ID,
      },
    ];
  }
  if (perUnit) {
    attrs.each_unit_count = [{ value: perUnit, marketplace_id: MARKETPLACE_ID }];
  }
  // Exact GROCERY schema: fc_shelf_life unit enum is lowercase "days";
  // melting_temperature unit enum is "degrees_fahrenheit".
  attrs.fc_shelf_life = [
    { value: 365, unit: "days", marketplace_id: MARKETPLACE_ID },
  ];
  attrs.melting_temperature = [
    { value: 32, unit: "degrees_fahrenheit", marketplace_id: MARKETPLACE_ID },
  ];
  // fulfillment_availability — makes the offer BUYABLE (merchant-fulfilled).
  // Without it the listing stays "Missing Information" (no fulfillment channel).
  attrs.fulfillment_availability = [
    {
      fulfillment_channel_code: "DEFAULT",
      quantity: 100,
      marketplace_id: MARKETPLACE_ID,
    },
  ];

  // Fixed brand-story card in the gallery for cold-chain (frozen/refrigerated)
  // listings. Gated on the temperature_rating merged just above; no-op until the
  // asset url is set (brand-assets.ts). This also activates the secondary-image
  // (other_product_image_locator_N) path, which was previously never populated.
  appendColdChainBrandCard(attrs, MARKETPLACE_ID);

  // generic_keyword — Amazon backend search terms. Prefer a manual override on
  // the SKU, else auto-derive from the title + category synonyms. Previously
  // NEVER populated (fill-map declared it but nothing filled it) — real
  // search-visibility gap. Guarded so a merged override is not clobbered.
  if (!attrs.generic_keyword) {
    const manual = (sku.search_terms ?? "").trim();
    const keywords = manual || buildSearchTerms(sku.title, listingBrand);
    if (keywords) {
      attrs.generic_keyword = [
        { value: keywords, language_tag: "en_US", marketplace_id: MARKETPLACE_ID },
      ];
    }
  }

  return attrs;
}

export function buildAmazonPayload(
  sku: ChannelSKU,
  productType: string,
  brand?: string | null,
  category?: string | null,
): Record<string, unknown> {
  return {
    productType,
    requirements: "LISTING",
    attributes: buildAmazonAttributes(sku, brand, category),
  };
}

export async function submitToAmazon(
  input: AmazonPublishInput,
): Promise<AmazonPublishResult> {
  const productType = input.productType ?? "PRODUCT";
  const payload = buildAmazonPayload(input.sku, productType, input.brand, input.category);

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
