import { NextRequest, NextResponse } from "next/server";

import { parseChannelMaxHeartbeat } from "@/lib/channelmax-agent/contracts";
import { heartbeatChannelMaxAgentJob } from "@/lib/channelmax-agent/service";
import {
  channelMaxErrorResponse,
  readChannelMaxJson,
  requireChannelMaxAdmin,
} from "@/lib/channelmax-agent/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { id } = await params;
    const input = parseChannelMaxHeartbeat(await readChannelMaxJson(request));
    return NextResponse.json(
      await heartbeatChannelMaxAgentJob(id, input, auth.actorId),
    );
  } catch (error) {
    return channelMaxErrorResponse(error);
  }
}
