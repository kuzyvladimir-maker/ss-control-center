import { NextRequest, NextResponse } from "next/server";

import { parseApproveChannelMaxAgentJob } from "@/lib/channelmax-agent/contracts";
import { approveChannelMaxAgentJob } from "@/lib/channelmax-agent/service";
import {
  channelMaxErrorResponse,
  readChannelMaxJson,
  requireChannelMaxOwnerSessionAdmin,
} from "@/lib/channelmax-agent/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireChannelMaxOwnerSessionAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { id } = await params;
    const input = parseApproveChannelMaxAgentJob(
      await readChannelMaxJson(request),
    );
    return NextResponse.json(
      await approveChannelMaxAgentJob(id, input, auth),
    );
  } catch (error) {
    return channelMaxErrorResponse(error);
  }
}
