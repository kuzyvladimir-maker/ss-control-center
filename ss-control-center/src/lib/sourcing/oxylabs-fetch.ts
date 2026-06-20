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

import type { RetailOffer } from "./retail-fetch";

export type OxylabsRetailer = "bjs" | "publix" | "aldi" | "instacart";

export function oxylabsCreds(): { user: string; pass: string } | null {
  const user = (process.env.OXYLABS_USERNAME || "").trim().replace(/^['"]|['"]$/g, "");
  const pass = (process.env.OXYLABS_PASSWORD || "").trim().replace(/^['"]|['"]$/g, "");
  return user && pass ? { user, pass } : null;
}

export function oxylabsEnabled(): boolean {
  return oxylabsCreds() != null;
}

// One Oxylabs Realtime query. `source: "universal"` scrapes an arbitrary URL and
// (with parse/render) returns the page content. Returns the raw result payload.
async function oxylabsQuery(body: Record<string, any>): Promise<any | null> {
  const creds = oxylabsCreds();
  if (!creds) return null;
  const auth = Buffer.from(`${creds.user}:${creds.pass}`).toString("base64");
  try {
    const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return j?.results?.[0] ?? null;
  } catch {
    return null;
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

// Search one Oxylabs retailer for a query. Same return contract as the other
// fetchers (creditsRemaining is N/A for Oxylabs → null).
export async function oxylabsSearch(
  retailer: OxylabsRetailer,
  query: string,
): Promise<{ creditsRemaining: number | null; offers: RetailOffer[]; trialExhausted: boolean }> {
  if (!oxylabsEnabled()) return { creditsRemaining: null, offers: [], trialExhausted: true };
  const result = await oxylabsQuery({ source: "universal", url: searchUrl(retailer, query), render: "html", parse: false });
  if (!result) return { creditsRemaining: null, offers: [], trialExhausted: false };
  return { creditsRemaining: null, offers: parseSearch(retailer, result), trialExhausted: false };
}
