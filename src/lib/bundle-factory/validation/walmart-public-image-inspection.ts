import sharp from "sharp";

export const WALMART_PILOT_IMAGE_MIN_PIXELS = 2200;
export const WALMART_PILOT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
]);

export interface VerifiedWalmartPublicImage {
  url: string;
  format: "jpeg" | "png";
  width: number;
  height: number;
  byte_size: number;
}

function assertPublicImageUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost")
  ) {
    throw new Error(`Walmart image URL is not a query-free public HTTPS URL: ${raw}`);
  }
  const normalizedHost = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(normalizedHost) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(normalizedHost) ||
    normalizedHost === "::1" ||
    (normalizedHost.includes(":") &&
      (normalizedHost.startsWith("fc") ||
        normalizedHost.startsWith("fd") ||
        normalizedHost.startsWith("fe80:")))
  ) {
    throw new Error(`Walmart image URL cannot target a private address: ${raw}`);
  }
  if (!/\.(?:jpe?g|png)$/i.test(url.pathname)) {
    throw new Error(`Walmart pilot image URL must end in .jpg, .jpeg or .png: ${raw}`);
  }
  return url;
}

async function readBoundedBody(response: Response, url: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > WALMART_PILOT_IMAGE_MAX_BYTES) {
    throw new Error(`Walmart image exceeds 5 MB: ${url}`);
  }
  if (!response.body) throw new Error(`Walmart image response has no body: ${url}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > WALMART_PILOT_IMAGE_MAX_BYTES) {
        await reader.cancel();
        throw new Error(`Walmart image exceeds 5 MB while downloading: ${url}`);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error(`Walmart image is empty: ${url}`);
  if (Number.isFinite(declared) && declared !== total) {
    throw new Error(`Walmart image Content-Length does not match received bytes: ${url}`);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function inspectWalmartPublicImage(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedWalmartPublicImage> {
  const url = assertPublicImageUrl(rawUrl);
  const response = await fetchImpl(url.toString(), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    headers: { Accept: "image/jpeg,image/png" },
  });
  if (!response.ok) {
    throw new Error(`Walmart image GET returned HTTP ${response.status}: ${rawUrl}`);
  }
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Walmart image has unsupported Content-Type ${contentType || "missing"}: ${rawUrl}`);
  }
  const bytes = await readBoundedBody(response, rawUrl);
  const metadata = await sharp(bytes, { failOn: "warning" }).metadata();
  if (
    (metadata.format !== "jpeg" && metadata.format !== "png") ||
    !metadata.width ||
    !metadata.height
  ) {
    throw new Error(`Walmart image bytes are not a decodable JPEG/PNG: ${rawUrl}`);
  }
  if (metadata.width !== metadata.height) {
    throw new Error(`Walmart image must be square; got ${metadata.width}x${metadata.height}: ${rawUrl}`);
  }
  if (
    metadata.width < WALMART_PILOT_IMAGE_MIN_PIXELS ||
    metadata.height < WALMART_PILOT_IMAGE_MIN_PIXELS
  ) {
    throw new Error(
      `Walmart image must be at least ${WALMART_PILOT_IMAGE_MIN_PIXELS}x${WALMART_PILOT_IMAGE_MIN_PIXELS}; ` +
      `got ${metadata.width}x${metadata.height}: ${rawUrl}`,
    );
  }
  return {
    url: rawUrl,
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    byte_size: bytes.byteLength,
  };
}

export async function inspectWalmartPublicImageSet(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedWalmartPublicImage[]> {
  if (urls.length < 2) {
    throw new Error("Walmart pilot requires a MAIN image and at least one secondary image");
  }
  if (new Set(urls).size !== urls.length) {
    throw new Error("Walmart public image URLs must be distinct");
  }
  return Promise.all(urls.map((url) => inspectWalmartPublicImage(url, fetchImpl)));
}
