/**
 * Walmart product image scraper.
 *
 * Walmart's Marketplace API doesn't expose product image URLs anywhere
 * (probed against /v3/items bulk + /v3/items/{sku} single — neither returns
 * an image field). To show thumbnails next to SKUs in the Procurement
 * "Снять с продажи" modal we scrape the `og:image` meta tag from the
 * public product page (walmart.com/ip/{itemId}).
 *
 * Anti-bot guardrails:
 *   * Browser-y User-Agent (Walmart 403s/captchas obvious bots)
 *   * 10s timeout (some pages are slow to render)
 *   * Caller is expected to throttle concurrency (we recommend ≤4 in
 *     parallel — Walmart aggressively rate-limits scraping)
 *
 * Returns null on any failure (404, 403, timeout, no og:image found) so
 * the caller can gracefully fall back to "no thumbnail".
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TIMEOUT_MS = 10_000;

const OG_IMAGE_RE = /property=["']og:image["']\s+content=["']([^"']+)["']/i;

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
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      // 404 = product unpublished; 403 = bot wall — both → no image.
      return null;
    }
    const html = await res.text();
    const m = html.match(OG_IMAGE_RE);
    if (!m?.[1]) return null;
    // Walmart serves CDN URLs; strip query params for cleaner storage.
    return m[1].split("?")[0] || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
