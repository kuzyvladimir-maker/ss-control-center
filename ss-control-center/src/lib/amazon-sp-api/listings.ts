// Listings Items API (2021-08-01) — helpers used by the Bundle Factory
// audit (read) and the Phase 2.6.1 disclaimer-injection pipeline (read
// + patch):
//
//   listSkus(storeIndex, sellerId, opts?)  — paginated SKU enumeration
//   getListing(storeIndex, sellerId, sku)  — full listing detail
//   patchListing(storeIndex, sellerId, sku, productType, patches, opts?)
//                                          — JSON-Patch update
//
// Rate limit per official Selling Partner docs: 5 req/sec, burst 10.
// Higher-level callers should add ~200 ms between requests.

import { spApiGet, spApiPatch, MARKETPLACE_ID } from "./client";

export interface ListingSummary {
  marketplaceId: string;
  asin?: string;
  productType?: string;
  conditionType?: string;
  status?: string[]; // "BUYABLE" | "DISCOVERABLE" | …
  itemName?: string;
  mainImage?: { link?: string; height?: number; width?: number };
  createdDate?: string;
  lastUpdatedDate?: string;
}

// Attributes are open-shape per product_type. We grab a few we know we
// need; everything else stays as `unknown` so we don't lock the type to
// today's GROCERY schema.
export interface ListingAttributes {
  item_name?: Array<{ value: string; marketplace_id?: string }>;
  brand?: Array<{ value: string; marketplace_id?: string }>;
  recommended_browse_nodes?: Array<{ value: string; marketplace_id?: string }>;
  main_product_image_locator?: Array<{
    media_location?: string;
    marketplace_id?: string;
  }>;
  bullet_point?: Array<{ value: string; marketplace_id?: string }>;
  product_description?: Array<{ value: string; marketplace_id?: string }>;
  [key: string]: unknown;
}

export interface ListingItem {
  sku: string;
  summaries?: ListingSummary[];
  attributes?: ListingAttributes;
  /** Live validation/suppression findings returned when `issues` is requested. */
  issues?: Array<{
    code?: string;
    message?: string;
    severity?: string;
    attributeNames?: string[];
    categories?: string[];
    [key: string]: unknown;
  }>;
  /** Offer/availability blocks are intentionally open-shape: Amazon varies
   *  them by product type and fulfillment channel. Audit callers persist the
   *  normalized fields they need without coupling this shared client to one
   *  schema revision. */
  offers?: unknown;
  fulfillmentAvailability?: unknown;
  procurement?: unknown;
}

export type ListingsIncludedData =
  | "summaries"
  | "attributes"
  | "issues"
  | "offers"
  | "fulfillmentAvailability"
  | "procurement";

export interface ListSkusOptions {
  pageSize?: number;
  pageToken?: string;
  includedData?: ListingsIncludedData[];
}

export interface GetListingOptions {
  includedData?: ListingsIncludedData[];
}

export interface ListSkusResponse {
  numberOfResults: number;
  items: ListingItem[];
  pagination?: { nextToken?: string };
}

export async function listSkus(
  storeIndex: number,
  sellerId: string,
  opts: ListSkusOptions = {},
): Promise<ListSkusResponse> {
  const params: Record<string, string> = {
    marketplaceIds: MARKETPLACE_ID,
    pageSize: String(opts.pageSize ?? 20),
    includedData: (opts.includedData ?? ["summaries"]).join(","),
  };
  if (opts.pageToken) params.pageToken = opts.pageToken;

  const resp = await spApiGet(
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
    { storeId: `store${storeIndex}`, params },
  );

  return {
    numberOfResults: Number(resp?.numberOfResults ?? 0),
    items: Array.isArray(resp?.items) ? (resp.items as ListingItem[]) : [],
    pagination: resp?.pagination,
  };
}

export async function getListing(
  storeIndex: number,
  sellerId: string,
  sku: string,
  opts: GetListingOptions = {},
): Promise<ListingItem> {
  const params: Record<string, string> = {
    marketplaceIds: MARKETPLACE_ID,
    includedData: (opts.includedData ?? ["summaries", "attributes"]).join(","),
  };
  const resp = await spApiGet(
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
    { storeId: `store${storeIndex}`, params },
  );
  // Single-item endpoint returns the listing directly (no items array).
  return { sku, ...(resp as Partial<ListingItem>) } as ListingItem;
}

export interface ListingPatch {
  op: "add" | "replace" | "delete" | "merge";
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value?: any;
}

export interface PatchListingOptions {
  /** When `true`, hits Amazon's VALIDATION_PREVIEW mode — no mutation,
   *  just confirmation the patch would be accepted. Used as a safety
   *  gate before the real PATCH in disclaimer-injection-execute. */
  validationPreview?: boolean;
  /** Marketplace IDs the patch applies to. Defaults to US Amazon.com. */
  marketplaceIds?: string;
}

/**
 * PATCH a listing's attributes via JSON-Patch operations. `productType`
 * must match what Amazon already has on the listing (fetch it via
 * `getListing` first or pass it through from a known source).
 *
 * Response shape (from Amazon):
 *   { sku, status: "ACCEPTED"|"INVALID"|..., submissionId, issues?: [...] }
 */
export async function patchListing(
  storeIndex: number,
  sellerId: string,
  sku: string,
  productType: string,
  patches: ListingPatch[],
  opts: PatchListingOptions = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const params: Record<string, string> = {
    marketplaceIds: opts.marketplaceIds ?? MARKETPLACE_ID,
  };
  if (opts.validationPreview) {
    params.mode = "VALIDATION_PREVIEW";
  }
  const body = { productType, patches };
  return spApiPatch(
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
    body,
    { storeId: `store${storeIndex}`, params },
  );
}

/** Extract the audit-relevant fields from a marketplace-specific listing
 *  detail. Picks the entry matching MARKETPLACE_ID from each multi-locale
 *  array, falling back to summaries when the attribute is missing. */
export function flattenListing(item: ListingItem): {
  asin: string;
  title: string;
  brand: string;
  browse_node: string | null;
  main_image_url: string | null;
  bullets: string[];
  description: string;
} {
  const summary =
    item.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ??
    item.summaries?.[0];

  const attrs = item.attributes ?? {};
  const pickAttr = <T extends { value: string; marketplace_id?: string }>(
    arr: T[] | undefined,
  ): string | null => {
    if (!arr || arr.length === 0) return null;
    const match = arr.find((a) => a.marketplace_id === MARKETPLACE_ID);
    return (match ?? arr[0])?.value ?? null;
  };

  const mainImage =
    attrs.main_product_image_locator?.find(
      (a) => a.marketplace_id === MARKETPLACE_ID,
    )?.media_location ??
    attrs.main_product_image_locator?.[0]?.media_location ??
    summary?.mainImage?.link ??
    null;

  return {
    asin: summary?.asin ?? "",
    title: pickAttr(attrs.item_name) ?? summary?.itemName ?? "",
    brand: pickAttr(attrs.brand) ?? "",
    browse_node: pickAttr(attrs.recommended_browse_nodes),
    main_image_url: mainImage,
    bullets: (attrs.bullet_point ?? [])
      .filter((b) => !b.marketplace_id || b.marketplace_id === MARKETPLACE_ID)
      .map((b) => b.value),
    description: pickAttr(attrs.product_description) ?? "",
  };
}
