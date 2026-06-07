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
import { patchListing } from "./listings";

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

// ─── setListingPrice ────────────────────────────────────────────────────
// Sets our standard ("our_price") listing price via the Listings Items API
// purchasable_offer attribute. productType must match the listing's existing
// product type (read it from the listing summary). value is the price of the
// item itself (NOT landed — shipping stays as configured on the offer).

export async function setListingPrice(
  storeIndex: number,
  sellerId: string,
  sku: string,
  productType: string,
  price: number,
  opts: { validationPreview?: boolean } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const patches = [
    {
      op: "replace" as const,
      path: "/attributes/purchasable_offer",
      value: [
        {
          marketplace_id: MARKETPLACE_ID,
          currency: "USD",
          our_price: [{ schedule: [{ value_with_tax: price }] }],
        },
      ],
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
