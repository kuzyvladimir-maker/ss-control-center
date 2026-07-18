import { Buffer } from "node:buffer";

import { NextRequest, NextResponse } from "next/server";

import { requireChannelMaxAdmin } from "@/lib/channelmax-agent/http";
import {
  channelMaxVcCanaryArtifact,
  CHANNELMAX_VC_CANARY_ARTIFACT_MEDIA_TYPE,
  CHANNELMAX_VC_CANARY_ARTIFACT_ROUTE_PREFIX,
} from "@/lib/channelmax-agent/uncrustables-same-model-canary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ digest: string }> };

const ARTIFACTS = (["FORWARD", "ROLLBACK"] as const).map((direction) => ({
  direction,
  artifact: channelMaxVcCanaryArtifact(direction),
}));

function notFound(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "CANARY_ARTIFACT_NOT_FOUND",
      message: "The requested immutable canary artifact does not exist.",
    },
    { status: 404 },
  );
}

function artifactForWireName(wireName: string) {
  return ARTIFACTS.find(
    ({ artifact }) => wireName === `${artifact.sha256}.txt`,
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { digest } = await context.params;
  const expectedPath = `${CHANNELMAX_VC_CANARY_ARTIFACT_ROUTE_PREFIX}/${digest}`;
  if (
    request.nextUrl.pathname !== expectedPath ||
    request.nextUrl.search !== ""
  ) {
    return notFound();
  }

  const resolved = artifactForWireName(digest);
  if (!resolved) return notFound();

  const { artifact, direction } = resolved;
  const digestBase64 = Buffer.from(artifact.sha256, "hex").toString("base64");
  return new NextResponse(new Uint8Array(artifact.bytes), {
    status: 200,
    headers: {
      "cache-control": "private, no-store, max-age=0",
      "content-disposition":
        `attachment; filename="channelmax-vc-canary-${direction.toLowerCase()}.tsv"`,
      "content-length": String(artifact.byteSize),
      "content-type": CHANNELMAX_VC_CANARY_ARTIFACT_MEDIA_TYPE,
      digest: `sha-256=${digestBase64}`,
      etag: `"${artifact.sha256}"`,
      "x-channelmax-artifact-sha256": artifact.sha256,
      "x-content-type-options": "nosniff",
    },
  });
}

async function rejectMethod(request: NextRequest): Promise<NextResponse> {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(
    {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Canary artifacts are available only through authenticated GET.",
    },
    { status: 405, headers: { allow: "GET" } },
  );
}

export const HEAD = rejectMethod;
export const POST = rejectMethod;
export const PUT = rejectMethod;
export const PATCH = rejectMethod;
export const DELETE = rejectMethod;
export const OPTIONS = rejectMethod;
