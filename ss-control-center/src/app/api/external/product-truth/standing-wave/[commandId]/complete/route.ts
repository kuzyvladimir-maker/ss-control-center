import { NextRequest, NextResponse } from "next/server";

import {
  authenticateProductTruthStandingWaveWorker,
  exactProductTruthStandingWaveBody,
  productTruthStandingWaveErrorCode,
  productTruthStandingWaveJson,
} from "@/lib/sourcing/product-truth-standing-wave-web-http";
import {
  completeProductTruthStandingWaveWebCommand,
} from "@/lib/sourcing/product-truth-standing-wave-web-store";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ commandId: string }> },
) {
  const runtime = authenticateProductTruthStandingWaveWorker(request);
  if (runtime instanceof NextResponse) return runtime;
  const body = await exactProductTruthStandingWaveBody(request);
  if (body instanceof NextResponse) return body;
  if (
    Object.keys(body).length !== 2
    || typeof body.lease_token !== "string"
    || !("result" in body)
  ) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "lease_token and result are the only accepted fields.",
    }, { status: 400 });
  }
  const { commandId } = await context.params;
  try {
    const result = await completeProductTruthStandingWaveWebCommand({
      runtime,
      commandId,
      leaseToken: body.lease_token,
      result: body.result,
    });
    return productTruthStandingWaveJson({ ok: true, ...result });
  } catch (error) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "BLOCKED",
      code: productTruthStandingWaveErrorCode(error),
    }, { status: 409 });
  }
}
