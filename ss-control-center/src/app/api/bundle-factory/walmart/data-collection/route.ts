import { createClient, type Client } from "@libsql/client";
import { NextRequest, NextResponse } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import { resolveWalmartStudioRequestIntent } from
  "@/lib/bundle-factory/walmart-studio-request";
import {
  diagnoseProductTruthWalmartPilotRequest,
} from "@/lib/sourcing/product-truth-read-contract";
import {
  readTargetedWalmartDonorSnapshot,
} from "@/lib/sourcing/product-truth-targeted-walmart-evidence";
import {
  ProductTruthWebControlAdmissionError,
  admitProductTruthWalmartCollectionBatch,
  readProductTruthWalmartCollectionStatus,
} from "@/lib/sourcing/product-truth-web-control-admission";
import {
  ProductTruthWebControlRuntimeError,
  loadProductTruthWebControlRuntime,
  productTruthWebControlPublicStatus,
} from "@/lib/sourcing/product-truth-web-control-runtime";
import {
  buildProductTruthWalmartCollectionBatch,
} from "@/lib/sourcing/product-truth-walmart-collection-contract";

export const dynamic = "force-dynamic";

function jsonNoStore(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-product-truth-control-mode", "no-spend");
  return response;
}

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^['"]|['"]$/g, "") || undefined;
}

