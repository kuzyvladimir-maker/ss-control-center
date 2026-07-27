/**
 * Versioned Walmart US policy controls layered on the canonical listing
 * contracts in `walmart-listing-contract.ts`.
 *
 * Static screening, Product Truth, live spec evidence and account/category
 * entitlements remain independent. A clean keyword scan never proves approval.
 */

import {
  PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA,
  WALMART_PREPUBLICATION_EVIDENCE_SCHEMA,
  WALMART_PUBLIC_CONTRACT_SCHEMA,
  computeProductTruthRecipeHash,
  parseWalmartListingAttributes,
  sha256WalmartJson,
  type ProductTruthListingManifest,
  type ProductTruthPriceEvidence,
  type ProductTruthRecipeComponentEvidence,
  type WalmartPrepublicationEvidence,
  type WalmartPublicListingContract,
} from "../walmart-listing-contract";

export {
  PRODUCT_TRUTH_LISTING_MANIFEST_SCHEMA,
  WALMART_PREPUBLICATION_EVIDENCE_SCHEMA,
  WALMART_PUBLIC_CONTRACT_SCHEMA,
  computeProductTruthRecipeHash,
  parseWalmartListingAttributes,
  sha256WalmartJson,
};
export type {
  ProductTruthListingManifest,
  ProductTruthPriceEvidence,
  ProductTruthRecipeComponentEvidence,
  WalmartPrepublicationEvidence,
  WalmartPublicListingContract,
};

export const WALMART_POLICY_VERSION =
  "walmart-us-prepublication/2026-07-23.4" as const;
export const WALMART_RECOMMENDED_MP_ITEM_SPEC_VERSION =
  "5.0.20260501-19_21_29-api" as const;
export const WALMART_ITEM_MATCH_SPEC_VERSION = "MP_ITEM_MATCHv4.2" as const;

export const WALMART_SPEC_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
export const WALMART_ACCOUNT_EVIDENCE_MAX_AGE_MS =
  30 * 24 * 60 * 60 * 1_000;
export const WALMART_SELLER_ACCOUNT_HEALTH_MAX_AGE_MS = 60 * 60 * 1_000;
export const WALMART_FULFILLMENT_EVIDENCE_MAX_AGE_MS =
  30 * 24 * 60 * 60 * 1_000;
export const WALMART_SKU_POLICY_REVIEW_MAX_AGE_MS =
  7 * 24 * 60 * 60 * 1_000;
export const WALMART_RECALL_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const WALMART_CATALOG_SEARCH_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const WALMART_PRICE_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** Internal SFF shipping control; not represented as a universal Walmart rule. */
export const SSCC_MIN_REMAINING_SHELF_LIFE_DAYS = 30;

