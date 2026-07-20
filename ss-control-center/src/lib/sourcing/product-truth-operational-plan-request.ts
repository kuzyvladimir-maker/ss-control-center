import {
  buildProductTruthOperationalPlan,
  type ProductTruthOperationalMode,
  type ProductTruthOperationalPlan,
  type ProductTruthProviderCeiling,
  type ProductTruthSourcePolicy,
} from "./product-truth-operational-run-contract";
import type { Phase1ScopeManifest } from "./phase1-scope-manifest";

export const PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_VERSION =
  "product-truth-operational-plan-request/1.0.0" as const;

export interface ProductTruthOperationalPlanRequest {
  schemaVersion: typeof PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_VERSION;
  runId: string;
  mode: ProductTruthOperationalMode;
  createdAt: string;
  expiresAt: string;
  listingKeys: string[];
  sourcePolicy: ProductTruthSourcePolicy;
  providerCeilings: ProductTruthProviderCeiling[];
  verificationPolicy: {
    maxPriceAgeMs: number;
    minGalleryImages: 5;
  };
  maxWallClockMs: number;
}

export class ProductTruthOperationalPlanRequestError extends Error {
  readonly code = "PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_INVALID";

  constructor(message: string) {
    super(`PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_INVALID: ${message}`);
    this.name = "ProductTruthOperationalPlanRequestError";
  }
}

function fail(message: string): never {
  throw new ProductTruthOperationalPlanRequestError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) fail(`${label} must be exact text`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${label} must be a positive integer`);
  return Number(value);
}

export function parseProductTruthOperationalPlanRequest(
  value: unknown,
): ProductTruthOperationalPlanRequest {
  const input = record(value, "request");
  exactKeys(input, [
    "schemaVersion",
    "runId",
    "mode",
    "createdAt",
    "expiresAt",
    "listingKeys",
    "sourcePolicy",
    "providerCeilings",
    "verificationPolicy",
    "maxWallClockMs",
  ], "request");
  if (input.schemaVersion !== PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_VERSION) {
    fail(`schemaVersion must be ${PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_VERSION}`);
  }
  if (input.mode !== "CANARY" && input.mode !== "WAVE") fail("mode must be CANARY or WAVE");
  if (!Array.isArray(input.listingKeys) || input.listingKeys.some((key) => typeof key !== "string")) {
    fail("listingKeys must be a string array");
  }
  if (!Array.isArray(input.providerCeilings)) fail("providerCeilings must be an array");
  const verificationPolicy = record(input.verificationPolicy, "verificationPolicy");
  exactKeys(verificationPolicy, ["maxPriceAgeMs", "minGalleryImages"], "verificationPolicy");
  if (verificationPolicy.minGalleryImages !== 5) fail("minGalleryImages must be exactly 5");
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_VERSION,
    runId: text(input.runId, "runId"),
    mode: input.mode,
    createdAt: text(input.createdAt, "createdAt"),
    expiresAt: text(input.expiresAt, "expiresAt"),
    listingKeys: input.listingKeys.map((key, index) => text(key, `listingKeys[${index}]`)),
    sourcePolicy: input.sourcePolicy as ProductTruthSourcePolicy,
    providerCeilings: input.providerCeilings as ProductTruthProviderCeiling[],
    verificationPolicy: {
      maxPriceAgeMs: integer(verificationPolicy.maxPriceAgeMs, "maxPriceAgeMs"),
      minGalleryImages: 5,
    },
    maxWallClockMs: integer(input.maxWallClockMs, "maxWallClockMs"),
  };
}

export function buildProductTruthOperationalPlanFromRequest(input: {
  request: unknown;
  manifest: Phase1ScopeManifest;
  manifestSha256: string;
  targetFingerprint: string;
}): ProductTruthOperationalPlan {
  const request = parseProductTruthOperationalPlanRequest(input.request);
  return buildProductTruthOperationalPlan({
    runId: request.runId,
    mode: request.mode,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    targetFingerprint: input.targetFingerprint,
    manifest: input.manifest,
    manifestSha256: input.manifestSha256,
    listingKeys: request.listingKeys,
    sourcePolicy: request.sourcePolicy,
    providerCeilings: request.providerCeilings,
    verificationPolicy: request.verificationPolicy,
    maxWallClockMs: request.maxWallClockMs,
  });
}
