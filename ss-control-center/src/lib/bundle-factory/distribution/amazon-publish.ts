/**
 * Phase 2.5 Stage 7 — Amazon publish via Listings Items 2021-08-01 PUT.
 *
 * PUT vs PATCH: this path is for CREATE-OR-REPLACE. Replacing an existing
 * Uncrustables listing is deliberately forbidden here because a full payload
 * can erase promotion fields (for example discounted_price) that are owned by
 * the sealed launch workflow. Existing Uncrustables listings use the surgical
 * PATCH executor instead.
 *
 * Flow:
 *   1. Build the attributes block from ChannelSKU
 *   2. mandatory VALIDATION_PREVIEW first — catches schema errors
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
import { isOwnBrandPassthrough, resolveListingBrand, textSaysUncrustables } from "../own-brand";
import { isColdCategory } from "../category";
import { appendColdChainBrandCard } from "../attributes/brand-assets";
import { buildSearchTerms } from "../attributes/search-terms";
import { ITEM_TYPE_KEYWORD_FROZEN_MEALS } from "../attributes/valid-values-food";
import type { ChannelSKU } from "@/generated/prisma/client";
import { inventoryIsFresh } from "../inventory-policy";
import { priceFor } from "@/lib/pricing/cost-model";
import {
  physicalPackageSpecsMatchSku,
  type VerifiedPhysicalPackageSpecs,
} from "../physical-package-specs";
import {
  buildRichAmazonAttributes,
  type VerifiedExpirationEvidence,
} from "../attributes/build-amazon-attributes";
import {
  verifyUncrustablesMainPublishPermit,
  type UncrustablesMainPublishPermit,
} from "../audit/uncrustables-main-production-preflight";

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
  /** @deprecated Kept for caller compatibility. Every real PUT now requires a
   *  successful VALIDATION_PREVIEW regardless of this value. */
  validatePreviewFirst?: boolean;
  /** Listing brand from the MasterBundle. Drives the Amazon `brand` attribute
   *  (own-brand carve-out publishes under the donor brand, not Salutem). */
  brand?: string | null;
  /** MasterBundle.category — drives the required `is_heat_sensitive` attribute. */
  category?: string | null;
  /** Exact operator-entered packed measurements from MasterBundle provenance.
   * Cooler/box planning estimates are never accepted here. */
  physicalPackageSpecs?: VerifiedPhysicalPackageSpecs | null;
  /** Positive Amazon tokens projected from structured, reviewed manufacturer
   * declarations. Undefined/null means no authoritative allergen source. */
  verifiedAllergens?: string[] | null;
  /** Explicit manufacturer/operator expiration evidence. Category defaults are
   * never accepted as a substitute. */
  verifiedExpiration?: VerifiedExpirationEvidence | null;
  /** Sealed output of the exact-byte production authenticity preflight. */
  uncrustablesMainPermit?: UncrustablesMainPublishPermit;
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

