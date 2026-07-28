// Cloudflare R2 upload helper for Walmart multipack images.
//
// Walmart fetches listing images by public URL (it rejects data: URLs and
// Google Drive/Dropbox links), so every composed image must live at a stable
// public address. We host on R2 (S3-compatible, free egress) — same bucket
// pattern as Bundle Factory. Public URL = `${R2_PUBLIC_URL}/${key}`.
//
// Env (see project_r2_configured memory): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

let cached: S3Client | null = null;

function client(): S3Client {
  if (cached) return cached;
  const accountId = required("R2_ACCOUNT_ID");
  cached = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
  });
  return cached;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name} — R2 is not configured (see project_r2_configured).`);
  return v;
}

/** Upload a buffer to R2 and return its public URL. */
export async function uploadToR2(
  body: Buffer,
  key: string,
  contentType = "image/png",
): Promise<string> {
  const bucket = required("R2_BUCKET_NAME");
  const publicBase = required("R2_PUBLIC_URL").replace(/\/$/, "");
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // long cache — these are content-addressed by SKU+timestamp in the key
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return `${publicBase}/${key}`;
}

/** Stable-ish key for a multipack image. Caller passes a date stamp (no Date.now in libs). */
export function multipackImageKey(sku: string, kind: "main" | "badge", stamp: string): string {
  const safeSku = sku.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `walmart-multipack/${safeSku}/${kind}-${stamp}.png`;
}
