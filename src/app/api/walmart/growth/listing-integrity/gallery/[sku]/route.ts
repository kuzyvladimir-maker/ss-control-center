import { Buffer } from "node:buffer";

import { NextResponse } from "next/server";

import { readListingIntegrityGallery } from "@/lib/walmart/listing-integrity-operations.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sku: string }> };

export async function buildListingIntegrityGalleryResponse(
  sku: string,
  readGallery = readListingIntegrityGallery,
) {
  const gallery = await readGallery(sku);
  if (!gallery) {
    return NextResponse.json(
      { ok: false, error: "QUALIFIED_GALLERY_NOT_FOUND" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  return new NextResponse(new Uint8Array(gallery.bytes), {
    status: 200,
    headers: {
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": `inline; filename="${sku}-before-after.html"`,
      "content-length": String(gallery.bytes.byteLength),
      "content-type": "text/html; charset=utf-8",
      etag: `"${gallery.sha256}"`,
      "x-content-type-options": "nosniff",
      "x-walmart-listing-integrity-sha256": gallery.sha256,
      digest: `sha-256=${Buffer.from(gallery.sha256, "hex").toString("base64")}`,
    },
  });
}

export async function GET(_request: Request, context: RouteContext) {
  const { sku } = await context.params;
  return buildListingIntegrityGalleryResponse(sku);
}

async function rejectMutation() {
  return NextResponse.json(
    { ok: false, error: "METHOD_NOT_ALLOWED" },
    { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
  );
}

export const POST = rejectMutation;
export const PUT = rejectMutation;
export const PATCH = rejectMutation;
export const DELETE = rejectMutation;
