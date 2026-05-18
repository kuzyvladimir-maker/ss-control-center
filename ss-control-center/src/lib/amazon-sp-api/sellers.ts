// Sellers API helpers.
//
// We use this in the Listing Audit scanner to look up each account's
// **selling partner id** (a 14-char identifier like A1B2C3D4E5F6G7).
// The Listings Items API requires it in the URL path:
//   GET /listings/2021-08-01/items/{sellerId}/{sku}
//
// Amazon's Sellers API does NOT return the sellerId directly — the
// previous implementation assumed `participation.sellerId` exists, but
// the actual response only has `participation.isParticipating` and
// `hasSuspendedListings`. So scans were silently failing with the
// misleading "No marketplace participation found" error.
//
// Resolution order (first hit wins):
//   1. AMAZON_SP_SELLER_ID_STORE{n} env var (explicit override).
//   2. Parse the seller id out of the `Invoicing_<digits>_<SELLERID>`
//      storeName on the US Invoicing Shadow Marketplace entry —
//      Amazon embeds the id there. This is the path that lets us
//      auto-discover the id without manual config for every account.
//   3. Throw with a clear message pointing at the env var.

import { spApiGet, MARKETPLACE_ID } from "./client";

interface MarketplaceParticipation {
  marketplace?: { id?: string; countryCode?: string; name?: string };
  participation?: { isParticipating?: boolean };
  storeName?: string;
}

const merchantTokenCache = new Map<number, string>();

function envSellerId(storeIndex: number): string | null {
  const v = process.env[`AMAZON_SP_SELLER_ID_STORE${storeIndex}`];
  return v && v.trim().length > 0 ? v.trim() : null;
}

// Amazon's "Amazon.com Invoicing Shadow Marketplace" entries carry a
// storeName like "Invoicing_1367520_A3C3AK1ZAR115H". The trailing
// alphanumeric token IS the selling partner id, and US shadow entries
// are auto-created for every US seller — so this is a reliable way
// to recover the id from the marketplaceParticipations response.
const SHADOW_STORE_NAME_RE = /^Invoicing_\d+_([A-Z0-9]{10,})$/;

function extractSellerIdFromParticipations(
  list: MarketplaceParticipation[],
): string | null {
  for (const p of list) {
    const name = p?.storeName ?? "";
    const m = name.match(SHADOW_STORE_NAME_RE);
    if (m) return m[1];
  }
  return null;
}

export async function getMerchantToken(storeIndex: number): Promise<string> {
  const cached = merchantTokenCache.get(storeIndex);
  if (cached) return cached;

  // 1. Explicit env override.
  const explicit = envSellerId(storeIndex);
  if (explicit) {
    merchantTokenCache.set(storeIndex, explicit);
    return explicit;
  }

  const storeId = `store${storeIndex}`;
  const resp = await spApiGet("/sellers/v1/marketplaceParticipations", {
    storeId,
  });

  const list: MarketplaceParticipation[] = Array.isArray(resp?.payload)
    ? resp.payload
    : Array.isArray(resp)
      ? resp
      : [];

  // 2. Parse shadow-marketplace storeName.
  const parsed = extractSellerIdFromParticipations(list);
  if (parsed) {
    merchantTokenCache.set(storeIndex, parsed);
    return parsed;
  }

  // 3. Verify US participation so the error message can distinguish
  //    "auth ok but not participating in US" from "auth ok, US present,
  //    but we couldn't find a seller id" — different fixes.
  const usParticipating = list.some(
    (p) =>
      p?.marketplace?.id === MARKETPLACE_ID &&
      p?.participation?.isParticipating !== false,
  );
  if (!usParticipating) {
    throw new Error(
      `store${storeIndex}: SP-API auth OK but no US marketplace ` +
        `(${MARKETPLACE_ID}) participation. Re-authorize the SP-API app ` +
        `for this account with United States selected in Seller Central.`,
    );
  }
  throw new Error(
    `store${storeIndex}: could not derive selling-partner-id from ` +
      `marketplaceParticipations response. Set AMAZON_SP_SELLER_ID_STORE${storeIndex} ` +
      `to the account's Merchant Token (Seller Central → Settings → ` +
      `Account Info → Your Merchant Token).`,
  );
}