export const WALMART_POLICY_SOURCES = [
  {
    id: "account-health-compliance",
    url: "https://marketplacelearn.walmart.com/guides/Getting%20started/Account%20settings/account-health-compliance-overview",
    source_updated_at: "2026-05-27",
  },
  {
    id: "prohibited-products-overview",
    url: "https://marketplacelearn.walmart.com/guides/Policies%20%26%20standards/Prohibited%20products%20%26%20brands/Prohibited-products-policy%3A-overview?locale=en-US",
    source_updated_at: "2026-06-05",
  },
  {
    id: "food-products",
    url: "https://marketplacelearn.walmart.com/guides/Prohibited-Products-Policy%3A-Food-products",
    source_updated_at: "2025-12-11",
  },
  {
    id: "product-claims",
    url: "https://marketplacelearn.walmart.com/guides/prohibited-products-policy-product-claims",
    source_updated_at: "2026-06-05",
  },
  {
    id: "recalled-products",
    url: "https://marketplacelearn.walmart.com/guides/Prohibited-products-policy%3A-recalled-products",
    source_updated_at: "2025-12-11",
  },
  {
    id: "restricted-illegal-products",
    url: "https://marketplacelearn.walmart.com/guides/Prohibited-products-policy%3A-restricted-and-illegal-products",
    source_updated_at: "2025-12-11",
  },
  {
    id: "product-details-policy",
    url: "https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content%2C%20imagery%2C%20and%20media/Product-Detail-Page%3A-overview",
    source_updated_at: "2026-05-21",
  },
  {
    id: "selling-privileges",
    url: "https://marketplacelearn.walmart.com/guides/Getting%20started/Getting%20ready%20to%20sell/selling-privileges",
    source_updated_at: "2026-03-20",
  },
  {
    id: "shipping-fulfillment-policy",
    url: "https://marketplacelearn.walmart.com/guides/Seller%20Fulfillment%20Services/Shipping%20methods/Shipping-and-fulfillment-policy",
    source_updated_at: "2026-07-02",
  },
  {
    id: "product-identifier-policy",
    url: "https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20setup/Choose-a-product-identifier",
    source_updated_at: "2025-06-05",
  },
  {
    id: "duplicate-listings-policy",
    url: "https://marketplacelearn.walmart.com/guides/Policies%20%26%20standards/Product%20listings/duplicate-listings-policy?locale=en-US",
    source_updated_at: "2025-12-10",
  },
  {
    id: "item-spec-versioning",
    url: "https://developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting",
    verified_at: "2026-07-22",
  },
  {
    id: "get-spec",
    url: "https://developer.walmart.com/us-marketplace/reference/getspec",
    verified_at: "2026-07-22",
  },
  {
    id: "item-search-spec-format",
    url: "https://developer.walmart.com/us-marketplace/docs/item-search-for-the-walmart-catalog",
    verified_at: "2026-07-22",
  },
  {
    id: "create-items-routing",
    url: "https://developer.walmart.com/us-marketplace/docs/create-items-on-walmartcom",
    verified_at: "2026-07-22",
  },
  {
    id: "full-item-setup",
    url: "https://developer.walmart.com/us-marketplace/docs/create-a-new-item-full-item-setup",
    verified_at: "2026-07-22",
  },
  {
    id: "image-guidelines",
    url: "https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content%2C%20imagery%2C%20and%20media/Product-detail-page%3A-Image-guidelines-%26-requirements?locale=en-US",
    source_updated_at: "2026-05-12",
  },
  {
    id: "pricing-rules",
    url: "https://marketplacelearn.walmart.com/guides/Catalog%20management/Price%20management/Pricing-rules",
    source_updated_at: "2025-12-12",
  },
  {
    id: "resold-products",
    url: "https://marketplacelearn.walmart.com/guides/prohibited-products-policy-resold-products",
    source_updated_at: "2026-02-12",
  },
  {
    id: "brand-privileges",
    url: "https://marketplacelearn.walmart.com/guides/brand-manager-manage-brand-privileges",
    source_updated_at: "2025-10-28",
  },
] as const;

export type WalmartApprovalScope =
  | "INGESTIBLE_PRODUCTS"
  | "TOPICAL_PRODUCTS"
  | "MEDICAL_DEVICES"
  | "FRAGRANCES"
  | "LUXURY_BRANDS"
  | "SOFTWARE"
  | "SEASONAL_PRODUCTS"
  | "CUSTOM_CONTENT"
  | "JEWELRY_PRECIOUS_GOODS"
  | "PET"
  | "BABY";

export interface WalmartStaticPolicySignal {
  id: string;
  label: string;
  disposition: "PROHIBITED" | "REQUIRES_APPROVAL";
  approval_scope?: WalmartApprovalScope;
  regex: RegExp;
}

