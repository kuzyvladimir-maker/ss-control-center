/** Perceptual comparison for Amazon-rehosted listing images. */

import sharp from "sharp";

import type { MediaEquivalence } from "./uncrustables-surgical";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_HOST_SUFFIXES = [
  ".r2.dev",
  ".media-amazon.com",
  ".scene7.com",
  ".walmartimages.com",
  ".salsify.com",
];

function assertAllowedImageUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Image verification requires https.");
  const hostname = url.hostname.toLowerCase();
  if (!ALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error(`Image-verification host is not allow-listed: ${hostname}`);
  }
  return url;
}

function isAmazonMediaUrl(raw: string): boolean {
  return assertAllowedImageUrl(raw).hostname.toLowerCase().endsWith(".media-amazon.com");
}

async function fetchImage(raw: string): Promise<Buffer> {
  const url = assertAllowedImageUrl(raw);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": "SS-Command-Center-Uncrustables-Image-Verify/1.0" },
  });
  if (!response.ok) throw new Error(`Image GET ${response.status} for ${url.hostname}.`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error("Image exceeds 25 MiB verification limit.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Image is empty or exceeds 25 MiB verification limit.");
  }
  return buffer;
}

async function normalizedPixels(url: string): Promise<Buffer> {
  const source = await fetchImage(url);
  return sharp(source, { failOn: "error" })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(64, 64, {
      fit: "contain",
      background: "#ffffff",
      withoutEnlargement: false,
    })
    .greyscale()
    .raw()
    .toBuffer();
}

/** Amazon converts source PNGs to JPEG and changes URLs. Comparing normalized
 * pixels (rather than URLs or file hashes) proves slot identity through that
 * expected re-encode. The threshold is deliberately conservative: the verified
 * brand-card source/rehost pair measures ~1.5/255 MAE. */
export class PerceptualMediaEquivalence implements MediaEquivalence {
  private readonly cache = new Map<string, Promise<Buffer>>();

  constructor(private readonly maximumMae = 6.5) {}

  private pixels(url: string): Promise<Buffer> {
    let pending = this.cache.get(url);
    if (!pending) {
      pending = normalizedPixels(url);
      this.cache.set(url, pending);
    }
    return pending;
  }

  async equivalent(expectedUrl: string, actualUrl: string): Promise<boolean> {
    if (expectedUrl === actualUrl) return true;
    // Two distinct Amazon CDN locators are distinct listing assets. A coarse
    // 64x64 greyscale MAE can collapse text-heavy nutrition panels (for
    // example, 210 vs 220 calories) and near-cropped lifestyle images. Only a
    // cross-host comparison represents the intended source -> Amazon rehost
    // case where perceptual equivalence is appropriate.
    if (isAmazonMediaUrl(expectedUrl) && isAmazonMediaUrl(actualUrl)) {
      return false;
    }
    const [expected, actual] = await Promise.all([
      this.pixels(expectedUrl),
      this.pixels(actualUrl),
    ]);
    if (expected.length !== actual.length || expected.length === 0) return false;
    let absoluteError = 0;
    for (let index = 0; index < expected.length; index++) {
      absoluteError += Math.abs(expected[index] - actual[index]);
    }
    return absoluteError / expected.length <= this.maximumMae;
  }
}
