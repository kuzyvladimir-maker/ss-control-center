/**
 * Walmart studio lane — the publishable shape of a deterministic Product Truth
 * draft.
 *
 * The Bundle Factory has two Walmart lanes and they are NOT the same product:
 *
 *   1. the frozen 1-2 SKU pilot (`walmart:new-sku`), whose evidence bundle is
 *      assembled and signed by the owner outside the app, and
 *   2. this studio lane, where the factory itself builds a listing from one
 *      exact canonical variant and the owner reviews it on screen.
 *
 * Everything below is derived from evidence the factory actually holds — the
 * canonical variant decision, the immutable content observation, the price
 * observation, and the SHA-256 of the image bytes it composed itself. Nothing
 * here asserts a fact the code cannot prove; the attestations the pilot lane
 * carries (seller-account health, category approvals, recall clearance,
 * GS1 registrant checks) are deliberately absent, and the prepublication
 * validator therefore does not run against this lane. See
 * `docs/wiki/walmart-bundle-factory-repair-2026-08-02.md`.
 */

import { createHash } from "node:crypto";

/** Marker written into ChannelSKU.attributes by the studio promote path. */
export const WALMART_STUDIO_LISTING_LANE = "WALMART_STUDIO_DRAFT" as const;

export const WALMART_STUDIO_LISTING_EVIDENCE_SCHEMA =
  "bundle-factory.walmart-studio-listing/1.0.0" as const;

/** Where the evidence record lives inside ChannelSKU.attributes. */
export const WALMART_STUDIO_LISTING_ATTRIBUTE_KEY = "walmart_studio_listing" as const;

/**
 * Declared sellable units per position, on every ship node.
 *
 * Owner decision 2026-08-02: "по умолчанию надо ставить на каждую позицию,
 * чтобы было по 50 единиц … потому что у нас все равно эта цифра условная, и
 * мы не имеем никогда складских остатков по факту, а просто покупаем этот
 * товар в момент продажи". The business is buy-to-order: nothing is stocked,
 * every order is purchased at retail when it arrives. A Veeqo stock lookup
 * therefore describes a warehouse we do not use and must not gate publication.
 */
export const WALMART_STUDIO_DECLARED_INVENTORY_UNITS = 50;

/** Handling time we promise Walmart for a buy-to-order item (business days). */
export const WALMART_STUDIO_FULFILLMENT_LAG_DAYS = 2;

/**
 * Walmart product types verified against the LIVE taxonomy
 * (GET /v3/items/taxonomy?feedType=MP_ITEM&version=5.0, store 1, 2026-08-02).
 * Keys are matched against the donor's own product name and flavor, so a
 * listing never inherits a product type from a sibling category. An unmatched
 * product yields null and the item-type validator reports exactly which
 * product needs a mapping — the factory never guesses a taxonomy slug.
 */
export const WALMART_STUDIO_PRODUCT_TYPES: ReadonlyArray<{
  product_type: string;
  category: string;
  match: RegExp;
}> = [
  {
    product_type: "Prepared & Packaged Soups",
    category: "Food & Beverage / Soups, Broths & Bouillon",
    match: /\b(soup|chowder|bisque|broth|bouillon)\b/i,
  },
];

export function resolveWalmartStudioProductType(
  input: { product_name: string; flavor?: string | null },
): string | null {
  const haystack = `${input.product_name} ${input.flavor ?? ""}`;
  for (const entry of WALMART_STUDIO_PRODUCT_TYPES) {
    if (entry.match.test(haystack)) return entry.product_type;
  }
  return null;
}

export interface WalmartStudioShippingPackage {
  package_weight_oz: number;
  package_length_in: number;
  package_width_in: number;
  package_height_in: number;
  basis: "ESTIMATED_FROM_EXACT_NET_MASS";
}

/**
 * Corrugated sizes we actually buy, smallest first. The estimator picks the
 * first box whose volume covers the packed goods; anything larger than the
 * ladder is refused rather than silently rounded down.
 */
const SHIPPING_BOX_LADDER: ReadonlyArray<[number, number, number]> = [
  [8, 6, 4],
  [9, 6, 6],
  [10, 8, 6],
  [12, 9, 6],
  [12, 12, 8],
  [14, 12, 10],
  [16, 14, 12],
  [18, 16, 14],
  [20, 16, 14],
  [24, 18, 16],
];

