import { NextRequest, NextResponse } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import {
  ProductTruthWalmartEnrichmentAdmissionError,
  authorizeProductTruthWalmartEnrichment,
  declineProductTruthWalmartEnrichment,
  prepareProductTruthWalmartEnrichmentApproval,
} from "@/lib/sourcing/product-truth-walmart-enrichment-admission";
import {
  ProductTruthWebControlRuntimeError,
  loadProductTruthWalmartEnrichmentRuntime,
  productTruthWebControlPublicStatus,
} from "@/lib/sourcing/product-truth-web-control-runtime";

export const dynamic = "force-dynamic";

function jsonNoStore(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  response.headers.set(
    "x-product-truth-control-mode",
    "owner-gated-metered",
  );
  return response;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (
    error instanceof ProductTruthWalmartEnrichmentAdmissionError
    || error instanceof ProductTruthWebControlRuntimeError
  ) {
    return error.code;
  }
  return "PRODUCT_TRUTH_ENRICHMENT_APPROVAL_FAILED";
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ batchId: string }> },
) {
  const auth = await requireModuleAccess(request, "bundle-factory");
  if (auth instanceof NextResponse) return auth;
  if (!auth.isAdmin) {
    return jsonNoStore({
      ok: false,
      status: "FORBIDDEN",
      message: "Only an administrator may approve provider credits.",
    }, { status: 403 });
  }
  const { batchId } = await context.params;
  if (!/^ptbfw-[a-f0-9]{24}$/u.test(batchId)) {
    return jsonNoStore({
      ok: false,
      status: "INVALID_REQUEST",
      message: "A canonical batch id is required.",
    }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonNoStore({
      ok: false,
      status: "INVALID_REQUEST",
      message: "JSON body is required.",
    }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.action !== "string") {
    return jsonNoStore({
      ok: false,
      status: "INVALID_REQUEST",
      message: "An exact action is required.",
    }, { status: 400 });
  }
  let runtime;
  try {
    runtime = loadProductTruthWalmartEnrichmentRuntime();
  } catch (error) {
    return jsonNoStore({
      ok: false,
      status: "BLOCKED",
      code: errorCode(error),
    }, { status: 503 });
  }
  if (runtime.status === "OFF") {
    return jsonNoStore({
      ok: false,
      status: "OFF",
      control: productTruthWebControlPublicStatus(runtime),
    }, { status: 503 });
  }

  try {
    if (body.action === "PREPARE_OWNER_AUTHORIZATION") {
      if (
        typeof body.quote_sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(body.quote_sha256)
      ) {
        return jsonNoStore({
          ok: false,
          status: "INVALID_REQUEST",
          message: "The displayed exact quote hash is required.",
        }, { status: 400 });
      }
      const approval = await prepareProductTruthWalmartEnrichmentApproval({
        batchId,
        requestedByUserId: auth.id,
        expectedQuoteSha256: body.quote_sha256,
        runtime,
      });
      return jsonNoStore({
        ok: true,
        status: "AWAITING_LOCAL_OWNER_SIGNATURE",
        control: productTruthWebControlPublicStatus(runtime),
        approval,
      });
    }
    if (body.action === "AUTHORIZE") {
      if (
        typeof body.command_id !== "string"
        || !/^ptc-[a-f0-9]{32}$/u.test(body.command_id)
        || typeof body.signature_base64 !== "string"
        || body.signature_base64.length < 80
        || body.signature_base64.length > 100
      ) {
        return jsonNoStore({
          ok: false,
          status: "INVALID_REQUEST",
          message: "Exact command id and detached signature are required.",
        }, { status: 400 });
      }
      const admitted = await authorizeProductTruthWalmartEnrichment({
        commandId: body.command_id,
        requestedByUserId: auth.id,
        signatureBase64: body.signature_base64,
        runtime,
      });
      return jsonNoStore({
        ok: true,
        status: admitted.status,
        command_id: admitted.command_id,
        message:
          "Exact enrichment was admitted. No Walmart listing publication is authorized.",
      }, { status: 202 });
    }
    if (body.action === "DECLINE") {
      const declined = await declineProductTruthWalmartEnrichment({
        batchId,
        requestedByUserId: auth.id,
        runtime,
      });
      return jsonNoStore({
        ok: true,
        status: declined.status,
        command_id: declined.command_id,
        provider_calls: 0,
        marketplace_mutations: 0,
      });
    }
    return jsonNoStore({
      ok: false,
      status: "INVALID_REQUEST",
      message: "Unsupported approval action.",
    }, { status: 400 });
  } catch (error) {
    const code = errorCode(error);
    return jsonNoStore({
      ok: false,
      status: "BLOCKED",
      code,
      message:
        error instanceof Error
          ? error.message
          : "Owner-gated enrichment failed closed.",
    }, {
      status:
        code === "ENRICHMENT_QUOTE_CHANGED"
        || code === "ENRICHMENT_OWNER_REQUEST_NOT_CURRENT"
          ? 409
          : 503,
    });
  }
}
