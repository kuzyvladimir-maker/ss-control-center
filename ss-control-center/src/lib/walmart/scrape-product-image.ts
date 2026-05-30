/**
 * Walmart product image scraper.
 *
 * Walmart's Marketplace API doesn't expose product image URLs anywhere
 * (probed against /v3/items bulk + /v3/items/{sku} single — neither returns
 * an image field). To show thumbnails next to SKUs in the Procurement
 * "Снять с продажи" modal we scrape the `og:image` meta tag from the
 * public product page (walmart.com/ip/{itemId}).
 *
 * Anti-bot: Walmart 403s data-center IPs by default. We pass a full Chrome
 * header set (UA + sec-fetch-* + accept-language) which is enough to get
 * 200s from most consumer-facing CDN edges. If we still see 403s in
 * production, the only reliable fix is a residential-proxy service —
 * scraping is best-effort and the modal degrades to a placeholder
 * gracefully when imageUrl is null.
 *
 * Returns null on any failure (4xx/5xx, timeout, no og:image found).
 * Errors are logged with the status so we can diagnose from Vercel logs.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TIMEOUT_MS = 12_000;

const OG_IMAGE_RE = /property=["']og:image["']\s+content=["']([^"']+)["']/i;
// Fallback: Walmart sometimes encodes og:image inside the JSON __NEXT_DATA__
// blob instead of meta tags on certain page variants.
const NEXT_DATA_IMAGE_RE = /"thumbnailUrl"\s*:\s*"([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i;

export async function scrapeWalmartProductImage(
  itemId: string,
): Promise<string | null> {
  if (!itemId) return null;
  const url = `https://www.walmart.com/ip/${encodeURIComponent(itemId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Sec-Ch-Ua":
          '"Chromium";v="120", "Not(A:Brand";v="24", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(
        `[scrapeWalmartImage] ${itemId} → HTTP ${res.status} (${res.statusText}). ` +
          `Likely Walmart anti-bot block on this IP. URL: ${url}`,
      );
      return null;
    }
    const html = await res.text();
    const m =
      html.match(OG_IMAGE_RE) ??
      html.match(NEXT_DATA_IMAGE_RE);
    if (!m?.[1]) {
      // 200 OK but no og:image — likely captcha/blocked-content page.
      console.warn(
        `[scrapeWalmartImage] ${itemId} → 200 OK but no og:image found ` +
          `(html length ${html.length}; likely captcha page).`,
      );
      return null;
    }
    return m[1].split("?")[0] || null;
  } catch (err) {
    console.warn(
      `[scrapeWalmartImage] ${itemId} → exception:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
