import { NextRequest, NextResponse } from "next/server";

import { getChannelMaxAgentEvidence } from "@/lib/channelmax-agent/service";
import {
  channelMaxErrorResponse,
  requireChannelMaxAdmin,
} from "@/lib/channelmax-agent/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; evidenceId: string }> },
) {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { id, evidenceId } = await params;
    const evidence = await getChannelMaxAgentEvidence(id, evidenceId);
    return new NextResponse(Buffer.from(evidence.content), {
      status: 200,
      headers: {
        "Content-Type": evidence.mediaType,
        "Content-Length": String(evidence.byteSize),
        "Content-Disposition": `attachment; filename="channelmax-evidence-${evidence.id}"`,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "X-ChannelMax-Evidence-Sha256": evidence.sha256,
      },
    });
  } catch (error) {
    return channelMaxErrorResponse(error);
  }
}