/** Narrow, high-confidence screen. Complete policy review is separate evidence. */
export const WALMART_STATIC_POLICY_SIGNALS: readonly WalmartStaticPolicySignal[] = [
  {
    id: "tobacco-nicotine-vape",
    label: "tobacco, nicotine, cigarette or vaping product",
    disposition: "PROHIBITED",
    regex: /\b(?:tobacco|nicotine|cigarettes?|e-?cigarettes?|vapes?|vaping)\b/i,
  },
  {
    id: "cannabis-cbd-thc",
    label: "cannabis, CBD or THC product",
    disposition: "PROHIBITED",
    regex: /\b(?:cannabis|cannabidiol|cbd|delta[- ]?8|delta[- ]?9|thc)\b/i,
  },
  {
    id: "unpasteurized-dairy",
    label: "raw or unpasteurized milk/dairy",
    disposition: "PROHIBITED",
    regex: /\b(?:raw\s+milk|unpasteuri[sz]ed\s+(?:milk|dairy))\b/i,
  },
  {
    id: "dietary-supplement",
    label: "dietary supplement",
    disposition: "REQUIRES_APPROVAL",
    approval_scope: "INGESTIBLE_PRODUCTS",
    regex: /\b(?:dietary\s+supplement|nutritional\s+supplement|supplement\s+facts)\b/i,
  },
  {
    id: "pet-ingestible",
    label: "pet food or pet supplement",
    disposition: "REQUIRES_APPROVAL",
    approval_scope: "PET",
    regex: /\b(?:dog|cat|pet)\s+(?:food|treats?|supplements?)\b/i,
  },
  {
    id: "baby-ingestible",
    label: "baby formula or baby food",
    disposition: "REQUIRES_APPROVAL",
    approval_scope: "BABY",
    regex: /\b(?:infant|baby)\s+(?:formula|food)\b/i,
  },
] as const;

export interface ParsedWalmartAttributes {
  root: Record<string, unknown>;
  walmart: WalmartPublicListingContract | null;
  product_truth_manifest: ProductTruthListingManifest | null;
  walmart_prepublication: WalmartPrepublicationEvidence | null;
  errors: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordArray(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every(isRecord) ? value : null;
}

export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function isHttpUrl(value: unknown): value is string {
  if (!hasText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Pilot-safe subset of Walmart's current image URL contract. Walmart also
 * accepts BMP and some HTTP URLs, but the first pilot intentionally stays on
 * JPEG/PNG over credential-free HTTPS so the local format/dimension gates can
 * verify every published image deterministically. */
export function isWalmartPilotImageUrl(value: unknown): value is string {
  if (!hasText(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443" || url.port === "8443") &&
      !url.search &&
      !url.hash &&
      /\.(?:jpe?g|png)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isPastIsoDate(value: unknown, nowMs = Date.now()): boolean {
  if (!hasText(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= nowMs + 5 * 60_000;
}

export function isFreshIsoDate(
  value: unknown,
  maxAgeMs: number,
  nowMs = Date.now(),
): boolean {
  if (!isPastIsoDate(value, nowMs)) return false;
  return nowMs - Date.parse(String(value)) <= maxAgeMs;
}

export function parseWalmartAttributes(attributes: string): ParsedWalmartAttributes {
  const errors: string[] = [];
  let root: Record<string, unknown> = {};
  try {
    root = parseWalmartListingAttributes(attributes);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const walmart = isRecord(root.walmart)
    ? root.walmart as unknown as WalmartPublicListingContract
    : null;
  const productTruth = isRecord(root.product_truth_manifest)
    ? root.product_truth_manifest as unknown as ProductTruthListingManifest
    : null;
  const prepublication = isRecord(root.walmart_prepublication)
    ? root.walmart_prepublication as unknown as WalmartPrepublicationEvidence
    : null;
  if (!walmart) errors.push("attributes.walmart is missing or not an object");
  if (!productTruth) errors.push("attributes.product_truth_manifest is missing or not an object");
  if (!prepublication) errors.push("attributes.walmart_prepublication is missing or not an object");
  return {
    root,
    walmart,
    product_truth_manifest: productTruth,
    walmart_prepublication: prepublication,
    errors,
  };
}

export function getPath(root: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split(".").filter(Boolean)) {
    if (!isRecord(cursor) || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

export function isMissingRequiredValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function isIngestibleProduct(args: {
  category?: string | null;
  itemType?: string | null;
  components?: Array<{
    ingredients?: string | null;
    expiration_days?: number | null;
  }>;
}): boolean {
  const text = `${args.category ?? ""} ${args.itemType ?? ""}`.toLowerCase();
  if (
    /(?:food|grocery|snack|meal|lunch|beverage|drink|coffee|tea|candy|chocolate|basket|sauce|condiment|bakery)/
      .test(text)
  ) return true;
  return (args.components ?? []).some(
    (component) =>
      hasText(component.ingredients) ||
      (typeof component.expiration_days === "number" && component.expiration_days > 0),
  );
}
