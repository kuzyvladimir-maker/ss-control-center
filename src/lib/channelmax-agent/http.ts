import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-server";
import { ChannelMaxContractError } from "./contracts";
import { ChannelMaxAgentServiceError } from "./service";

export async function requireChannelMaxAdmin(
  request: NextRequest,
): Promise<{ actor: string; actorId: string } | NextResponse> {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  return { actor: auth.username, actorId: auth.id };
}

export async function requireChannelMaxOwnerSessionAdmin(
  request: NextRequest,
): Promise<{ actor: string; actorId: string } | NextResponse> {
  const auth = await requireChannelMaxAdmin(request);
  if (auth instanceof NextResponse) return auth;
  // JACKIE_API_TOKEN and SSCC_API_TOKEN deliberately resolve to synthetic
  // system identities. They may create/read/execute jobs, but cannot grant the
  // independent owner approval required for a ChannelMAX mutation.
  if (auth.actorId.startsWith("system:")) {
    return NextResponse.json(
      {
        ok: false,
        error: "OWNER_SESSION_REQUIRED",
        message:
          "ChannelMAX mutation approval requires a real signed-in admin browser session; API bearer tokens cannot approve.",
      },
      { status: 403 },
    );
  }
  return auth;
}

export async function readChannelMaxJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ChannelMaxContractError("Request body must be valid JSON.");
  }
}

export function channelMaxEvidenceBaseUrl(request: NextRequest): string {
  const canonicalEvidenceBase = process.env.CHANNELMAX_EVIDENCE_BASE_URL;
  const configured =
    canonicalEvidenceBase ??
    process.env.NEXT_PUBLIC_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL;
  if (
    !canonicalEvidenceBase?.trim() &&
    process.env.NODE_ENV === "production"
  ) {
    throw new ChannelMaxAgentServiceError(
      "EVIDENCE_BASE_URL_NOT_CONFIGURED",
      "Set CHANNELMAX_EVIDENCE_BASE_URL to the canonical public HTTPS SSCC origin.",
      503,
    );
  }
  const candidate = configured?.trim() || request.nextUrl.origin;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ChannelMaxAgentServiceError(
      "EVIDENCE_BASE_URL_INVALID",
      "Set CHANNELMAX_EVIDENCE_BASE_URL to the public HTTPS SSCC origin.",
      503,
    );
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ChannelMaxAgentServiceError(
      "EVIDENCE_BASE_URL_INVALID",
      "Set CHANNELMAX_EVIDENCE_BASE_URL to the public HTTPS SSCC origin.",
      503,
    );
  }
  return parsed.origin;
}

export function channelMaxErrorResponse(error: unknown): NextResponse {
  if (error instanceof ChannelMaxContractError) {
    return NextResponse.json(
      { ok: false, error: "INVALID_CONTRACT", message: error.message },
      { status: 400 },
    );
  }
  if (error instanceof ChannelMaxAgentServiceError) {
    return NextResponse.json(
      { ok: false, error: error.code, message: error.message },
      { status: error.httpStatus },
    );
  }
  console.error("[channelmax-agent] unexpected error", error);
  return NextResponse.json(
    {
      ok: false,
      error: "INTERNAL_ERROR",
      message: "ChannelMAX agent bridge failed safely.",
    },
    { status: 500 },
  );
}
