import { NextRequest, NextResponse } from "next/server";

import { parseClaimChannelMaxAgentJob } from "@/lib/channelmax-agent/contracts";
import { claimChannelMaxAgentJob } from "@/lib/channelmax-agent/service";
import {
  channelMaxErrorResponse,
  readChannelMaxJson,
  requireChannelMaxAdmin,
} from "@/lib/channelmax-agent/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const input = parseClaimChannelMaxAgentJob(
      await readChannelMaxJson(request),
    );
    return NextResponse.json({
      ok: true,
      ...(await claimChannelMaxAgentJob(input, auth.actorId)),
    });
  } catch (error) {
    return channelMaxErrorResponse(error);
  }
}
