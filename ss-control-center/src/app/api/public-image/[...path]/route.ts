/**
 * GET /api/public-image/<r2 key>   — deliberately unauthenticated.
 *
 * Walmart fetches listing images itself, from whatever URL we put in the feed,
 * and it could not fetch ours. The first item we ever submitted came back
 * `ERR_EXT_DATA_0101171: We couldn't download the image from your URL. This may
 * be because the host domain is blocked for security reasons.`
 *
 * The file was fine — 2200×2200, PNG, 2.85 MB, opaque, white background, HTTP
 * 200 from a browser. The host was not: images sat on Cloudflare's `*.r2.dev`
 * address, which Cloudflare documents as development-only and rate-limited, and
 * which bot-filters some clients outright (`Java/1.8.0` gets a 403 there, and
 * Walmart's fetcher is evidently Java — its own error responses carry
 * NullPointerExceptions).
 *
 * So the bytes are served from our own domain instead. Byte-for-byte the same
 * object: the studio evidence pins a SHA-256 of the stored image, and streaming
 * it unchanged is what keeps that seal meaningful. This route resizes nothing
 * and re-encodes nothing.
 *
 * Reading is limited to the prefixes we publish under, so a public URL cannot
 * be walked into the rest of the bucket.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Only these key prefixes are readable through this route. */
const PUBLIC_PREFIXES = [
  "walmart-new-sku/",
  "walmart-ingredients/",
  "bundle-factory/",
  "studio-audit/",
];

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
};

let client: S3Client | null = null;

function r2(): S3Client | null {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const key = (path ?? []).join("/");

  if (!key || key.includes("..")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const extension = key.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) {
    // Walmart requires the URL to end in an image file type; refusing anything
    // else keeps this route from becoming a general file server.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const s3 = r2();
  if (!s3) {
    return NextResponse.json({ error: "Storage is not configured" }, { status: 503 });
  }

  try {
    const object = await s3.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME || "salutem-bundle-factory",
      Key: key,
    }));
    const body = await object.Body?.transformToByteArray();
    if (!body) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return new NextResponse(Buffer.from(body), {
      status: 200,
      headers: {
        "Content-Type": object.ContentType ?? contentType,
        "Content-Length": String(body.byteLength),
        // Marketplaces re-fetch; the key is a content hash, so it never changes.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