const GRAMS_PER_OZ = 28.349523125;
const ML_PER_CUBIC_INCH = 16.387064;
/** Retail packaging (can/jar/pouch) as a share of declared net contents. */
const RETAIL_TARE_FACTOR = 1.15;
/** Corrugated box + dunnage. */
const OUTER_PACKAGING_OZ = 6;
/** Cylinders in a box plus void fill — packed volume over net contents. */
const PACKED_VOLUME_FACTOR = 1.9;

/**
 * Declared shipping package for a homogeneous multipack.
 *
 * The weight starts from the manufacturer's exact declared net mass (Product
 * Truth `sizeBaseAmount`), so it is anchored on a real measurement rather than
 * a category average; tare and box allowances are the estimated part, which is
 * why the basis says so. The operator's Ship-specs form overrides all of it
 * with measured values, and those always win in promote-draft.
 */
export function estimateWalmartStudioShippingPackage(input: {
  sizeDimension: string;
  sizeBaseAmount: number;
  sizeBaseUnit: string;
  packCount: number;
}): WalmartStudioShippingPackage {
  if (
    input.sizeDimension !== "MASS" ||
    input.sizeBaseUnit !== "g" ||
    !Number.isFinite(input.sizeBaseAmount) ||
    input.sizeBaseAmount <= 0 ||
    !Number.isInteger(input.packCount) ||
    input.packCount <= 0
  ) {
    throw new Error(
      "Cannot declare a shipping package: Product Truth has no exact net mass in grams",
    );
  }
  const netGrams = input.sizeBaseAmount * input.packCount;
  const weightOz = netGrams / GRAMS_PER_OZ * RETAIL_TARE_FACTOR + OUTER_PACKAGING_OZ;
  // Soups, sauces and other packaged wet goods sit close to 1 g/ml; the factor
  // below carries the packing void, so a small density error cannot shrink the
  // chosen box by a whole ladder step.
  const packedCubicInches = netGrams / ML_PER_CUBIC_INCH * PACKED_VOLUME_FACTOR;
  const box = SHIPPING_BOX_LADDER.find(
    ([length, width, height]) => length * width * height >= packedCubicInches,
  );
  if (!box) {
    throw new Error(
      `No stocked shipping box holds ${Math.round(packedCubicInches)} cubic inches`,
    );
  }
  return {
    package_weight_oz: Math.round(weightOz * 10) / 10,
    package_length_in: box[0],
    package_width_in: box[1],
    package_height_in: box[2],
    basis: "ESTIMATED_FROM_EXACT_NET_MASS",
  };
}

/** True when this SKU was built by the studio lane rather than the pilot. */
export function isWalmartStudioLane(attributes: string | null | undefined): boolean {
  if (!attributes) return false;
  try {
    const parsed = JSON.parse(attributes) as { listing_lane?: unknown };
    return parsed?.listing_lane === WALMART_STUDIO_LISTING_LANE;
  } catch {
    return false;
  }
}

export interface WalmartStudioImageEvidence {
  role: "MAIN" | "SECONDARY";
  url: string;
  output_sha256: string;
  source_asset_sha256s: string[];
  represented_unit_count: number;
  construction_method:
    | "EXACT_SOURCE_ASSET"
    | "DETERMINISTIC_EXACT_PIXEL_MULTIPACK";
  exact_source_url: string;
}

export interface WalmartStudioListingEvidenceInput {
  sku: string;
  storeIndex: number;
  packCount: number;
  verifiedAt: Date;
  /** The exact Product Truth component the draft was built from. */
  component: Record<string, unknown>;
  images: WalmartStudioImageEvidence[];
  shippingTemplateId: string | null;
  fulfillmentCenterId: string | null;
  declaredQuantity: number;
}

/**
 * The lane's own evidence record. It restates, in one immutable place, the
 * chain a reviewer needs to see: which canonical variant the listing claims to
 * be, which observation the copy came from, which offer the cost came from,
 * and which bytes became the main image.
 */
