// Oxylabs fetcher — covers the membership-club / supermarket retailers that
// BlueCart and Unwrangle don't: BJ's, Publix, Aldi (direct), plus INSTACART as a
// universal fallback (one source, many stores). Returns the same RetailOffer shape
// as retail-fetch so the donor-catalog orchestrator treats every source uniformly.
//
// Auth: Oxylabs Realtime API (Basic auth, OXYLABS_USERNAME / OXYLABS_PASSWORD).
// Inert until those env vars exist, so shipping this is safe before the sub is paid.
//
// IMPORTANT: the per-site field extraction below is a FIRST PASS. Oxylabs returns
// raw HTML/JSON that differs per site and changes over time — the selectors must be
// CALIBRATED against live responses once the key is active (see calibrateOxylabs()).

import { extractPackSize, type RetailOffer } from "./retail-fetch";
import {
  throwIfMeteredProviderControlError,
  withMeteredProviderCall,
  type MeteredProviderAuthorization,
} from "./metered-provider-call";
import { PRODUCT_TRUTH_PROCUREMENT_ZIP } from "./price-evidence-policy";

export type OxylabsRetailer = "bjs" | "publix" | "aldi" | "instacart";

export function oxylabsCreds(): { user: string; pass: string } | null {
  const user = (process.env.OXYLABS_USERNAME || "").trim().replace(/^['"]|['"]$/g, "");
  const pass = (process.env.OXYLABS_PASSWORD || "").trim().replace(/^['"]|['"]$/g, "");
  return user && pass ? { user, pass } : null;
}

export function oxylabsEnabled(): boolean {
  return oxylabsCreds() != null;
}

export interface OxylabsWalmartLocalityProof {
  requestedZip: string | null;
  responseZip: string | null;
  localityProven: boolean;
}

function normalizeUsZip(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{5})(?:-\d{4})?$/);
  return match?.[1] ?? null;
}

/**
 * Prove Walmart localization from the parsed provider response, never from the
 * requested parameter. Oxylabs documents that Walmart can silently fall back to
 * default results when localization fails, so `delivery_zip=33765` alone is not
 * evidence that the returned price or stock belongs to Clearwater.
 *
 * `zip_code` is the documented key; `zipcode` is accepted because it appears in
 * older structured-response examples from the same provider.
 */
export function proveOxylabsWalmartLocality(
  result: unknown,
  requestedZip: unknown = PRODUCT_TRUTH_PROCUREMENT_ZIP,
): OxylabsWalmartLocalityProof {
  const requested = normalizeUsZip(requestedZip);
  const content = result && typeof result === "object"
    ? (result as { content?: unknown }).content
    : null;
  const location = content && typeof content === "object"
    ? (content as { location?: unknown }).location
    : null;
  const locationRecord = location && typeof location === "object"
    ? location as { zip_code?: unknown; zipcode?: unknown }
    : null;
  const responseZip = normalizeUsZip(
    locationRecord?.zip_code ?? locationRecord?.zipcode,
  );

  return {
    requestedZip: requested,
    responseZip,
    localityProven: requested !== null && responseZip !== null && responseZip === requested,
  };
}

/** Require an explicit Walmart availability signal; missing fields are unknown. */
export function inferOxylabsWalmartInStock(item: unknown): boolean | null {
  if (!item || typeof item !== "object") return null;
  const record = item as {
    general?: { out_of_stock?: unknown };
    fulfillment?: { pickup?: unknown; delivery?: unknown; shipping?: unknown };
  };
  if (record.general?.out_of_stock === true) return false;
  if (record.general?.out_of_stock === false) return true;

  const flags = [
    record.fulfillment?.pickup,
    record.fulfillment?.delivery,
    record.fulfillment?.shipping,
  ].filter((value): value is boolean => typeof value === "boolean");
  if (!flags.length) return null;
  return flags.some(Boolean);
}

// One Oxylabs Realtime query. `source: "universal"` scrapes an arbitrary URL and
// (with parse/render) returns the page content. Returns the raw result payload.
type OxylabsQueryResult = {
  result: any | null;
  authorization: MeteredProviderAuthorization | null;
};

async function oxylabsQuery(body: Record<string, any>): Promise<OxylabsQueryResult> {
  const creds = oxylabsCreds();
  if (!creds) return { result: null, authorization: null };
  const auth = Buffer.from(`${creds.user}:${creds.pass}`).toString("base64");
  let authorization: MeteredProviderAuthorization | null = null;
  try {
    const result = await withMeteredProviderCall(
      {
        provider: "oxylabs",
        operation: "query",
        requestFingerprint: body,
        onAuthorized: (value) => { authorization = value; },
      },
      async () => {
        const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) throw new Error(`Oxylabs HTTP ${res.status}`);
        const j: any = await res.json();
        return j?.results?.[0] ?? null;
      },
    );
    return { result, authorization };
  } catch (error) {
    throwIfMeteredProviderControlError(error);
    throw new Error("OXYLABS_SOURCE_FAILED", { cause: error });
  }
}

// Map a retailer + query to the search URL Oxylabs should scrape. Clearwater FL
// (zip 33765) context where the site supports it; finalize per site with the key.
function searchUrl(retailer: OxylabsRetailer, query: string): string {
  const q = encodeURIComponent(query);
  switch (retailer) {
    case "bjs": return `https://www.bjs.com/search/${q}`;
    case "publix": return `https://www.publix.com/search?query=${q}`;
    case "aldi": return `https://www.aldi.us/results?q=${q}`;
    case "instacart": return `https://www.instacart.com/store/s?k=${q}`;
  }
}

// Pull the biggest embedded JSON blob from a scraped page (Next.js __NEXT_DATA__,
// Apollo/Redux state, or JSON-LD). Most of these sites are React apps that ship
// their product data as JSON in the HTML — far more stable than CSS selectors.
function extractEmbeddedJson(html: string): any[] {
  const blobs: any[] = [];
  const tryPush = (s?: string | null) => { if (!s) return; try { blobs.push(JSON.parse(s)); } catch { /* */ } };
  tryPush(html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1]);
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) tryPush(m[1]);
  return blobs;
}

