import { NextRequest, NextResponse } from "next/server";

import {
  authenticateProductTruthStandingWaveWorker,
  exactProductTruthStandingWaveBody,
  productTruthStandingWaveErrorCode,
  productTruthStandingWaveJson,
} from "@/lib/sourcing/product-truth-standing-wave-web-http";
import {
  claimProductTruthStandingWaveWebCommand,
} from "@/lib/sourcing/product-truth-standing-wave-web-store";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const runtime = authenticateProductTruthStandingWaveWorker(request);
  if (runtime instanceof NextResponse) return runtime;
  const body = await exactProductTruthStandingWaveBody(request);
  if (body instanceof NextResponse) return body;
  if (
    Object.keys(body).length !== 1
    || typeof body.worker_id !== "string"
  ) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "worker_id is the only accepted field.",
    }, { status: 400 });
  }
  try {
    const claim = await claimProductTruthStandingWaveWebCommand({
      runtime,
      workerId: body.worker_id,
    });
    return productTruthStandingWaveJson({
      ok: true,
      status: claim ? "CLAIMED" : "IDLE",
      claim,
    });
  } catch (error) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "BLOCKED",
      code: productTruthStandingWaveErrorCode(error),
    }, { status: 503 });
  }
}
