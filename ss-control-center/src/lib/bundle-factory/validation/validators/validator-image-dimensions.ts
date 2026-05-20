/**
 * Phase 2.4 Stage 6 — Validator 6: Image dimensions.
 *
 * Amazon main image: ≥ 2000×2000 px for zoom. Walmart: ≥ 1500×1500 px.
 * We avoid the `sharp` dependency (not installed) and parse the PNG/JPEG
 * header bytes directly — works for both formats gpt-image-1 returns
 * and any natural retailer JPEG. Falls back to NEEDS_REVIEW (warning,
 * not error) if dimensions can't be measured so a transient fetch
 * failure doesn't block an otherwise-clean SKU.
 *
 * Skips entirely when `data:` URLs are used (local dev fallback path
 * from image-generation.ts) — those carry the bytes inline so we don't
 * need to fetch but also don't bother measuring; the live R2 URL on
 * production will get the real check.
 */

import type { ValidatorFn, ValidatorResult } from "../types";

const MIN_DIMS_BY_CHANNEL: Record<string, number> = {
  AMAZON_PERSONAL: 2000,
  AMAZON_SALUTEM: 2000,
  AMAZON_AMZCOM: 2000,
  AMAZON_SIRIUS: 2000,
  AMAZON_RETAILER: 2000,
  WALMART: 1500,
  EBAY: 1000,
  TIKTOK_1: 1080,
  TIKTOK_2: 1080,
};

// First N bytes are enough to read dimensions for both PNG (24 bytes)
// and JPEG (variable, usually within the first 64 KB but we cap to 256
// KB to handle large EXIF headers).
const HEADER_FETCH_BYTES = 256 * 1024;

interface Dims {
  width: number;
  height: number;
}

function readPngDims(buf: Buffer): Dims | null {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A. IHDR chunk starts at offset 8;
  // width = bytes 16-19 BE, height = bytes 20-23 BE.
  if (buf.length < 24) return null;
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpegDims(buf: Buffer): Dims | null {
  // JPEG: 0xFFD8 SOI followed by markers. Walk segments until we hit an
  // SOFn (0xC0-0xCF except 0xC4/0xC8/0xCC).
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // Standalone markers (no length payload) we should skip past.
    if (marker === 0x00 || marker === 0xff) {
      i++;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd9) {
      // RSTn, SOI, EOI — no payload
      i += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(i + 2);
    // SOF markers (Start Of Frame) carry the dimensions in bytes 5-9 of
    // the segment: precision (1) + height (2 BE) + width (2 BE).
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      if (i + 9 > buf.length) return null;
      return {
        height: buf.readUInt16BE(i + 5),
        width: buf.readUInt16BE(i + 7),
      };
    }
    i += 2 + segLen;
  }
  return null;
}

function parseDataUrlDims(url: string): Dims | null {
  const idx = url.indexOf(",");
  if (idx < 0) return null;
  const b64 = url.slice(idx + 1);
  try {
    const buf = Buffer.from(b64, "base64");
    return readPngDims(buf) ?? readJpegDims(buf);
  } catch {
    return null;
  }
}

async function fetchHeaderBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${HEADER_FETCH_BYTES - 1}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok && res.status !== 206) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function measureUrl(url: string): Promise<Dims | null> {
  if (url.startsWith("data:")) return parseDataUrlDims(url);
  const buf = await fetchHeaderBytes(url);
  if (!buf) return null;
  return readPngDims(buf) ?? readJpegDims(buf);
}

export const validatorImageDimensions: ValidatorFn = async ({
  sku,
}): Promise<ValidatorResult> => {
  const url = sku.main_image_url;
  if (!url) {
    return {
      validator_id: "validator-image-dimensions",
      passed: false,
      severity: "error",
      message: "ChannelSKU has no main_image_url set.",
    };
  }
  const minDim = MIN_DIMS_BY_CHANNEL[sku.channel] ?? 2000;
  const dims = await measureUrl(url);
  if (!dims) {
    return {
      validator_id: "validator-image-dimensions",
      passed: false,
      severity: "warning",
      message: `Could not measure image dimensions for ${url.slice(0, 80)}. Manually verify ≥${minDim}×${minDim}.`,
    };
  }
  if (dims.width < minDim || dims.height < minDim) {
    return {
      validator_id: "validator-image-dimensions",
      passed: false,
      severity: "error",
      message: `Image is ${dims.width}×${dims.height}; ${sku.channel} requires ≥${minDim}×${minDim}.`,
      details: { width: dims.width, height: dims.height, min: minDim },
    };
  }
  return {
    validator_id: "validator-image-dimensions",
    passed: true,
    details: { width: dims.width, height: dims.height },
  };
};