// Parse a scraped search page into offers. FIRST PASS — calibrate per site once the
// key is live; until then it returns [] rather than guessing wrong prices.
function parseSearch(retailer: OxylabsRetailer, result: any): RetailOffer[] {
  const html = typeof result?.content === "string" ? result.content : "";
  if (!html) return [];
  const blobs = extractEmbeddedJson(html);
  void blobs; // TODO(calibrate): walk the embedded JSON for product name/price/image/url/upc
  return [];
}

// ── Walmart via Oxylabs STRUCTURED source ────────────────────────────────────
// Oxylabs' dedicated `walmart_search` source returns PARSED product data (no HTML
// scraping / calibration needed): general.{title,image,url,product_id},
// price.price, seller.name. seller.name === "Walmart.com" ⇒ first-party (1P).
// This is the proper, fast (~5-7s) direct walmart.com read — the Walmart donor
// source (BlueCart is dropped; Unwrangle-walmart was slow and 3P-skewed).
export async function oxylabsWalmartSearch(
  query: string,
): Promise<{
  creditsRemaining: number | null;
  offers: RetailOffer[];
  trialExhausted: boolean;
  responseZip: string | null;
  localityProven: boolean;
}> {
  if (!oxylabsEnabled()) {
    return {
      creditsRemaining: null,
      offers: [],
      trialExhausted: true,
      responseZip: null,
      localityProven: false,
    };
  }
  const queryResult = await oxylabsQuery({
    source: "walmart_search",
    query,
    parse: true,
    delivery_zip: PRODUCT_TRUTH_PROCUREMENT_ZIP,
  });
  const { result, authorization } = queryResult;
  const locality = proveOxylabsWalmartLocality(result);
  const raw = result?.content?.results;
  if (!raw) {
    return {
      creditsRemaining: null,
      offers: [],
      trialExhausted: false,
      responseZip: locality.responseZip,
      localityProven: locality.localityProven,
    };
  }
  const observedAt = new Date().toISOString();
  const items = (Array.isArray(raw) ? raw : Object.values(raw)).filter((x: any) => x && typeof x === "object");
  const offers: RetailOffer[] = [];
  for (const it of items as any[]) {
    const g = it.general || {};
    const title: string = g.title || "";
    const img: string = g.image || "";
    if (!title || typeof img !== "string" || !img.startsWith("http")) continue;
    const sellerName: string | null = it.seller?.name ?? null;
    const url = g.url ? (String(g.url).startsWith("http") ? String(g.url) : `https://www.walmart.com${g.url}`) : null;
    offers.push({
      retailer: "walmart",
      retailerProductId: String(g.product_id || url || ""),
      price: it.price?.price ?? null,
      currency: it.price?.currency || "USD",
      inStock: inferOxylabsWalmartInStock(it),
      productUrl: url,
      zip: locality.localityProven ? locality.responseZip : null,
      localityEvidence: locality.localityProven ? "zip_scoped" : "national_unscoped",
      observedAt,
      title,
      description: null,
      keyFeatures: [],
      imageUrls: [img.split("?")[0]],
      packSizeSeen: extractPackSize(title),
      // 1P iff sold by Walmart.com itself; any other seller name is 3P (rule #8).
      isMarketplaceItem: sellerName ? !/^walmart\.com$/i.test(sellerName.trim()) : null,
      sellerName,
      sourceApi: "oxylabs",
      ...(authorization ? {
        meteredReceiptId: authorization.receiptId,
        meteredRunId: authorization.runId,
        meteredApprovalId: authorization.approvalId,
      } : {}),
    } as RetailOffer);
  }
  return {
    creditsRemaining: null,
    offers,
    trialExhausted: false,
    responseZip: locality.responseZip,
    localityProven: locality.localityProven,
  };
}

