// Sellers API helpers.
//
// We use this in the Listing Audit scanner to look up each account's
// **selling partner id** (a 14-char identifier like A1B2C3D4E5F6G7).
// The Listings Items API requires it in the URL path:
//   GET /listings/2021-08-01/items/{sellerId}/{sku}
//
// Rather than adding 5 new env vars (AMAZON_SELLER_ID_STORE1 …), we
// fetch the seller id at run time from
//   GET /sellers/v1/marketplaceParticipations
// and cache it in-process for the lifetime of the scan.

import { spApiGet, MARKETPLACE_ID } from "./client";

interface MarketplaceParticipation {
  marketplace?: { id?: string };
  participation?: { isParticipating?: boolean; sellerId?: string };
  storeName?: string;
}

const merchantTokenCache = new Map<number, string>();

export async function getMerchantToken(storeIndex: number): Promise<string> {
  const cached = merchantTokenCache.get(storeIndex);
  if (cached) return cached;

  const storeId = `store${storeIndex}`;
  const resp = await spApiGet("/sellers/v1/marketplaceParticipations", {
    storeId,
  });

  const list: MarketplaceParticipation[] = Array.isArray(resp?.payload)
    ? resp.payload
    : Array.isArray(resp)
      ? resp
      : [];

  const match = list.find(
    (p) =>
      p?.marketplace?.id === MARKETPLACE_ID &&
      p?.participation?.isParticipating !== false,
  );

  const token = match?.participation?.sellerId;
  if (!token) {
    throw new Error(
      `No marketplace participation found for store${storeIndex} ` +
        `in marketplace ${MARKETPLACE_ID}`,
    );
  }
  merchantTokenCache.set(storeIndex, token);
  return token;
}