/** Safety policy is exported so tests and orchestration diagnostics can pin it. */
export const AMAZON_VALIDATION_PREVIEW_REQUIRED = true as const;
export const UNCRUSTABLES_EXISTING_LISTING_REQUIRES_SURGICAL_PATCH =
  true as const;

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
  /** Marketplace-facing physical facts. When absent, weight and dimensions
   * are omitted even if legacy ChannelSKU columns contain calculated values. */
  physicalPackageSpecs?: VerifiedPhysicalPackageSpecs | null,
  /** Reviewed positive allergen projection. Stale sku.attributes values are
   * removed unless this argument is explicitly supplied. */
  verifiedAllergens?: string[] | null,
  /** Reviewed expiration evidence. Stale auto-filled values are removed when
   * this argument is absent. */
  verifiedExpiration?: VerifiedExpirationEvidence | null,
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
    {
      value:
        isOwnBrandPassthrough(listingBrand) && isColdCategory(category)
          ? ITEM_TYPE_KEYWORD_FROZEN_MEALS
          : "food-gifts",
      marketplace_id: MARKETPLACE_ID,
    },
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

  // These compliance facts require an explicit evidence path. Old SKU rows may
  // contain values produced by the retired ingredient/category heuristics, so
  // never preserve them merely because they are already cached in attributes.
  delete attrs.allergen_information;
  delete attrs.is_expiration_dated_product;
  delete attrs.product_expiration_type;
  const verifiedCompliance = buildRichAmazonAttributes({
    allergens: verifiedAllergens ?? [],
    verifiedExpiration,
  });
  if (verifiedAllergens != null && verifiedCompliance.allergen_information) {
    attrs.allergen_information = verifiedCompliance.allergen_information;
  }
  if (verifiedCompliance.is_expiration_dated_product) {
    attrs.is_expiration_dated_product =
      verifiedCompliance.is_expiration_dated_product;
  }
  if (verifiedCompliance.product_expiration_type) {
    attrs.product_expiration_type = verifiedCompliance.product_expiration_type;
  }

  // Package dimensions + weight come only from the operator measurement proof
  // supplied by the orchestrator. Rebuild these fields after the rich-attribute
  // merge so stale/invented values cached in sku.attributes cannot override the
  // verified source. Legacy SKU columns are deliberately ignored here.
  delete attrs.item_package_dimensions;
  delete attrs.item_package_weight;
  delete attrs.item_dimensions;
  delete attrs.item_weight;
  if (physicalPackageSpecs) {
    attrs.item_package_dimensions = [
      {
        length: { value: physicalPackageSpecs.length_in, unit: "inches" },
        width: { value: physicalPackageSpecs.width_in, unit: "inches" },
        height: { value: physicalPackageSpecs.height_in, unit: "inches" },
        marketplace_id: MARKETPLACE_ID,
      },
    ];
    attrs.item_package_weight = [
      {
        value: physicalPackageSpecs.weight_oz,
        unit: "ounces",
        marketplace_id: MARKETPLACE_ID,
      },
    ];
  }

  // Coupon-only launch pricing: a stale/imported list_price would create an
  // unsupported crossed-out reference price. The canonical base price remains
  // in purchasable_offer; promotional discounts are managed as coupons.
  delete attrs.list_price;
  delete attrs.discounted_price;

  // Required by the GROCERY/FOOD product type (Amazon 90220 "required but
  // missing" on the first VALIDATION_PREVIEW): price, manufacturer, unit counts,
  // shelf life, melting temperature. Count is structured recipe data. Never
  // re-derive it from AI text ("4 ct, Pack of 45" was previously published as
  // unit_count=180 for a 45-piece recipe).
  const richItemCount = (() => {
    const v = attrs.number_of_items;
    if (Array.isArray(v) && v[0] && typeof v[0] === "object") {
      const n = Number((v[0] as { value?: unknown }).value);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    }
    return null;
  })();
  const totalUnits = richItemCount;
  // Uncrustables has a sealed, count-based price policy. A repeat PUT must not
  // resurrect the generic Bundle Factory price cached on an old ChannelSKU.
  // Structured number_of_items is the recipe fact; title parsing is
  // deliberately forbidden here because legacy titles contained retail-carton
  // counts (for example "4 ct, Pack of 45") that inflated the bundle count.
  // Identity by brand OR title: a null/misspelled brand field must never let an
  // Uncrustables listing fall through to the generic cached price (the 2026-07
  // price-above-max birth cohort).
  const uncrustablesListing =
    isOwnBrandPassthrough(listingBrand) || textSaysUncrustables(sku.title);
  const uncrustablesCanonical =
    uncrustablesListing && totalUnits != null
      ? priceFor(totalUnits)
      : null;
  const priceUsd = uncrustablesListing
    ? uncrustablesCanonical?.suggested ?? null
    : sku.price_cents != null
      ? sku.price_cents / 100
      : null;

  if (uncrustablesListing && !uncrustablesCanonical) {
    // A stale rich-attribute offer must not make the missing-count gate look
    // satisfied or appear in a dry-run payload.
    delete attrs.purchasable_offer;
    delete attrs.business_price;
  }

  if (priceUsd != null) {
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
    const minBand = uncrustablesCanonical?.floor ?? bandVal("minimum_seller_allowed_price");
    const maxBand = uncrustablesCanonical?.suggested ?? bandVal("maximum_seller_allowed_price");
    // FAIL CLOSED on a price/band contradiction. This is a whole-array PUT, so
    // omitting a contradicting bound would silently strip the listing's
    // guardrails (and hide the upstream drift that caused the contradiction) —
    // publishing an unbounded offer is worse than failing this publish.
    if (minBand != null && minBand > priceUsd) {
      throw new Error(
        `${sku.sku}: price $${priceUsd} is below the stored min band $${minBand}; ` +
          "refusing to publish without guardrails — fix the price/band pair upstream",
      );
    }
    if (maxBand != null && maxBand < priceUsd) {
      throw new Error(
        `${sku.sku}: price $${priceUsd} is above the stored max band $${maxBand}; ` +
          "refusing to publish without guardrails — fix the price/band pair upstream",
      );
    }
    attrs.purchasable_offer = [
      {
        currency: "USD",
        marketplace_id: MARKETPLACE_ID,
        our_price: [{ schedule: [{ value_with_tax: priceUsd }] }],
        ...(minBand != null
          ? { minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: minBand }] }] }
          : {}),
        ...(maxBand != null
          ? { maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: maxBand }] }] }
          : {}),
      },
    ];
    // The owner-approved launch model has no lower default B2B base. Quantity
    // discounts, if introduced later, are a separate reviewed policy.
    attrs.business_price = [
      {
        currency: "USD",
        marketplace_id: MARKETPLACE_ID,
        schedule: [{ value_with_tax: priceUsd }],
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
  // each_unit_count is not inferred. The live PTD defines it in terms of the
  // smallest UPC-bearing "each" and does not require it for these MFN DEFAULT
  // offers; preserve a reviewed rich-attribute value when one exists.
  // Shelf life and melting point are product facts, not category defaults.
  // Preserve reviewed values merged from sku.attributes above, but never invent
  // 365 days / 32°F when the canonical recipe has no authoritative evidence.
  // fulfillment_availability — makes the offer BUYABLE (merchant-fulfilled).
  // Without it the listing stays "Missing Information" (no fulfillment channel).
  if (sku.available_quantity != null && sku.available_quantity > 0) {
    attrs.fulfillment_availability = [
      {
        fulfillment_channel_code: "DEFAULT",
        quantity: sku.available_quantity,
        marketplace_id: MARKETPLACE_ID,
      },
    ];
  }

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
  physicalPackageSpecs?: VerifiedPhysicalPackageSpecs | null,
  verifiedAllergens?: string[] | null,
  verifiedExpiration?: VerifiedExpirationEvidence | null,
): Record<string, unknown> {
  return {
    productType,
    requirements: "LISTING",
    attributes: buildAmazonAttributes(
      sku,
      brand,
      category,
      physicalPackageSpecs,
      verifiedAllergens,
      verifiedExpiration,
    ),
  };
}

export async function submitToAmazon(
  input: AmazonPublishInput,
): Promise<AmazonPublishResult> {
  const productType = input.productType ?? "PRODUCT";
  const payload = buildAmazonPayload(
    input.sku,
    productType,
    input.brand,
    input.category,
    input.physicalPackageSpecs,
    input.verifiedAllergens,
    input.verifiedExpiration,
  );
  const payloadAttributes = payload.attributes as Record<string, unknown> | undefined;
  const payloadBrandRows = payloadAttributes?.brand;
  const payloadBrand =
    Array.isArray(payloadBrandRows) &&
    payloadBrandRows[0] &&
    typeof payloadBrandRows[0] === "object" &&
    typeof (payloadBrandRows[0] as { value?: unknown }).value === "string"
      ? ((payloadBrandRows[0] as { value: string }).value)
      : null;
  const payloadMainRows = payloadAttributes?.main_product_image_locator;
  const payloadMainImageUrl =
    Array.isArray(payloadMainRows) &&
    payloadMainRows[0] &&
    typeof payloadMainRows[0] === "object" &&
    typeof (payloadMainRows[0] as { media_location?: unknown }).media_location ===
      "string"
      ? (payloadMainRows[0] as { media_location: string }).media_location
      : "";
  const payloadTitleRows = payloadAttributes?.item_name;
  const payloadTitle =
    Array.isArray(payloadTitleRows) &&
    payloadTitleRows[0] &&
    typeof payloadTitleRows[0] === "object" &&
    typeof (payloadTitleRows[0] as { value?: unknown }).value === "string"
      ? ((payloadTitleRows[0] as { value: string }).value)
      : null;
  const uncrustablesListing =
    isOwnBrandPassthrough(input.brand) ||
    isOwnBrandPassthrough(payloadBrand) ||
    textSaysUncrustables(payloadTitle) ||
    textSaysUncrustables(input.sku.title);

  // A complete PUT replaces the listing contribution represented by this
  // payload. buildAmazonAttributes intentionally does not carry a launch Sale
  // Price, so using this generic path on an existing ASIN could silently remove
  // an active discounted_price schedule. New listings (no ASIN yet) may still
  // use the normal create path; every later Uncrustables mutation must use the
  // sealed surgical PATCH workflow with exact offer preservation/rollback.
  if (
    UNCRUSTABLES_EXISTING_LISTING_REQUIRES_SURGICAL_PATCH &&
    uncrustablesListing &&
    !input.dryRun &&
    Boolean(input.sku.asin?.trim())
  ) {
    return {
      ok: false,
      submission_id: null,
      amazon_status: null,
      payload,
      issues: [],
      error:
        "Existing Uncrustables ASINs require the sealed surgical PATCH workflow; generic PUT could erase Sale Price or coupon launch controls",
      dry_run: false,
    };
  }

  if (
    !input.physicalPackageSpecs ||
    !physicalPackageSpecsMatchSku(input.sku, input.physicalPackageSpecs)
  ) {
    return {
      ok: false,
      submission_id: null,
      amazon_status: null,
      payload,
      issues: [],
      error:
        "Exact operator-verified package weight and dimensions are required before Amazon submission",
      dry_run: Boolean(input.dryRun),
    };
  }

  const foodListing =
    uncrustablesListing ||
    /FROZEN|REFRIGERATED|CHILLED|SHELF|GROCERY|FOOD|DRY/i.test(
      input.category ?? "",
    );
  if (foodListing && input.verifiedAllergens == null) {
    return {
      ok: false,
      submission_id: null,
      amazon_status: null,
      payload,
      issues: [],
      error:
        "Reviewed structured manufacturer allergen declarations are required before Amazon food submission",
      dry_run: Boolean(input.dryRun),
    };
  }

  // Fail closed before VALIDATION_PREVIEW/PUT when the canonical own-brand
  // count is absent. In particular, never fall back to sku.price_cents: that
  // field may still contain the pre-repair generic economics result.
  if (uncrustablesListing) {
    const rows = payloadAttributes?.number_of_items;
    const count = Array.isArray(rows) && rows[0] && typeof rows[0] === "object"
      ? Number((rows[0] as { value?: unknown }).value)
      : NaN;
    if (!Number.isInteger(count) || count <= 0) {
      return {
        ok: false,
        submission_id: null,
        amazon_status: null,
        payload,
        issues: [],
        error:
          "Canonical Uncrustables pricing requires reviewed structured number_of_items",
        dry_run: Boolean(input.dryRun),
      };
    }
    const authenticityPermit = verifyUncrustablesMainPublishPermit(
      input.uncrustablesMainPermit,
      {
        sku: input.sku.sku,
        main_image_url: payloadMainImageUrl,
        pack_count: count,
      },
    );
    if (!authenticityPermit.valid) {
      return {
        ok: false,
        submission_id: null,
        amazon_status: null,
        payload,
        issues: [],
        error: `Uncrustables MAIN authenticity blocked: ${authenticityPermit.error ?? "invalid permit"}`,
        dry_run: Boolean(input.dryRun),
      };
    }
  }

  if (
    (input.sku.available_quantity ?? 0) <= 0 ||
    !inventoryIsFresh(input.sku.inventory_checked_at)
  ) {
    return {
      ok: false,
      submission_id: null,
      amazon_status: null,
      payload,
      issues: [],
      error: "Recent verified positive inventory is required before Amazon submission",
      dry_run: Boolean(input.dryRun),
    };
  }

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

  // Every real PUT is gated by a fresh VALIDATION_PREVIEW. Retries and UPC-burn
  // recovery are not exempt: schemas and stored attributes can change between
  // attempts, and a blind PUT can replace a previously healthy listing.
  if (AMAZON_VALIDATION_PREVIEW_REQUIRED) {
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
