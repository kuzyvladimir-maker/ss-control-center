import { NextRequest, NextResponse } from "next/server";

import {
  authenticateProductTruthWorker,
  exactWorkerBody,
  productTruthWorkerErrorCode,
  productTruthWorkerJson,
} from "@/lib/sourcing/product-truth-web-control-worker-http";
import {
  heartbeatProductTruthNoSpendCommand,
} from "@/lib/sourcing/product-truth-web-control-worker";
import {
  parseProductTruthWalmartEnrichmentProgress,
} from "@/lib/sourcing/product-truth-walmart-enrichment-worker-contract";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ commandId: string }> },
) {
  const runtime = authenticateProductTruthWorker(request);
  if (runtime instanceof NextResponse) return runtime;
  const body = await exactWorkerBody(request);
  if (body instanceof NextResponse) return body;
  const bodyKeys = Object.keys(body).sort();
  if (
    typeof body.lease_token !== "string"
    || !(
      (bodyKeys.length === 1 && bodyKeys[0] === "lease_token")
      || (bodyKeys.length === 2
        && bodyKeys[0] === "lease_token"
        && bodyKeys[1] === "progress")
    )
  ) {
    return productTruthWorkerJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "heartbeat accepts lease_token and optional sealed progress.",
    }, { status: 400 });
  }
  const { commandId } = await context.params;
  try {
    const progress = body.progress === undefined
      ? null
      : parseProductTruthWalmartEnrichmentProgress(body.progress);
    const result = await heartbeatProductTruthNoSpendCommand({
      commandId,
      leaseToken: body.lease_token,
      progress,
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
