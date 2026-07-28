import { NextRequest, NextResponse } from "next/server";

import {
  channelMaxAgentCapabilities,
  createChannelMaxAgentJob,
} from "@/lib/channelmax-agent/service";
import { parseCreateChannelMaxAgentJob } from "@/lib/channelmax-agent/contracts";
import {
  channelMaxErrorResponse,
  readChannelMaxJson,
  requireChannelMaxAdmin,
} from "@/lib/channelmax-agent/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ ok: true, ...channelMaxAgentCapabilities() });
}

export async function POST(request: NextRequest) {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const input = parseCreateChannelMaxAgentJob(
      await readChannelMaxJson(request),
    );
    const result = await createChannelMaxAgentJob(input, auth.actor);
    return NextResponse.json(
      { ok: true, ...result },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return channelMaxErrorResponse(error);
  }
}
