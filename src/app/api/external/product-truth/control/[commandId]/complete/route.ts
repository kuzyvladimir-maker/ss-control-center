import { NextRequest, NextResponse } from "next/server";

import {
  authenticateProductTruthWorker,
  exactWorkerBody,
  productTruthWorkerErrorCode,
  productTruthWorkerJson,
} from "@/lib/sourcing/product-truth-web-control-worker-http";
import {
  completeProductTruthNoSpendCommand,
} from "@/lib/sourcing/product-truth-web-control-worker";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ commandId: string }> },
) {
  const runtime = authenticateProductTruthWorker(request);
  if (runtime instanceof NextResponse) return runtime;
  const body = await exactWorkerBody(request);
  if (body instanceof NextResponse) return body;
  if (
    Object.keys(body).sort().join(",") !== "lease_token,result"
    || typeof body.lease_token !== "string"
  ) {
    return productTruthWorkerJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "lease_token and result are the only accepted fields.",
    }, { status: 400 });
  }
  const { commandId } = await context.params;
  try {
    const result = await completeProductTruthNoSpendCommand({
      runtime,
      commandId,
      leaseToken: body.lease_token,
      result: body.result,
    });
    return productTruthWorkerJson({ ok: true, ...result });
  } catch (error) {
    return productTruthWorkerJson({
      ok: false,
      status: "BLOCKED",
      code: productTruthWorkerErrorCode(error),
    }, { status: 409 });
  }
}
