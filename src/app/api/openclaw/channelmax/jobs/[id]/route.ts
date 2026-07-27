import { NextRequest, NextResponse } from "next/server";

import { getChannelMaxAgentJob } from "@/lib/channelmax-agent/service";
import {
  channelMaxErrorResponse,
  requireChannelMaxAdmin,
} from "@/lib/channelmax-agent/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { id } = await params;
    return NextResponse.json({
      ok: true,
      job: await getChannelMaxAgentJob(id),
    });
  } catch (error) {
    return channelMaxErrorResponse(error);
  }
}
