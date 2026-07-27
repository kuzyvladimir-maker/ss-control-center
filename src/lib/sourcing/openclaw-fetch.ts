// OpenClaw fetcher — the source for MEMBER-GATED stores that no scraper can reach
// unauthenticated: BJ's (club membership) and Publix (store-selected). A persistent
// logged-in browser on the OpenClaw box (104.219.53.204) does the search and returns
// structured products; we map them to the same RetailOffer shape so the donor-catalog
// pipeline (QA, dedup, harvest) treats them like any other source.
//
// Contract (both sides must agree):
//   POST  $OPENCLAW_GROCERY_URL
//   Header: Authorization: Bearer $OPENCLAW_GROCERY_TOKEN
//   Body:   { "retailer": "bjs"|"publix"|"aldi", "query": "uncrustables", "zip": "33765" }
//   200:    { "ok": true, "offers": [ {
//             title, price (number), currency?, image (url), url (product url),
//             productId (retailer sku/id), packSize? (int), inStock? (bool)
//           } ] }
//
// Inert until OPENCLAW_GROCERY_URL + OPENCLAW_GROCERY_TOKEN exist, so shipping is safe.

import type { RetailOffer } from "./retail-fetch";

export type OpenClawRetailer = "bjs" | "publix" | "aldi";

export function openClawEnabled(): boolean {
  return !!(process.env.OPENCLAW_GROCERY_URL || "").trim() && !!(process.env.OPENCLAW_GROCERY_TOKEN || "").trim();
}

export async function openClawSearch(
  retailer: OpenClawRetailer,
  query: string,
  zip = "33765",
): Promise<{ creditsRemaining: number | null; offers: RetailOffer[]; trialExhausted: boolean }> {
  const url = (process.env.OPENCLAW_GROCERY_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const token = (process.env.OPENCLAW_GROCERY_TOKEN || "").trim().replace(/^['"]|['"]$/g, "");
  if (!url || !token) return { creditsRemaining: null, offers: [], trialExhausted: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ retailer, query, zip }),
      signal: AbortSignal.timeout(90000), // a real browser is slower than an API
    });
    if (!res.ok) throw new Error(`OPENCLAW_GROCERY_HTTP_${res.status}`);
    const j: any = await res.json();
    const raw: any[] = Array.isArray(j?.offers) ? j.offers : [];
    const observedAt = new Date().toISOString();
    const offers: RetailOffer[] = raw
      .filter((o) => o && o.productId && o.title)
      .map((o) => ({
        retailer,
        retailerProductId: String(o.productId),
        price: typeof o.price === "number" ? o.price : (o.price ? Number(String(o.price).replace(/[^0-9.]/g, "")) : null),
        currency: o.currency || "USD",
        inStock: typeof o.inStock === "boolean" ? o.inStock : null,
        productUrl: o.url || null,
        zip,
        localityEvidence: "zip_scoped",
        observedAt,
        title: String(o.title),
        description: o.description || null,
        keyFeatures: Array.isArray(o.keyFeatures) ? o.keyFeatures : [],
        imageUrls: o.image ? [String(o.image)] : (Array.isArray(o.images) ? o.images : []),
        packSizeSeen: typeof o.packSize === "number" ? o.packSize : null,
        isMarketplaceItem: false, // store's own shelf = first-party
        sellerName: retailer,
        sourceApi: "openclaw",
      } as RetailOffer));
    return { creditsRemaining: null, offers, trialExhausted: false };
  } catch (error) {
    throw new Error("OPENCLAW_GROCERY_SOURCE_FAILED", { cause: error });
  }
}
