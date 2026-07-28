import { NextRequest, NextResponse } from "next/server";

import {
  ProductTruthWebControlRuntimeError,
  loadProductTruthWebControlRuntime,
  type ProductTruthWebControlRuntimeActive,
} from "./product-truth-web-control-runtime";
import {
  verifyProductTruthWorkerBearer,
} from "./product-truth-web-control-worker-contract";
import {
  ProductTruthWebWorkerError,
} from "./product-truth-web-control-worker";

export function productTruthWorkerJson(
  body: unknown,
  init?: ResponseInit,
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-product-truth-worker-mode", "no-spend");
  return response;
}

export function productTruthWorkerErrorCode(error: unknown): string {
  if (
    error instanceof ProductTruthWebControlRuntimeError
    || error instanceof ProductTruthWebWorkerError
  ) {
    return error.code;
  }
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return "PRODUCT_TRUTH_WORKER_REQUEST_FAILED";
}

export function authenticateProductTruthWorker(
  request: NextRequest,
): ProductTruthWebControlRuntimeActive | NextResponse {
  let runtime;
  try {
    runtime = loadProductTruthWebControlRuntime();
  } catch (error) {
    return productTruthWorkerJson({
      ok: false,
      status: "BLOCKED",
      code: productTruthWorkerErrorCode(error),
    }, { status: 503 });
  }
  if (
    runtime.status === "OFF"
    || !runtime.claims.workerClaims
    || runtime.workerTokenSha256 === null
  ) {
    return productTruthWorkerJson({
      ok: false,
      status: "OFF",
      code: "PRODUCT_TRUTH_WORKER_DISABLED",
    }, { status: 503 });
  }
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.replace(/^Bearer\s+/iu, "").trim() ?? null;
  if (
    !authorization?.match(/^Bearer\s+/iu)
    || !verifyProductTruthWorkerBearer({
      bearer,
      expectedSha256: runtime.workerTokenSha256,
    })
  ) {
    return productTruthWorkerJson({
      ok: false,
      status: "UNAUTHORIZED",
      code: "PRODUCT_TRUTH_WORKER_UNAUTHORIZED",
    }, { status: 401 });
  }
  return runtime;
}

export async function exactWorkerBody(
  request: NextRequest,
): Promise<Record<string, unknown> | NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return productTruthWorkerJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "JSON body is required.",
    }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return productTruthWorkerJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "Request body must be an object.",
    }, { status: 400 });
  }
  return body as Record<string, unknown>;
}
