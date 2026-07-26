import { createHash } from "node:crypto";

import sharp from "sharp";

export const WALMART_PILOT_IMAGE_MIN_PIXELS = 2200;
export const WALMART_PILOT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const WALMART_MAIN_IMAGE_MIN_LONG_EDGE_FILL_BPS = 9_000;
export const WALMART_MAIN_IMAGE_MAX_LONG_EDGE_FILL_BPS = 9_700;
export const WALMART_MAIN_IMAGE_MIN_WHITE_EDGE_BPS = 9_900;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
]);

export interface VerifiedWalmartPublicImage {
  url: string;
  sha256: string;
  format: "jpeg" | "png";
  width: number;
  height: number;
  byte_size: number;
  white_edge_bps: number;
  product_frame_long_edge_fill_bps: number;
}

async function inspectWhiteCanvas(bytes: Buffer): Promise<{
  white_edge_bps: number;
  product_frame_long_edge_fill_bps: number;
}> {
  const { data, info } = await sharp(bytes, { failOn: "warning" })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const edgeBand = Math.max(1, Math.round(Math.min(width, height) * 0.01));
  let edgePixels = 0;
  let whiteEdgePixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const white =
        data[offset]! >= 245 &&
        data[offset + 1]! >= 245 &&
        data[offset + 2]! >= 245;
      if (
        x < edgeBand ||
        y < edgeBand ||
        x >= width - edgeBand ||
        y >= height - edgeBand
      ) {
        edgePixels += 1;
        if (white) whiteEdgePixels += 1;
      }
      if (!white) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    throw new Error("Walmart image does not contain a visible product");
  }
  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  return {
    white_edge_bps: Math.round((whiteEdgePixels / edgePixels) * 10_000),
    product_frame_long_edge_fill_bps: Math.round(
      Math.max(spanX / width, spanY / height) * 10_000,
    ),
  };
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
  const canvas = await inspectWhiteCanvas(bytes);
  return {
    url: rawUrl,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    byte_size: bytes.byteLength,
    ...canvas,
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
