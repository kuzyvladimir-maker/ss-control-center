import { NextRequest, NextResponse } from "next/server";

import { parseChannelMaxManagedEvidenceUpload } from "@/lib/channelmax-agent/contracts";
import {
  CHANNELMAX_MANAGED_EVIDENCE_MAX_BYTES,
  storeChannelMaxAgentEvidence,
} from "@/lib/channelmax-agent/service";
import {
  channelMaxErrorResponse,
  channelMaxEvidenceBaseUrl,
  requireChannelMaxAdmin,
} from "@/lib/channelmax-agent/http";

export const dynamic = "force-dynamic";

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("managed evidence size limit exceeded");
      return new Uint8Array(maxBytes + 1);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const declaredSize = request.headers.get("content-length");
    if (
      declaredSize &&
      (!/^\d+$/.test(declaredSize) ||
        Number(declaredSize) > CHANNELMAX_MANAGED_EVIDENCE_MAX_BYTES)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "EVIDENCE_SIZE_INVALID",
          message: `Managed evidence is limited to ${CHANNELMAX_MANAGED_EVIDENCE_MAX_BYTES} bytes.`,
        },
        { status: 413 },
      );
    }
    const now = new Date();
    const mediaType = (request.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim();
    const input = parseChannelMaxManagedEvidenceUpload(
      {
        lease_token: request.headers.get("x-channelmax-lease-token"),
        kind: request.headers.get("x-channelmax-evidence-kind"),
        media_type: mediaType,
        captured_at: request.headers.get("x-channelmax-captured-at"),
      },
      now,
    );
    const content = await readBoundedBody(
      request,
      CHANNELMAX_MANAGED_EVIDENCE_MAX_BYTES,
    );
    const { id } = await params;
    return NextResponse.json(
      await storeChannelMaxAgentEvidence(
        id,
        input,
        content,
        auth.actorId,
        channelMaxEvidenceBaseUrl(request),
        now,
      ),
      { status: 201 },
    );
  } catch (error) {
    return channelMaxErrorResponse(error);
  }
}
