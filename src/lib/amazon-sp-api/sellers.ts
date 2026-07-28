// Sellers API helpers.
//
// We use this in the Listing Audit scanner to look up each account's
// **selling partner id** for the US Amazon.com marketplace — a 14-char
// identifier like A3A7A0RDFUSGBS. The Listings Items API requires it
// in the URL path:
//   GET /listings/2021-08-01/items/{sellerId}/{sku}
//
// Per-marketplace sellerIds:
//   Each account has a DIFFERENT sellerId for every marketplace it
//   participates in (US Amazon.com / BR Amazon.com.br / MX Amazon.com.mx /
//   CA Amazon.ca / Amazon Pay / Non-Amazon Shop / Invoicing Shadow / etc).
//   The audit only scans US Amazon.com, so we always need the US sellerId.
//
// Resolution order (US sellerId only):
//   0. Verify the account participates in ATVPDKIKX0DER (US Amazon.com).
//      If not (account suspended, never authorized, removed by Amazon
//      enforcement), throw NoUSMarketplaceError so the scanner can
//      *skip* this account cleanly rather than report a hard error.
//   1. AMAZON_SP_SELLER_ID_STORE{n} env var (explicit override).
//   2. Parse the seller id out of the `Invoicing_<digits>_<SELLERID>`
//      storeName on the US Invoicing Shadow Marketplace entry —
//      Amazon embeds the US sellerId there. Auto-discovery path.
//   3. Throw with a clear message pointing at the env var.

import { spApiGet, MARKETPLACE_ID } from "./client";

interface MarketplaceParticipation {
  marketplace?: { id?: string; countryCode?: string; name?: string };
  participation?: { isParticipating?: boolean };
  storeName?: string;
}

/**
 * Thrown when an account has no active participation in US Amazon.com.
 * Scanner catches this specifically and treats the account as *skipped*
 * (not errored) — the typical cause is an Amazon-side suspension that
 * code can't fix; the account simply isn't auditable until restored.
 */
export class NoUSMarketplaceError extends Error {
  constructor(public readonly storeIndex: number) {
    super(
      `store${storeIndex}: no US Amazon.com (${MARKETPLACE_ID}) marketplace ` +
        `participation. Account is suspended, never authorized for US, or had ` +
        `its US membership removed by Amazon enforcement (e.g. trademark/IP).`,
    );
    this.name = "NoUSMarketplaceError";
  }
}

const merchantTokenCache = new Map<number, string>();

function envSellerId(storeIndex: number): string | null {
  const v = process.env[`AMAZON_SP_SELLER_ID_STORE${storeIndex}`];
  return v && v.trim().length > 0 ? v.trim() : null;
}

// Amazon's "Amazon.com Invoicing Shadow Marketplace" entries carry a
// storeName like "Invoicing_1367520_A3A7A0RDFUSGBS". The trailing
// alphanumeric token IS the selling partner id for US Amazon.com, and
// shadow entries are auto-created for every US seller — so this is a
// reliable way to recover the id from the marketplaceParticipations
// response without manual env-var config for every account.
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

export async function getMerchantToken(
  storeIndex: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const cached = merchantTokenCache.get(storeIndex);
  if (cached) return cached;

  const storeId = `store${storeIndex}`;

  // Always hit Sellers API first — even when an env var override is set
  // — so we can detect *missing* US participation (NoUSMarketplaceError)
  // before any downstream Listings call wastes a round trip and produces
  // a misleading 400/404. RETAILER after the 2026-05-17 suspension is
  // the motivating case: its env var still has the correct historical
  // sellerId, but US Amazon.com is no longer in the account's
  // participations response so the seller ID is useless.
  const resp = await spApiGet("/sellers/v1/marketplaceParticipations", {
    storeId,
    signal,
  });
  signal?.throwIfAborted();

  const list: MarketplaceParticipation[] = Array.isArray(resp?.payload)
    ? resp.payload
    : Array.isArray(resp)
      ? resp
      : [];

  const usParticipating = list.some(
    (p) =>
      p?.marketplace?.id === MARKETPLACE_ID &&
      p?.participation?.isParticipating !== false,
  );
  if (!usParticipating) {
    throw new NoUSMarketplaceError(storeIndex);
  }

  // US is active — prefer explicit env override, then auto-parse shadow.
  const explicit = envSellerId(storeIndex);
  if (explicit) {
    merchantTokenCache.set(storeIndex, explicit);
    return explicit;
  }

  const parsed = extractSellerIdFromParticipations(list);
  if (parsed) {
    merchantTokenCache.set(storeIndex, parsed);
    return parsed;
  }

  throw new Error(
    `store${storeIndex}: US Amazon.com participation present but could not ` +
      `derive selling-partner-id from marketplaceParticipations response ` +
      `(no Invoicing Shadow Marketplace entry). Set ` +
      `AMAZON_SP_SELLER_ID_STORE${storeIndex} to the account's US Merchant ` +
      `Token (Seller Central → Settings → Account Info → Your Merchant Token).`,
  );
}
