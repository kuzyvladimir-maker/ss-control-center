// Amazon Product Pricing helpers (Featured Offer repricer).
//
// We deliberately use the v0 Product Pricing endpoints, NOT the newer
// Featured Offer Expected Price (FOEP) 2022-05-01 batch — the FOEP endpoint
// returns 403 on our app (role not granted) while v0 listingOffers works
// today and carries everything we need:
//   • our own offer (MyOffer) with listing price + shipping
//   • every competing offer
//   • the Buy Box / Featured Offer landed price (Summary.BuyBoxPrices)
//
// Rate limits (per Selling Partner docs): getListingOffersBatch up to 20
// SKUs per call. Callers pace batches; see reprice-engine.ts.

import { spApiGet, spApiPost, MARKETPLACE_ID } from "./client";
import { patchListing, getListing } from "./listings";

// ─── getListingOffersBatch ──────────────────────────────────────────────
// Returns, per requested SKU, the parsed offers payload. Up to 20 SKUs.

export interface ParsedOffer {
  mine: boolean;
  isFeatured: boolean;
  isBuyBoxWinner: boolean;
  listingPrice: number; // price of the item itself
  shipping: number; // shipping component
  landed: number; // listing + shipping (what the buyer actually pays)
}

export interface SkuOffers {
  sku: string;
  ok: boolean;
  totalOfferCount: number;
  /** Featured Offer (Buy Box) landed price from Summary.BuyBoxPrices. */
  buyBoxLanded: number | null;
  offers: ParsedOffer[];
  error?: string;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseOffersPayload(sku: string, payload: any): SkuOffers {
  const summary = payload?.Summary ?? {};
  const buyBox = (summary?.BuyBoxPrices ?? [])[0];
  const buyBoxLanded =
    buyBox?.LandedPrice?.Amount != null
      ? num(buyBox.LandedPrice.Amount)
      : null;

  const offers: ParsedOffer[] = (payload?.Offers ?? []).map((o: any) => {
    const listingPrice = num(o?.ListingPrice?.Amount);
    const shipping = num(o?.Shipping?.Amount);
    return {
      mine: Boolean(o?.MyOffer),
      isFeatured: Boolean(o?.IsFeaturedMerchant),
      isBuyBoxWinner: Boolean(o?.IsBuyBoxWinner),
      listingPrice,
      shipping,
      landed: listingPrice + shipping,
    };
  });

  return {
    sku,
    ok: true,
    totalOfferCount: num(summary?.TotalOfferCount),
    buyBoxLanded,
    offers,
  };
}

export async function getListingOffersBatch(
  storeIndex: number,
  skus: string[],
): Promise<SkuOffers[]> {
  if (skus.length === 0) return [];
  if (skus.length > 20) {
    throw new Error(`getListingOffersBatch: max 20 SKUs, got ${skus.length}`);
  }

  const body = {
    requests: skus.map((sku) => ({
      uri: `/products/pricing/v0/listings/${encodeURIComponent(sku)}/offers`,
      method: "GET",
      MarketplaceId: MARKETPLACE_ID,
      ItemCondition: "New",
    })),
  };

  const resp = await spApiPost(
    "/batches/products/pricing/v0/listingOffers",
    body,
    { storeId: `store${storeIndex}` },
  );

  const responses: any[] = resp?.responses ?? [];
  // Amazon returns responses in request order; map positionally back to SKUs.
  return skus.map((sku, i) => {
    const r = responses[i];
    const code = r?.status?.statusCode;
    if (code !== 200) {
      return {
        sku,
        ok: false,
        totalOfferCount: 0,
        buyBoxLanded: null,
        offers: [],
        error: `status ${code ?? "?"}: ${r?.body?.errors?.[0]?.message ?? ""}`,
      };
    }
    const payload = r?.body?.payload ?? r?.body;
    return parseOffersPayload(sku, payload);
  });
}

// ─── purchasable_offer helpers ──────────────────────────────────────────
//
// `purchasable_offer` is ONE attribute holding EVERY offer entry: the consumer
// offer (`audience: "ALL"`), the business offer (`audience: "B2B"`), and the
// `minimum/maximum_seller_allowed_price` bounds that repricers (ChannelMAX,
// Amazon Automate Pricing) read. A JSON-Patch `replace` overwrites the WHOLE
// array — so a patch carrying only `our_price` silently DELETES the B2B offer
// and the price bounds.
//
// This bit us in practice: the Bundle Factory deliberately publishes a price
// band (see promote-draft) so ChannelMAX imports the bounds, and the first
// SP-API reprice wiped it. Always merge into the live offer.

/** Amazon price fields are `[{ schedule: [{ value_with_tax: N }] }]`. */
export function priceSchedule(value: number) {
  return [{ schedule: [{ value_with_tax: value }] }];
}

/** Amazon returns open-ended offers as `end_at: { value: null }`; echoing a null
 *  back fails validation, so drop any `{ value: null }` wrapper before re-sending. */
export function sanitizeOfferEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (v && typeof v === "object" && !Array.isArray(v) && (v as { value?: unknown }).value === null) continue;
    out[k] = v;
  }
  return out;
}

