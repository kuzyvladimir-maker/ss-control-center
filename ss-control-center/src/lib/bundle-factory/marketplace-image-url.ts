/**
 * The image URL we hand to a marketplace.
 *
 * Our images live in R2 and were addressed by its `*.r2.dev` development
 * hostname. Walmart could not download from it — `ERR_EXT_DATA_0101171`, host
 * blocked — so the same object is addressed through our own domain instead.
 *
 * Only OUR urls are rewritten. Donor images already hosted by Walmart or a
 * manufacturer CDN are left exactly as they are: they are reachable, and
 * proxying someone else's asset through our domain would be pointless traffic.
 */

const R2_DEV_HOST = /^https:\/\/pub-[a-z0-9]+\.r2\.dev\//i;

/**
 * Where marketplaces should fetch our images from.
 *
 * Falls back to the production domain because that is what the marketplace has
 * to be able to reach — a preview deployment URL would 404 for them the moment
 * it is superseded.
 */
function publicBaseUrl(): string {
  const configured = process.env.PUBLIC_IMAGE_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return "https://salutemsolutions.info";
}

/**
 * Rewrite an R2 development URL onto our own domain, byte-identical.
 *
 * Anything else — a donor CDN, an already-rewritten URL, an empty value — is
 * returned untouched.
 */
export function marketplaceImageUrl(url: string | null | undefined): string {
  const value = (url ?? "").trim();
  if (!value) return value;
  const match = value.match(R2_DEV_HOST);
  if (!match) return value;
  const key = value.slice(match[0].length);
  if (!key) return value;
  return `${publicBaseUrl()}/api/public-image/${key}`;
}

export function marketplaceImageUrls(
  urls: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  return (urls ?? [])
    .map((url) => marketplaceImageUrl(url))
    .filter((url): url is string => Boolean(url));
}
