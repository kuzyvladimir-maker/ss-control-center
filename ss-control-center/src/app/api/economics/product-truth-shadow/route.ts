import { NextRequest, NextResponse } from "next/server";
import type { Transaction } from "@libsql/client";
import { timingSafeEqual } from "node:crypto";

import {
  readLegacyCogsForProductTruthShadow,
  readLegacyIncludedListingKeysForProductTruthShadow,
  readProductTruthUnitEconomicsShadowReport,
} from "@/lib/economics/product-truth-shadow";
import {
  loadProductTruthUnitEconomicsRuntime,
  openProductTruthConsumerReadClient,
} from "@/lib/sourcing/product-truth-consumer-runtime";
import { readProductTruthConsumerManifestScopePage } from
  "@/lib/sourcing/product-truth-consumer-gateway";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "@/lib/sourcing/product-truth-schema-gate";

export const dynamic = "force-dynamic";

let unitEconomicsShadowReadInFlight = false;

function jsonNoStore(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

function positiveInteger(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function errorCode(error: unknown): string {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) return error.code;
  return "PRODUCT_TRUTH_SHADOW_READ_FAILED";
}

function authorized(request: NextRequest, accessToken: string): boolean {
  const expected = Buffer.from(`Bearer ${accessToken}`, "utf8");
  const actual = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: NextRequest) {
  const readAt = new Date().toISOString();
  let runtime;
  try {
    runtime = loadProductTruthUnitEconomicsRuntime({ now: readAt });
  } catch (error) {
    return jsonNoStore({
      ok: false,
      status: "BLOCKED",
      code: errorCode(error),
      message: "Product Truth SHADOW activation is invalid; no database read was attempted.",
    }, { status: 503 });
  }
  if (runtime.status === "OFF") {
    return jsonNoStore({
      ok: true,
      schemaVersion: runtime.schemaVersion,
      status: "OFF",
      reason: runtime.reason,
      claims: {
        databaseReads: false,
        databaseWrites: false,
        providerCalls: false,
        marketplaceMutations: false,
      },
    });
  }
  if (!authorized(request, runtime.accessToken)) {
    return jsonNoStore({ ok: false, status: "UNAUTHORIZED" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const channel = params.get("marketplace");
  const storeIndex = positiveInteger(params.get("store"), 1);
  const limit = positiveInteger(
    params.get("limit"),
    runtime.validatedActivation.activation.readPolicy.batch.maxListingsPerBatch,
  );
  const cursor = params.get("cursor");
  if (
    (channel !== "amazon" && channel !== "walmart")
    || storeIndex === null
    || limit === null
    || limit > runtime.validatedActivation.activation.readPolicy.batch.maxListingsPerBatch
  ) {
    return jsonNoStore({
      ok: false,
      status: "INVALID_REQUEST",
      message: "marketplace=amazon|walmart, positive store, and an activation-bounded limit are required.",
    }, { status: 400 });
  }
  if (unitEconomicsShadowReadInFlight) {
    return jsonNoStore({
      ok: false,
      status: "BUSY",
      message: "The bounded SHADOW runtime permits one in-process batch at a time.",
    }, { status: 429 });
  }
  unitEconomicsShadowReadInFlight = true;

  let db;
  let transaction: Transaction | undefined;
  try {
    db = await openProductTruthConsumerReadClient(runtime);
    await assertProductTruthEvidenceSchema(db);
    await assertProductTruthListingScopeSchema(db);
    transaction = await db.transaction("read");
    const page = await readProductTruthConsumerManifestScopePage(transaction, {
      authoritativeManifestSha256:
        runtime.validatedActivation.activation.authoritativeManifestSha256,
      channel,
      storeIndex,
      cursor,
      limit,
      maximumPageSize:
        runtime.validatedActivation.activation.readPolicy.batch.maxListingsPerBatch,
    });
    if (page.scopes.length === 0) {
      return jsonNoStore({
        ok: true,
        status: "PAGE_EMPTY",
        mode: "SHADOW_COMPARE_ONLY",
        activationSha256: runtime.validatedActivation.activationSha256,
        authoritativeManifestSha256: page.authoritativeManifestSha256,
        page,
        report: null,
      });
    }

    const skus = page.scopes.map((scope) => scope.sku);
    const legacyBySku = await readLegacyCogsForProductTruthShadow(transaction, {
      skus,
      asOf: readAt,
    });
    const includedListingKeys =
      await readLegacyIncludedListingKeysForProductTruthShadow(transaction, {
      channel,
      storeIndex,
      scopes: page.scopes,
      asOf: readAt,
    });
    const legacyCostIds = [...new Set(
      [...legacyBySku.values()]
        .map((result) => result.skuCostId)
        .filter((value): value is string => Boolean(value)),
    )];
    const legacyCostListingKeys = new Map<string, string>();
    if (legacyCostIds.length) {
      const placeholders = legacyCostIds.map(() => "?").join(",");
      const links = await transaction.execute({
        sql: `SELECT skuCostId,listingKey
              FROM SkuCostListingScopeLink
              WHERE skuCostId IN (${placeholders})
              ORDER BY skuCostId ASC`,
        args: legacyCostIds,
      });
      links.rows.forEach((row) => {
        legacyCostListingKeys.set(String(row.skuCostId), String(row.listingKey));
      });
    }
    const report = await readProductTruthUnitEconomicsShadowReport(db, {
      validatedActivation: runtime.validatedActivation,
      page,
      legacyBySku,
      legacyIncludedListingKeys: includedListingKeys,
      legacyCostListingKeys,
      readAt,
      transaction,
    });
    return jsonNoStore({ ok: true, status: "SHADOW", report });
  } catch (error) {
    return jsonNoStore({
      ok: false,
      status: "BLOCKED",
      code: errorCode(error),
      message: "Product Truth SHADOW read failed; legacy economics output was not changed.",
    }, { status: 503 });
  } finally {
    transaction?.close();
    db?.close();
    unitEconomicsShadowReadInFlight = false;
  }
}