/** Rewrite ONLY the requested fields on the consumer (`audience: "ALL"`) offer,
 *  leaving every sibling entry — notably the B2B offer — untouched. */
export function mergePurchasableOffer(
  existing: unknown,
  next: { price?: number | null; minPrice?: number | null; maxPrice?: number | null; currency?: string },
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = Array.isArray(existing)
    ? (existing as Record<string, unknown>[]).map(sanitizeOfferEntry)
    : [];
  let idx = entries.findIndex((e) => e.audience === "ALL" || e.audience == null);
  if (idx < 0) {
    entries.push({ marketplace_id: MARKETPLACE_ID, currency: next.currency ?? "USD", audience: "ALL" });
    idx = entries.length - 1;
  }
  const target = { ...entries[idx] };
  if (next.currency) target.currency = next.currency;
  if (next.price != null) target.our_price = priceSchedule(next.price);
  if (next.minPrice != null) target.minimum_seller_allowed_price = priceSchedule(next.minPrice);
  if (next.maxPrice != null) target.maximum_seller_allowed_price = priceSchedule(next.maxPrice);
  entries[idx] = target;
  return entries;
}

// ─── setListingPrice ────────────────────────────────────────────────────
// Sets our standard ("our_price") listing price via the Listings Items API
// purchasable_offer attribute. productType must match the listing's existing
// product type (read it from the listing summary). value is the price of the
// item itself (NOT landed — shipping stays as configured on the offer).
//
// Reads the live offer first and MERGES, so repricing never destroys the price
// band or a B2B offer. Pass minPrice/maxPrice to move the band deliberately.

export async function setListingPrice(
  storeIndex: number,
  sellerId: string,
  sku: string,
  productType: string,
  price: number,
  opts: { validationPreview?: boolean; minPrice?: number; maxPrice?: number } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  let existing: unknown;
  try {
    const live = (await getListing(storeIndex, sellerId, sku)) as {
      attributes?: Record<string, unknown>;
    };
    existing = live?.attributes?.purchasable_offer;
  } catch {
    // Listing read failed — fall back to a fresh consumer offer rather than
    // aborting the reprice. (Bounds can't be preserved if we can't read them.)
    existing = undefined;
  }
  const patches = [
    {
      op: "replace" as const,
      path: "/attributes/purchasable_offer",
      value: mergePurchasableOffer(existing, {
        price,
        minPrice: opts.minPrice ?? null,
        maxPrice: opts.maxPrice ?? null,
      }),
    },
  ];
  return patchListing(storeIndex, sellerId, sku, productType, patches, {
    validationPreview: opts.validationPreview,
  });
}

// Re-export for a quick single-SKU read used by the diagnostic script.
export async function getListingOffersSingle(
  storeIndex: number,
  sku: string,
): Promise<SkuOffers> {
  const resp = await spApiGet(
    `/products/pricing/v0/listings/${encodeURIComponent(sku)}/offers`,
    {
      storeId: `store${storeIndex}`,
      params: { MarketplaceId: MARKETPLACE_ID, ItemCondition: "New" },
    },
  );
  return parseOffersPayload(sku, resp?.payload ?? resp);
}