// ── Google Shopping via Oxylabs STRUCTURED source ────────────────────────────
// The UNIVERSAL price fallback: when a product isn't cleanly first-party at
// Walmart/Target/Publix, Google Shopping almost always has it. Returns market
// offers (organic results) with a real numeric price + merchant name. These are
// used as an ESTIMATE (tagged google-est downstream), never as a claimed 1P shelf
// price — but they guarantee EVERY SKU gets some cost. No iMac / browser needed.
export async function oxylabsGoogleShoppingSearch(
  query: string,
): Promise<{ offers: RetailOffer[] }> {
  if (!oxylabsEnabled()) return { offers: [] };
  const { result, authorization } = await oxylabsQuery({
    source: "google_shopping_search", query, parse: true,
  });
  const organic = result?.content?.results?.organic;
  const items = Array.isArray(organic) ? organic : [];
  const offers: RetailOffer[] = [];
  const observedAt = new Date().toISOString();
  for (const it of items as any[]) {
    const title: string = it?.title || "";
    const price = typeof it?.price === "number" ? it.price : null;
    if (!title || price == null || price <= 0) continue;
    offers.push({
      retailer: "google",
      retailerProductId: String(it.product_id || it.url || title),
      price,
      currency: it.currency || "USD",
      inStock: true,
      productUrl: typeof it.url === "string" ? it.url : null,
      zip: null,
      localityEvidence: "national_unscoped",
      observedAt,
      title,
      description: null,
      keyFeatures: [],
      // Google thumbnails come back as base64 data-URIs (not URLs) → skip for content.
      imageUrls: typeof it.thumbnail === "string" && it.thumbnail.startsWith("http") ? [it.thumbnail] : [],
      packSizeSeen: extractPackSize(title),
      isMarketplaceItem: null,
      sellerName: it.merchant?.name ?? null,
      sourceApi: "oxylabs-google",
      ...(authorization ? {
        meteredReceiptId: authorization.receiptId,
        meteredRunId: authorization.runId,
        meteredApprovalId: authorization.approvalId,
      } : {}),
    } as RetailOffer);
  }
  return { offers };
}

// Search one Oxylabs retailer for a query. Same return contract as the other
// fetchers (creditsRemaining is N/A for Oxylabs → null).
export async function oxylabsSearch(
  retailer: OxylabsRetailer,
  query: string,
): Promise<{ creditsRemaining: number | null; offers: RetailOffer[]; trialExhausted: boolean }> {
  if (!oxylabsEnabled()) return { creditsRemaining: null, offers: [], trialExhausted: true };
  const { result, authorization } = await oxylabsQuery({
    source: "universal", url: searchUrl(retailer, query), render: "html", parse: false,
  });
  if (!result) return { creditsRemaining: null, offers: [], trialExhausted: false };
  const offers = parseSearch(retailer, result).map((offer) => ({
    ...offer,
    ...(authorization ? {
      meteredReceiptId: authorization.receiptId,
      meteredRunId: authorization.runId,
      meteredApprovalId: authorization.approvalId,
    } : {}),
  }));
  return { creditsRemaining: null, offers, trialExhausted: false };
}
