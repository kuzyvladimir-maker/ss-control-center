import { NextRequest, NextResponse } from "next/server";

import { verifyPassword } from "@/lib/auth";
import { parseChannelMaxPasswordStepUp } from "@/lib/channelmax-agent/contracts";
import {
  channelMaxMutationApprovalEnabled,
  createChannelMaxPasswordStepUp,
} from "@/lib/channelmax-agent/service";
import {
  channelMaxErrorResponse,
  readChannelMaxJson,
  requireChannelMaxOwnerSessionAdmin,
} from "@/lib/channelmax-agent/http";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireChannelMaxOwnerSessionAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    if (!channelMaxMutationApprovalEnabled()) {
      return NextResponse.json(
        {
          ok: false,
          error: "MUTATION_APPROVAL_DISABLED",
          message:
            "ChannelMAX mutation approval is fail-closed until managed immutable evidence verification is implemented.",
        },
        { status: 503 },
      );
    }
    const { id } = await params;
    const input = parseChannelMaxPasswordStepUp(
      await readChannelMaxJson(request),
    );
    const user = await prisma.user.findUnique({
      where: { id: auth.actorId },
      select: { passwordHash: true, role: true },
    });
    if (
      !user ||
      user.role !== "admin" ||
      !verifyPassword(input.password, user.passwordHash)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "STEP_UP_FAILED",
          message: "Password re-authentication failed.",
        },
        { status: 401 },
      );
    }
    return NextResponse.json({
      ok: true,
      step_up: await createChannelMaxPasswordStepUp(id, auth.actorId),
    });
  } catch (error) {
    return channelMaxErrorResponse(error);
  }
}