function productTruthDb(): Client {
  const tursoUrl = cleanEnv(process.env.TURSO_DATABASE_URL);
  const tursoToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
  const databaseUrl = cleanEnv(process.env.DATABASE_URL);
  const url = tursoUrl && tursoToken ? tursoUrl : databaseUrl;
  if (!url) throw new Error("Product Truth database is not configured");
  return createClient({
    url,
    ...(tursoUrl && tursoToken ? { authToken: tursoToken } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalInteger(
  value: unknown,
  fallback: number,
): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > 500
  ) {
    return null;
  }
  return value;
}

function errorCode(error: unknown): string {
  if (
    error instanceof ProductTruthWebControlRuntimeError
    || error instanceof ProductTruthWebControlAdmissionError
  ) {
    return error.code;
  }
  return "PRODUCT_TRUTH_COLLECTION_FAILED";
}

export async function POST(request: NextRequest) {
  const auth = await requireModuleAccess(request, "bundle-factory");
  if (auth instanceof NextResponse) return auth;

  let runtime;
  try {
    runtime = loadProductTruthWebControlRuntime();
  } catch (error) {
    return jsonNoStore({
      ok: false,
      status: "BLOCKED",
      code: errorCode(error),
      message:
        "The Product Truth collection control configuration is invalid. No command was created.",
    }, { status: 503 });
  }
  if (runtime.status === "OFF") {
    return jsonNoStore({
      ok: false,
      status: "OFF",
      control: productTruthWebControlPublicStatus(runtime),
      message:
        "Product Truth collection admission is not activated. No provider call or database command was started.",
    }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonNoStore(
      { ok: false, status: "INVALID_REQUEST", message: "JSON body is required." },
      { status: 400 },
    );
  }
  if (!isRecord(body)) {
    return jsonNoStore(
      { ok: false, status: "INVALID_REQUEST", message: "Request must be an object." },
      { status: 400 },
    );
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const listingCount = optionalInteger(body.listing_count, 2);
  const packCount = optionalInteger(body.pack_count, 2);
  if (
    prompt.length < 3
    || prompt.length > 1_000
    || listingCount === null
    || packCount === null
  ) {
    return jsonNoStore({
      ok: false,
      status: "INVALID_REQUEST",
      message:
        "prompt must contain 3-1000 characters; listing_count and pack_count must be integers from 1 to 500.",
    }, { status: 400 });
  }

  const intent = resolveWalmartStudioRequestIntent({
    prompt,
    listingCount,
    packCount,
  });
  const inputConflicts = intent.blockers.filter(
    (blocker) => blocker.kind === "INPUT_CONFLICT",
  );
  if (inputConflicts.length > 0) {
    return jsonNoStore({
      ok: false,
      status: "INVALID_REQUEST",
      message: "The typed Walmart scope conflicts with the prompt.",
      blockers: inputConflicts,
    }, { status: 409 });
  }

  const db = productTruthDb();
  try {
    const diagnostic = await diagnoseProductTruthWalmartPilotRequest(db, {
      query: prompt,
      asOf: new Date().toISOString(),
      requireIngredients: true,
      requireNutrition: true,
      requireAllergens: true,
      limit: Math.max(20, Math.min(500, intent.listing_count * 4)),
    });
    const missingNeeded = Math.max(
      0,
      intent.listing_count - diagnostic.ready_variants,
    );
    const candidates = [];
    for (const candidate of diagnostic.candidates) {
      if (candidate.ready || candidates.length >= Math.min(5, missingNeeded)) {
        continue;
      }
      try {
        await readTargetedWalmartDonorSnapshot(
          db,
          candidate.donor_product_id,
        );
      } catch {
        continue;
      }
      candidates.push({
        donorProductId: candidate.donor_product_id,
        canonicalVariantId: candidate.canonical_variant_id,
        title: candidate.title,
        query: candidate.title,
        missingFields: candidate.missing,
      });
    }
    if (candidates.length < 1) {
      return jsonNoStore({
        ok: false,
        status: "NO_TARGETED_COLLECTION_TARGETS",
        message:
          diagnostic.matched_variants === 0
            ? "No exact donor variants matched. A bounded Product Truth demand-discovery workflow is required."
            : "The missing variants are not eligible for the one-donor targeted collector.",
        diagnosis: {
          matched_variants: diagnostic.matched_variants,
          ready_variants: diagnostic.ready_variants,
          requested_variants: intent.listing_count,
        },
      }, { status: 409 });
    }
    const requestedAt = new Date().toISOString();
    const batch = buildProductTruthWalmartCollectionBatch({
      requestedByUserId: auth.id,
      requestedAt,
      prompt,
      listingCount: intent.listing_count,
      packCount: intent.pack_count,
      unwrangleReserveFloor: runtime.unwrangleReserveFloor,
      candidates,
    });
    const status = await admitProductTruthWalmartCollectionBatch({
      batch,
      runtime,
    });
    return jsonNoStore({
      ok: true,
      status: status.status,
      control: productTruthWebControlPublicStatus(runtime),
      collection: status,
      limits: {
        requested_variants: intent.listing_count,
        admitted_jobs: status.jobs.length,
        maximum_jobs_per_click: 5,
        each_job_is_one_donor: true,
        provider_calls_started: false,
        metered_execution_admitted: false,
      },
    }, { status: 202 });
  } catch (error) {
    return jsonNoStore({
      ok: false,
      status: "BLOCKED",
      code: errorCode(error),
      message:
        "Product Truth collection admission failed closed. No provider call or Walmart action was started.",
    }, { status: 503 });
  } finally {
    db.close();
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireModuleAccess(request, "bundle-factory");
  if (auth instanceof NextResponse) return auth;
  const batchId = request.nextUrl.searchParams.get("batch_id")?.trim() ?? "";
  if (!/^ptbfw-[a-f0-9]{24}$/u.test(batchId)) {
    return jsonNoStore({
      ok: false,
      status: "INVALID_REQUEST",
      message: "A canonical batch_id is required.",
    }, { status: 400 });
  }
  let runtime;
  try {
    runtime = loadProductTruthWebControlRuntime();
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
    const status = await readProductTruthWalmartCollectionStatus({
      batchId,
      ...(auth.isAdmin ? {} : { requestedByUserId: auth.id }),
    });
    return jsonNoStore({
      ok: true,
      status: status.status,
      control: productTruthWebControlPublicStatus(runtime),
      collection: status,
    });
  } catch (error) {
    const code = errorCode(error);
    return jsonNoStore({
      ok: false,
      status: code === "WEB_CONTROL_BATCH_NOT_FOUND" ? "NOT_FOUND" : "BLOCKED",
      code,
    }, { status: code === "WEB_CONTROL_BATCH_NOT_FOUND" ? 404 : 503 });
  }
}
