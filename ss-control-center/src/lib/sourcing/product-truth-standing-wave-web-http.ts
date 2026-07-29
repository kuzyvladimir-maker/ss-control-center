import { NextRequest, NextResponse } from "next/server";

import {
  ProductTruthStandingWaveWebContractError,
} from "./product-truth-standing-wave-web-contract";
import {
  ProductTruthStandingWaveWebRuntimeError,
  loadProductTruthStandingWaveWebRuntime,
  type ProductTruthStandingWaveWebRuntimeActive,
} from "./product-truth-standing-wave-web-runtime";
import {
  ProductTruthStandingWaveWebStoreError,
} from "./product-truth-standing-wave-web-store";
import {
  verifyProductTruthWorkerBearer,
} from "./product-truth-web-control-worker-contract";

export function productTruthStandingWaveJson(
  body: unknown,
  init?: ResponseInit,
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-product-truth-worker-mode", "standing-wave");
  return response;
}

export function productTruthStandingWaveErrorCode(error: unknown): string {
  if (
    error instanceof ProductTruthStandingWaveWebContractError
    || error instanceof ProductTruthStandingWaveWebRuntimeError
    || error instanceof ProductTruthStandingWaveWebStoreError
  ) {
    return error.code;
  }
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) return error.code;
  return "STANDING_WAVE_WEB_REQUEST_FAILED";
}

export function authenticateProductTruthStandingWaveWorker(
  request: NextRequest,
): ProductTruthStandingWaveWebRuntimeActive | NextResponse {
  let runtime;
  try {
    runtime = loadProductTruthStandingWaveWebRuntime();
  } catch (error) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "BLOCKED",
      code: productTruthStandingWaveErrorCode(error),
    }, { status: 503 });
  }
  if (
    runtime.status === "OFF"
    || runtime.base.workerTokenSha256 === null
  ) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "OFF",
      code: "STANDING_WAVE_WORKER_DISABLED",
    }, { status: 503 });
  }
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.replace(/^Bearer\s+/iu, "").trim() ?? null;
  if (
    !authorization?.match(/^Bearer\s+/iu)
    || !verifyProductTruthWorkerBearer({
      bearer,
      expectedSha256: runtime.base.workerTokenSha256,
    })
  ) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "UNAUTHORIZED",
      code: "STANDING_WAVE_WORKER_UNAUTHORIZED",
    }, { status: 401 });
  }
  return runtime;
}

export async function exactProductTruthStandingWaveBody(
  request: NextRequest,
): Promise<Record<string, unknown> | NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return productTruthStandingWaveJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "JSON body is required.",
    }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "Request body must be an object.",
    }, { status: 400 });
  }
  return body as Record<string, unknown>;
}
