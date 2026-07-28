/**
 * Phase 2.1 Stage 2.5 — R2 image mirror.
 *
 * Downloads reference product images from retail/manufacturer websites
 * and uploads them to Cloudflare R2. Vladimir requires all production
 * images to live on our infrastructure (external retailer URLs rotate
 * silently — a year-old listing breaks when Walmart re-keys an image).
 *
 * Called by `research-pipeline.ts` after Perplexity returns. Each
 * per-image step is wrapped in try/catch so a single bad URL doesn't
 * sink the whole product or the whole research run; on failure we fall
 * back to the original URL with `uploaded: false` set so the caller
 * can decide whether to keep the original or drop the field.
 *
 * Idempotency: R2 keys are deterministic on `bundle_sku` + index, so a
 * re-run with the same inputs overwrites the same object and does not
 * leak orphans.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const DEFAULT_BUCKET = "salutem-bundle-factory";
const PLACEHOLDER = "placeholder";

let _client: S3Client | null = null;
function getClient(): S3Client | null {
  if (_client) return _client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (
    !accountId ||
    !accessKey ||
    !secret ||
    accountId === PLACEHOLDER ||
    accessKey === PLACEHOLDER ||
    secret === PLACEHOLDER
  ) {
    return null;
  }
  _client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secret },
  });
  return _client;
}

export interface MirrorResult {
  original_url: string;
  /** Final URL to persist. R2 URL on success, original URL on fallback. */
  r2_url: string;
  size_bytes: number;
  content_type: string;
  uploaded: boolean;
  error?: string;
}

export interface MirrorImagesParams {
  /** Subdirectory in R2 — typically `draft-<id>-<slug>`. Sanitised lightly. */
  bundle_sku: string;
  image_urls: string[];
  max_size_mb?: number;
}

const SLUG_RE = /[^a-zA-Z0-9_-]+/g;

function safeSlug(s: string): string {
  return s.replace(SLUG_RE, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "anon";
}

function contentTypeToExt(ct: string): string {
  const lower = ct.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "jpg";
}

export async function mirrorImages(
  params: MirrorImagesParams,
): Promise<MirrorResult[]> {
  const client = getClient();
  const bucket = process.env.R2_BUCKET_NAME || DEFAULT_BUCKET;
  const publicUrl = process.env.R2_PUBLIC_URL;
  const maxSize = (params.max_size_mb ?? 5) * 1024 * 1024;
  const slug = safeSlug(params.bundle_sku);

  // Graceful fallback: no R2 configured → pass URLs through unchanged so
  // the rest of the pipeline still works (caller knows uploaded:false).
  if (!client || !publicUrl) {
    return params.image_urls.map((url) => ({
      original_url: url,
      r2_url: url,
      size_bytes: 0,
      content_type: "unknown",
      uploaded: false,
      error: "R2 not configured",
    }));
  }

  const results: MirrorResult[] = [];

  for (let i = 0; i < params.image_urls.length; i++) {
    const url = params.image_urls[i];
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Salutem Bundle Factory image mirror)",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get("content-type") ?? "image/jpeg";
      if (!contentType.startsWith("image/")) {
        throw new Error(`Not an image: content-type=${contentType}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxSize) {
        throw new Error(
          `Image too large: ${buffer.length} bytes > ${maxSize} max`,
        );
      }

      const ext = contentTypeToExt(contentType);
      const key = `sec/${slug}/${i + 1}.${ext}`;

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          CacheControl: "public, max-age=31536000",
        }),
      );

      // Strip trailing slash on PUBLIC_URL for clean joining.
      const base = publicUrl.replace(/\/+$/, "");
      results.push({
        original_url: url,
        r2_url: `${base}/${key}`,
        size_bytes: buffer.length,
        content_type: contentType,
        uploaded: true,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[r2-image-mirror] Failed for ${url}: ${errMsg}`);
      results.push({
        original_url: url,
        r2_url: url,
        size_bytes: 0,
        content_type: "unknown",
        uploaded: false,
        error: errMsg,
      });
    }
  }

  return results;
}