export function buildWalmartStudioListingEvidence(
  input: WalmartStudioListingEvidenceInput,
): Record<string, unknown> {
  const component = input.component;
  const price = (component.price_evidence ?? null) as Record<string, unknown> | null;
  const main = input.images.find((image) => image.role === "MAIN");
  if (!main) throw new Error("studio listing evidence requires a MAIN image");
  if (main.represented_unit_count !== input.packCount) {
    throw new Error(
      `MAIN image represents ${main.represented_unit_count} units; the listing sells ${input.packCount}`,
    );
  }
  return {
    schema_version: WALMART_STUDIO_LISTING_EVIDENCE_SCHEMA,
    lane: WALMART_STUDIO_LISTING_LANE,
    listing_scope: {
      channel: "WALMART",
      store_index: input.storeIndex,
      sku: input.sku,
      pack_count: input.packCount,
    },
    verified_at: input.verifiedAt.toISOString(),
    identity: {
      canonical_variant_id: component.canonical_variant_id ?? null,
      variant_decision_id: component.variant_decision_id ?? null,
      donor_product_id: component.donor_product_id ?? null,
      matcher_version: component.matcher_version ?? null,
      matcher_implementation_sha256: component.matcher_implementation_sha256 ?? null,
      matcher_release_sha256: component.matcher_release_sha256 ?? null,
    },
    content: {
      role: component.content_role ?? null,
      observation_id: component.content_observation_id ?? null,
      source_url: component.content_source_url ?? null,
      captured_at: component.content_captured_at ?? null,
    },
    price: price
      ? {
          eligibility: price.eligibility ?? null,
          observation_id: price.observation_id ?? null,
          donor_offer_id: price.donor_offer_id ?? null,
          retailer: price.retailer ?? null,
          source_url: price.source_url ?? null,
          observed_at: price.observed_at ?? null,
          locality_evidence: price.locality_evidence ?? null,
          zip: price.zip ?? null,
          price_per_unit: price.price_per_unit ?? null,
        }
      : null,
    images: input.images.map((image) => ({
      role: image.role,
      url: image.url,
      output_sha256: image.output_sha256,
      source_asset_sha256s: image.source_asset_sha256s,
      represented_unit_count: image.represented_unit_count,
      construction_method: image.construction_method,
      exact_source_url: image.exact_source_url,
      generative_model_used: false,
      added_graphics_or_text_overlay: false,
      package_artwork_revision_id: packageArtworkRevisionId(
        image.source_asset_sha256s,
      ),
    })),
    offer: {
      shipping_template_id: input.shippingTemplateId,
      fulfillment_center_id: input.fulfillmentCenterId,
      fulfillment_lag_days: WALMART_STUDIO_FULFILLMENT_LAG_DAYS,
      declared_quantity: input.declaredQuantity,
      declared_quantity_basis: "BUY_TO_ORDER_DECLARED",
    },
  };
}

/**
 * Stable identifier for the packaging artwork a listing depicts: the digest of
 * the exact source packshot bytes. Two listings sharing this value show the
 * same printed package revision.
 */
export function packageArtworkRevisionId(sourceAssetSha256s: string[]): string {
  const digest = createHash("sha256")
    .update([...sourceAssetSha256s].sort().join("\n"))
    .digest("hex");
  return `par1:${digest}`;
}

/**
 * The public Walmart attribute block. `public_attributes` carries the quantity
 * trio Walmart's item spec requires and the recipe-content validator checks
 * against the canonical pack count.
 */
export function buildWalmartStudioPublicAttributes(input: {
  packCount: number;
  productType: string;
  countryOfOrigin: string;
  secondaryImageUrls: string[];
  fulfillmentCenterId: string | null;
  declaredQuantity: number;
}): Record<string, unknown> {
  return {
    lane: WALMART_STUDIO_LISTING_LANE,
    product_type: input.productType,
    country_of_origin_substantial_transformation: input.countryOfOrigin,
    secondary_image_urls: input.secondaryImageUrls,
    public_attributes: {
      // A homogeneous multipack of retail units: multipackQuantity retail
      // packages, one sellable item inside each.
      multipackQuantity: input.packCount,
      countPerPack: 1,
      count: input.packCount,
    },
    offer_handoff: {
      mode: "INLINE",
      quantity: input.declaredQuantity,
      fulfillment_center_id: input.fulfillmentCenterId,
      fulfillment_lag_time: WALMART_STUDIO_FULFILLMENT_LAG_DAYS,
    },
  };
}
