// Listings Items API (2021-08-01) — read helpers used by the Bundle
// Factory listing audit. We only implement the bits the audit needs:
//
//   listSkus(storeIndex, sellerId, opts?) — paginated SKU enumeration
//   getListing(storeIndex, sellerId, sku) — full listing detail
//
// Patch / write operations live in remediation.ts later; the audit
// scanner is strictly read-only.
//
// Rate limit per official Selling Partner docs: 5 req/sec, burst 10.
// Higher-level callers should add ~200 ms between requests.

import { spApiGet, MARKETPLACE_ID } from "./client";

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
}

export interface ListSkusOptions {
  pageSize?: number;
  pageToken?: string;
  includedData?: Array<"summaries" | "attributes" | "issues" | "offers">;
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
): Promise<ListingItem> {
  const params: Record<string, string> = {
    marketplaceIds: MARKETPLACE_ID,
    includedData: "summaries,attributes",
  };
  const resp = await spApiGet(
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
    { storeId: `store${storeIndex}`, params },
  );
  // Single-item endpoint returns the listing directly (no items array).
  return { sku, ...(resp as Partial<ListingItem>) } as ListingItem;
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
