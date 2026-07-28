import { NextRequest, NextResponse } from "next/server";

import {
  authenticateProductTruthWorker,
  exactWorkerBody,
  productTruthWorkerErrorCode,
  productTruthWorkerJson,
} from "@/lib/sourcing/product-truth-web-control-worker-http";
import {
  claimProductTruthNoSpendCommand,
} from "@/lib/sourcing/product-truth-web-control-worker";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const runtime = authenticateProductTruthWorker(request);
  if (runtime instanceof NextResponse) return runtime;
  const body = await exactWorkerBody(request);
  if (body instanceof NextResponse) return body;
  if (
    Object.keys(body).length !== 1
    || typeof body.worker_id !== "string"
  ) {
    return productTruthWorkerJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "worker_id is the only accepted field.",
    }, { status: 400 });
  }
  try {
    const claim = await claimProductTruthNoSpendCommand({
      runtime,
      workerId: body.worker_id,
    });
    return productTruthWorkerJson({
      ok: true,
      status: claim ? "CLAIMED" : "IDLE",
      claim,
    });
  } catch (error) {
    return productTruthWorkerJson({
      ok: false,
      status: "BLOCKED",
      code: productTruthWorkerErrorCode(error),
    }, { status: 503 });
  }
}
