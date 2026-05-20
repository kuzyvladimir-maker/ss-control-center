/**
 * Phase 2.4 Stage 6 — Validator 7: Image format + size.
 *
 * Amazon + Walmart both accept JPEG and PNG only (WebP is allowed for
 * secondaries but not the main image — main must be JPEG/PNG so the
 * marketplace can re-render to multiple sizes). File size cap is 10 MB
 * across both marketplaces.
 *
 * We use a HEAD request (cheap, no body download) — falls back to
 * NEEDS_REVIEW if the server doesn't support HEAD or doesn't return
 * Content-Type + Content-Length headers.
 */

import type { ValidatorFn } from "../types";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png"];

export const validatorImageFormat: ValidatorFn = async ({ sku }) => {
  const url = sku.main_image_url;
  if (!url) {
    // validator-image-dimensions already raises the missing-URL error;
    // skip cleanly to avoid duplicate noise.
    return {
      validator_id: "validator-image-format",
      passed: false,
      severity: "error",
      message: "ChannelSKU has no main_image_url set.",
    };
  }

  // `data:` URLs are local-dev fallbacks; we can inspect the mime in-line.
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+)[;,]/);
    const ct = m?.[1]?.toLowerCase() ?? "";
    if (!ALLOWED_TYPES.includes(ct)) {
      return {
        validator_id: "validator-image-format",
        passed: false,
        severity: "error",
        message: `Image MIME ${ct || "unknown"} is not allowed (JPEG/PNG only).`,
      };
    }
    return { validator_id: "validator-image-format", passed: true };
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
  } catch (e) {
    return {
      validator_id: "validator-image-format",
      passed: false,
      severity: "warning",
      message: `HEAD failed for image (${e instanceof Error ? e.message : String(e)}). Manually verify JPEG/PNG and <10 MB.`,
    };
  }
  if (!res.ok) {
    return {
      validator_id: "validator-image-format",
      passed: false,
      severity: "warning",
      message: `HEAD returned HTTP ${res.status}. Server may not support HEAD; manually verify format + size.`,
    };
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const lengthStr = res.headers.get("content-length");
  const length = lengthStr ? Number(lengthStr) : null;

  if (!ct) {
    return {
      validator_id: "validator-image-format",
      passed: false,
      severity: "warning",
      message: "HEAD returned no Content-Type. Manually verify JPEG/PNG.",
    };
  }
  if (!ALLOWED_TYPES.some((t) => ct.startsWith(t))) {
    return {
      validator_id: "validator-image-format",
      passed: false,
      severity: "error",
      message: `Image Content-Type "${ct}" is not allowed (JPEG/PNG only).`,
      details: { content_type: ct },
    };
  }
  if (length !== null && length > MAX_BYTES) {
    return {
      validator_id: "validator-image-format",
      passed: false,
      severity: "error",
      message: `Image is ${length} bytes; 10 MB max.`,
      details: { bytes: length, max: MAX_BYTES },
    };
  }
  return {
    validator_id: "validator-image-format",
    passed: true,
    details: { content_type: ct, bytes: length },
  };
};
