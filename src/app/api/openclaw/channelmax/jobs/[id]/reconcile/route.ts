import { NextRequest, NextResponse } from "next/server";

import { parseCreateChannelMaxReconciliation } from "@/lib/channelmax-agent/contracts";
import { createChannelMaxReconciliationJob } from "@/lib/channelmax-agent/service";
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
    const input = parseCreateChannelMaxReconciliation(
      await readChannelMaxJson(request),
    );
    const result = await createChannelMaxReconciliationJob(
      id,
      input,
      auth.actor,
    );
    return NextResponse.json(
      { ok: true, ...result },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return channelMaxErrorResponse(error);
  }
}
