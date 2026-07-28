import { NextRequest, NextResponse } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import {
  PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS,
  readProductTruthControlCenterListings,
  readProductTruthControlCenterOperations,
  readProductTruthControlCenterOverview,
  readProductTruthControlCenterVariants,
} from "@/lib/sourcing/product-truth-control-center";
import {
  loadProductTruthControlCenterRuntime,
  openProductTruthControlCenterReadClient,
} from "@/lib/sourcing/product-truth-control-center-runtime";

export const dynamic = "force-dynamic";

function jsonNoStore(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-product-truth-mode", "read-only");
  return response;
}

function positiveInteger(
  raw: string | null,
  fallback: number,
  maximum: number,
): number | null {
  if (raw === null) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function code(error: unknown): string {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return "PRODUCT_TRUTH_CONTROL_CENTER_READ_FAILED";
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ view: string }> },
) {
  const auth = await requireModuleAccess(request, "catalog");
  if (auth instanceof NextResponse) return auth;

  let runtime;
  try {
    runtime = loadProductTruthControlCenterRuntime();
  } catch (error) {
    return jsonNoStore({
      ok: false,
      status: "BLOCKED",
      code: code(error),
      message:
        "Product Truth read-only runtime configuration is invalid; no database read was attempted.",
      claims: PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS,
    }, { status: 503 });
  }
  if (runtime.status === "OFF") {
    return jsonNoStore({
      ok: true,
      status: "OFF",
      reason: runtime.reason,
      claims: PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS,
    });
  }

  const { view } = await context.params;
  const params = request.nextUrl.searchParams;
  const readAt = new Date().toISOString();
  let db;
  try {
    db = await openProductTruthControlCenterReadClient(runtime);
    if (view === "overview") {
      const data = await readProductTruthControlCenterOverview(db, {
        runtime,
        readAt,
      });
      return jsonNoStore({ ok: true, status: "READ_ONLY", data });
    }
    if (view === "listings") {
      const channel = params.get("channel");
      const storeIndex = positiveInteger(params.get("store"), 1, 10_000);
      const limit = positiveInteger(params.get("limit"), 25, 50);
      if (
        (channel !== "amazon" && channel !== "walmart")
        || storeIndex === null
        || limit === null
      ) {
        return jsonNoStore({
          ok: false,
          status: "INVALID_REQUEST",
          message:
            "channel=amazon|walmart, positive store, and limit 1-50 are required.",
        }, { status: 400 });
      }
      const data = await readProductTruthControlCenterListings(db, {
        runtime,
        readAt,
        channel,
        storeIndex,
        cursor: params.get("cursor"),
        limit,
      });
      return jsonNoStore({ ok: true, status: "READ_ONLY", data });
    }
    if (view === "variants") {
      const limit = positiveInteger(params.get("limit"), 25, 50);
      if (limit === null) {
        return jsonNoStore({
          ok: false,
          status: "INVALID_REQUEST",
          message: "limit must be an integer from 1 to 50.",
        }, { status: 400 });
      }
      const query = params.get("q")?.trim() || null;
      const data = await readProductTruthControlCenterVariants(db, {
        runtime,
        readAt,
        query,
        cursor: params.get("cursor"),
        limit,
      });
      return jsonNoStore({ ok: true, status: "READ_ONLY", data });
    }
    if (view === "operations") {
      const limit = positiveInteger(params.get("limit"), 20, 50);
      if (limit === null) {
        return jsonNoStore({
          ok: false,
          status: "INVALID_REQUEST",
          message: "limit must be an integer from 1 to 50.",
        }, { status: 400 });
      }
      const data = await readProductTruthControlCenterOperations(db, {
        runtime,
        readAt,
        limit,
      });
      return jsonNoStore({ ok: true, status: "READ_ONLY", data });
    }
    return jsonNoStore({
      ok: false,
      status: "NOT_FOUND",
      message: "Unknown Product Truth read-only view.",
    }, { status: 404 });
  } catch (error) {
    return jsonNoStore({
      ok: false,
      status: "BLOCKED",
      code: code(error),
      message:
        "The canonical Product Truth projection failed closed; no legacy fallback was used.",
      claims: PRODUCT_TRUTH_CONTROL_CENTER_CLAIMS,
    }, { status: 503 });
  } finally {
    db?.close();
  }
}
