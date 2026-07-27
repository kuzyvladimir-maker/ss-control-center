import { createHash } from "node:crypto";

import {
  METERED_PROVIDERS,
  decodeMeteredRunPermit,
  expectedMeteredRunConfirmation,
  type MeteredProvider,
  type MeteredProviderAllowance,
  type MeteredRunPermit,
} from "./metered-call-guard";
import {
  PHASE1_SCOPE_MANIFEST_VERSION,
  renderPhase1ScopeManifestJson,
  validatePhase1ScopeManifestV3Policy,
  type Phase1ScopeManifest,
} from "./phase1-scope-manifest";
import {
  PRODUCT_TRUTH_LISTING_KEY_VERSION,
  buildProductTruthListingScope,
} from "./product-truth-listing-scope";

export const PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION =
  "product-truth-operational-plan/1.0.0" as const;
export const PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION =
  "product-truth-operational-approval/1.0.0" as const;
export const PRODUCT_TRUTH_OPERATIONAL_RESULT_VERSION =
  "product-truth-operational-result/1.0.0" as const;

export const PRODUCT_TRUTH_OPERATIONAL_FIELDS = [
  "identity",
  "offers",
  "content",
  "cogs",
] as const;

export type ProductTruthOperationalField =
  (typeof PRODUCT_TRUTH_OPERATIONAL_FIELDS)[number];
export type ProductTruthOperationalMode = "CANARY" | "WAVE";

export interface ProductTruthSourcePolicy {
  procurementZip: "33765";
  retailers: readonly ("walmart" | "target" | "publix" | "samsclub" | "costco")[];
  allowClubs: boolean;
  allowBjs: false;
  listingConcurrency: 1;
  componentConcurrency: 1;
  maxAttemptsPerListing: 1;
}

export interface ProductTruthProviderCeiling {
  provider: MeteredProvider;
  operations: readonly string[];
  maxCalls: number;
  maxUnits: number | null;
  reserveFloor: number | null;
}

export interface ProductTruthOperationalTarget {
  ordinal: number;
  listingKey: string;
  listingKeyVersion: typeof PRODUCT_TRUTH_LISTING_KEY_VERSION;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  requestedFields: readonly ProductTruthOperationalField[];
}

export interface ProductTruthOperationalPlan {
  schemaVersion: typeof PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION;
  runId: string;
  mode: ProductTruthOperationalMode;
  createdAt: string;
  expiresAt: string;
  targetFingerprint: string;
  manifest: {
    schemaVersion: typeof PHASE1_SCOPE_MANIFEST_VERSION;
    sha256: string;
    asOf: string;
    liveListings: number;
  };
  targetSetSha256: string;
  targets: readonly ProductTruthOperationalTarget[];
  sourcePolicy: ProductTruthSourcePolicy;
  providerCeilings: readonly ProductTruthProviderCeiling[];
  verificationPolicy: {
    maxPriceAgeMs: number;
    minGalleryImages: 5;
  };
  maxWallClockMs: number;
  claims: {
    defaultDryRun: true;
    automaticPublish: false;
    automaticDelist: false;
    automaticReprice: false;
    automaticPurchase: false;
  };
}

export interface ProductTruthBalanceEvidence {
  provider: "unwrangle";
  observedAt: string;
  balanceUnits: number;
  reserveFloor: number;
  evidenceSha256: string;
}

export interface ProductTruthOperationalApproval {
  schemaVersion: typeof PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION;
  approvedBy: "owner";
  runId: string;
  approvalId: string;
  action: "EXECUTE_CANARY" | "EXECUTE_WAVE";
  planSha256: string;
  targetFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  meteredPermit: MeteredRunPermit;
  balanceEvidence: readonly ProductTruthBalanceEvidence[];
}

export interface ValidatedProductTruthOperationalApproval {
  approval: ProductTruthOperationalApproval;
  permit: MeteredRunPermit;
  encodedPermit: string;
  meteredConfirmation: string;
  executionConfirmation: string;
}

export class ProductTruthOperationalContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthOperationalContractError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthOperationalContractError(code, message);
}

function exactText(value: unknown, label: string, maximum = 200): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
  ) {
    fail("OPERATIONAL_INPUT_INVALID", `${label} must be 1-${maximum} exact characters`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  const text = exactText(value, label, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    fail("OPERATIONAL_INPUT_INVALID", `${label} contains unsafe characters`);
  }
  return text;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = exactText(value, label, 80);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    fail("OPERATIONAL_INPUT_INVALID", `${label} must include an explicit timezone`);
  }
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    fail("OPERATIONAL_INPUT_INVALID", `${label} must be a valid timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256(value: unknown, label: string): string {
  const text = exactText(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    fail("OPERATIONAL_INPUT_INVALID", `${label} must be a SHA-256 digest`);
  }
  return text;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("OPERATIONAL_INPUT_INVALID", `${label} must be a non-negative finite number`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    fail("OPERATIONAL_INPUT_INVALID", `${label} must be an integer between 1 and ${maximum}`);
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    fail(
      "OPERATIONAL_INPUT_INVALID",
      `${label} keys must be exactly: ${canonical.join(", ")}`,
    );
  }
}

function canonicalJsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("OPERATIONAL_HASH_INVALID", "non-finite number in canonical JSON");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === undefined) {
    fail("OPERATIONAL_HASH_INVALID", "canonical JSON accepts JSON data only");
  }
  if (seen.has(value)) fail("OPERATIONAL_HASH_INVALID", "canonical JSON cannot contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item, seen));
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) {
        fail("OPERATIONAL_HASH_INVALID", `undefined is not allowed at ${key}`);
      }
      result[key] = canonicalJsonValue(record[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function renderProductTruthOperationalJson(value: unknown): string {
  return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}

export function productTruthOperationalSha256(value: unknown): string {
  return sha256Text(renderProductTruthOperationalJson(value));
}

function parseManifest(value: unknown): Phase1ScopeManifest {
  if (!isRecord(value)) fail("MANIFEST_INVALID", "manifest must be an object");
  const manifest = value as unknown as Phase1ScopeManifest;
  if (manifest.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION) {
    fail("MANIFEST_INVALID", `manifest must use ${PHASE1_SCOPE_MANIFEST_VERSION}`);
  }
  const policyErrors = validatePhase1ScopeManifestV3Policy(manifest);
  if (policyErrors.length > 0) {
    fail(
      "MANIFEST_INVALID",
      `manifest v3 policy binding is invalid: ${policyErrors.join("; ")}`,
    );
  }
  if (manifest.authoritative !== true || !Array.isArray(manifest.blockers) || manifest.blockers.length) {
    fail("MANIFEST_NOT_AUTHORITATIVE", "manifest must be authoritative with zero blockers");
  }
  if (!Array.isArray(manifest.listings) || manifest.listings.length < 1) {
    fail("MANIFEST_INVALID", "manifest must contain live listings");
  }
  if (manifest.counts?.liveListings !== manifest.listings.length) {
    fail("MANIFEST_INVALID", "manifest live listing count does not reconcile");
  }
  canonicalInstant(manifest.asOf, "manifest.asOf");
  return manifest;
}

function canonicalProviders(
  values: readonly ProductTruthProviderCeiling[],
  sourcePolicy: ProductTruthSourcePolicy,
): ProductTruthProviderCeiling[] {
  if (!Array.isArray(values)) fail("OPERATIONAL_INPUT_INVALID", "providerCeilings must be an array");
  const providers = new Set<MeteredProvider>();
  const result = values.map((item) => {
    if (
      !isRecord(item)
      || typeof item.provider !== "string"
      || !(METERED_PROVIDERS as readonly string[]).includes(item.provider)
    ) {
      fail("OPERATIONAL_INPUT_INVALID", "providerCeilings contains an unknown provider");
    }
    const provider = item.provider as MeteredProvider;
    if (provider !== "oxylabs" && provider !== "unwrangle") {
      fail(
        "PROVIDER_ROUTE_FORBIDDEN",
        `${provider} is not an authorized Product Truth v1 paid route`,
      );
    }
    if (providers.has(provider)) fail("OPERATIONAL_INPUT_INVALID", `duplicate provider ceiling ${provider}`);
    providers.add(provider);
    if (!Array.isArray(item.operations) || item.operations.length < 1) {
      fail("OPERATIONAL_INPUT_INVALID", `${provider}.operations must be non-empty`);
    }
    const operations = [...new Set(item.operations.map((operation, index) => (
      exactText(operation, `${provider}.operations[${index}]`, 100)
    )))].sort();
    if (operations.length !== item.operations.length) {
      fail("OPERATIONAL_INPUT_INVALID", `${provider}.operations contains duplicates`);
    }
    const allowedOperations = provider === "oxylabs"
      ? new Set(["query"])
      : new Set(["detail", "search"]);
    if (operations.some((operation) => !allowedOperations.has(operation))) {
      fail(
        "PROVIDER_ROUTE_FORBIDDEN",
        `${provider} contains an operation outside the v1 route contract`,
      );
    }
    const maxCalls = positiveInteger(item.maxCalls, `${provider}.maxCalls`, 1_000_000);
    const maxUnits = item.maxUnits === null
      ? null
      : finiteNonNegative(item.maxUnits, `${provider}.maxUnits`);
    if (maxUnits === 0) fail("OPERATIONAL_INPUT_INVALID", `${provider}.maxUnits must be positive or null`);
    const reserveFloor = item.reserveFloor === null
      ? null
      : finiteNonNegative(item.reserveFloor, `${provider}.reserveFloor`);
    if (provider === "unwrangle" && (maxUnits === null || reserveFloor === null)) {
      fail("UNWRANGLE_FLOOR_REQUIRED", "Unwrangle requires both maxUnits and reserveFloor");
    }
    if (provider !== "unwrangle" && reserveFloor !== null) {
      fail("OPERATIONAL_INPUT_INVALID", `${provider} cannot declare an unsupported reserve floor`);
    }
    return { provider, operations, maxCalls, maxUnits, reserveFloor };
  }).sort((a, b) => a.provider.localeCompare(b.provider, "en-US"));

  if (!sourcePolicy.allowClubs) {
    const unwrangle = result.find((item) => item.provider === "unwrangle");
    if (unwrangle?.operations.some((operation) => /sams|costco|club/i.test(operation))) {
      fail("CLUBS_NOT_AUTHORIZED", "club operations are forbidden by this source policy");
    }
  }
  const byProvider = new Map(result.map((item) => [item.provider, item]));
  const required = (
    provider: "oxylabs" | "unwrangle",
    operation: string,
    reason: string,
  ) => {
    if (!byProvider.get(provider)?.operations.includes(operation)) {
      fail(
        "PROVIDER_CEILING_INCOMPLETE",
        `${provider}:${operation} is required for ${reason}`,
      );
    }
  };
  if (sourcePolicy.retailers.includes("walmart")) {
    required("oxylabs", "query", "Walmart first-party search");
    required("unwrangle", "detail", "Walmart full-content harvest");
  }
  if (sourcePolicy.retailers.some((retailer) => (
    retailer === "target" || retailer === "samsclub" || retailer === "costco"
  ))) {
    required("unwrangle", "search", "selected Unwrangle retailer search");
    required("unwrangle", "detail", "selected Unwrangle retailer full-content harvest");
  }
  return result;
}

function validateSourcePolicy(value: ProductTruthSourcePolicy): ProductTruthSourcePolicy {
  if (!isRecord(value)) fail("OPERATIONAL_INPUT_INVALID", "sourcePolicy must be an object");
  if (value.procurementZip !== "33765") fail("OPERATIONAL_INPUT_INVALID", "procurement ZIP is fixed to 33765");
  if (value.allowBjs !== false) fail("BJS_FORBIDDEN", "BJ's is hard-disabled");
  if (value.listingConcurrency !== 1 || value.componentConcurrency !== 1) {
    fail("CONCURRENCY_UNSAFE", "v1 runner requires listing and component concurrency of exactly 1");
  }
  if (value.maxAttemptsPerListing !== 1) {
    fail("ATTEMPT_POLICY_UNSAFE", "v1 runner permits one paid attempt per listing per approved run");
  }
  if (!Array.isArray(value.retailers) || value.retailers.length < 1) {
    fail("OPERATIONAL_INPUT_INVALID", "sourcePolicy.retailers must be non-empty");
  }
  const allowed = new Set(["walmart", "target", "publix", "samsclub", "costco"]);
  const retailers = [...new Set(value.retailers)];
  if (retailers.length !== value.retailers.length || retailers.some((retailer) => !allowed.has(retailer))) {
    fail("OPERATIONAL_INPUT_INVALID", "sourcePolicy.retailers contains duplicates or unknown retailers");
  }
  // The executable v1 costing path always begins with its calibrated Walmart
  // first-party route. A plan may narrow every other retailer, but it cannot
  // seal a policy that the runtime would be unable to honor exactly.
  if (!retailers.includes("walmart")) {
    fail("SOURCE_POLICY_INCOMPLETE", "Product Truth v1 requires the Walmart first-party route");
  }
  const containsClub = retailers.some((retailer) => retailer === "samsclub" || retailer === "costco");
  if (containsClub !== value.allowClubs) {
    fail("CLUBS_NOT_AUTHORIZED", "allowClubs must exactly match the selected retailer set");
  }
  return {
    procurementZip: "33765",
    retailers,
    allowClubs: value.allowClubs,
    allowBjs: false,
    listingConcurrency: 1,
    componentConcurrency: 1,
    maxAttemptsPerListing: 1,
  };
}

export interface BuildProductTruthOperationalPlanInput {
  runId: string;
  mode: ProductTruthOperationalMode;
  createdAt: string;
  expiresAt: string;
  targetFingerprint: string;
  manifest: unknown;
  manifestSha256: string;
  listingKeys: readonly string[];
  sourcePolicy: ProductTruthSourcePolicy;
  providerCeilings: readonly ProductTruthProviderCeiling[];
  verificationPolicy: {
    maxPriceAgeMs: number;
    minGalleryImages: 5;
  };
  maxWallClockMs: number;
}

export function buildProductTruthOperationalPlan(
  input: BuildProductTruthOperationalPlanInput,
): ProductTruthOperationalPlan {
  const runId = safeIdentifier(input.runId, "runId");
  if (input.mode !== "CANARY" && input.mode !== "WAVE") {
    fail("OPERATIONAL_INPUT_INVALID", "mode must be CANARY or WAVE");
  }
  const createdAt = canonicalInstant(input.createdAt, "createdAt");
  const expiresAt = canonicalInstant(input.expiresAt, "expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1_000) {
    fail("OPERATIONAL_INPUT_INVALID", "plan lifetime must be positive and at most 24 hours");
  }
  const targetFingerprint = sha256(input.targetFingerprint, "targetFingerprint");
  const manifest = parseManifest(input.manifest);
  const manifestSha256 = sha256(input.manifestSha256, "manifestSha256");
  if (sha256Text(renderPhase1ScopeManifestJson(manifest)) !== manifestSha256) {
    fail("MANIFEST_HASH_MISMATCH", "manifest bytes do not match manifestSha256");
  }
  if (!Array.isArray(input.listingKeys)) {
    fail("OPERATIONAL_INPUT_INVALID", "listingKeys must be an explicit array");
  }
  const minimum = input.mode === "CANARY" ? 5 : 1;
  const maximum = input.mode === "CANARY" ? 10 : 100;
  if (input.listingKeys.length < minimum || input.listingKeys.length > maximum) {
    fail(
      "OPERATIONAL_SCOPE_INVALID",
      `${input.mode} requires ${minimum}-${maximum} explicit listing keys`,
    );
  }
  if (new Set(input.listingKeys).size !== input.listingKeys.length) {
    fail("OPERATIONAL_SCOPE_INVALID", "listingKeys must not contain duplicates");
  }
  const byKey = new Map(manifest.listings.map((listing) => [listing.listingKey, listing]));
  const targets = input.listingKeys.map((listingKey, ordinal): ProductTruthOperationalTarget => {
    exactText(listingKey, `listingKeys[${ordinal}]`, 500);
    const listing = byKey.get(listingKey);
    if (!listing) fail("OPERATIONAL_SCOPE_INVALID", `${listingKey} is absent from the authoritative manifest`);
    const scope = buildProductTruthListingScope({
      channel: listing.channel,
      storeIndex: listing.storeIndex,
      sku: listing.sku,
    });
    if (scope.channel !== "amazon" && scope.channel !== "walmart") {
      fail("OPERATIONAL_SCOPE_INVALID", `${listingKey} uses an unsupported channel`);
    }
    if (scope.listingKey !== listing.listingKey) {
      fail("OPERATIONAL_SCOPE_INVALID", `${listingKey} contradicts its exact listing scope`);
    }
    return {
      ordinal,
      listingKey: scope.listingKey,
      listingKeyVersion: scope.keyVersion,
      channel: scope.channel as "amazon" | "walmart",
      storeIndex: scope.storeIndex,
      sku: scope.sku,
      requestedFields: [...PRODUCT_TRUTH_OPERATIONAL_FIELDS],
    };
  });
  const sourcePolicy = validateSourcePolicy(input.sourcePolicy);
  const providerCeilings = canonicalProviders(input.providerCeilings, sourcePolicy);
  if (!isRecord(input.verificationPolicy)) {
    fail("OPERATIONAL_INPUT_INVALID", "verificationPolicy must be an object");
  }
  assertExactKeys(
    input.verificationPolicy as unknown as Record<string, unknown>,
    ["maxPriceAgeMs", "minGalleryImages"],
    "verificationPolicy",
  );
  const maxPriceAgeMs = positiveInteger(
    input.verificationPolicy.maxPriceAgeMs,
    "verificationPolicy.maxPriceAgeMs",
    30 * 24 * 60 * 60 * 1_000,
  );
  if (input.verificationPolicy.minGalleryImages !== 5) {
    fail("OPERATIONAL_INPUT_INVALID", "v1 requires exactly five gallery images");
  }
  const maxWallClockMs = positiveInteger(input.maxWallClockMs, "maxWallClockMs", 24 * 60 * 60 * 1_000);
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
    runId,
    mode: input.mode,
    createdAt,
    expiresAt,
    targetFingerprint,
    manifest: {
      schemaVersion: PHASE1_SCOPE_MANIFEST_VERSION,
      sha256: manifestSha256,
      asOf: new Date(Date.parse(manifest.asOf)).toISOString(),
      liveListings: manifest.listings.length,
    },
    targetSetSha256: productTruthOperationalSha256(targets),
    targets,
    sourcePolicy,
    providerCeilings,
    verificationPolicy: {
      maxPriceAgeMs,
      minGalleryImages: 5,
    },
    maxWallClockMs,
    claims: {
      defaultDryRun: true,
      automaticPublish: false,
      automaticDelist: false,
      automaticReprice: false,
      automaticPurchase: false,
    },
  };
}

/**
 * Validate an untrusted serialized plan without consulting ambient state.
 * Execution still has to prove the full authoritative manifest bytes and the
 * registered listing rows separately; this function prevents a cast from
 * bypassing any v1 source, concurrency, field, or budget invariant.
 */
export function parseProductTruthOperationalPlan(
  value: unknown,
): ProductTruthOperationalPlan {
  if (!isRecord(value)) fail("PLAN_INVALID", "plan must be an object");
  assertExactKeys(value, [
    "schemaVersion",
    "runId",
    "mode",
    "createdAt",
    "expiresAt",
    "targetFingerprint",
    "manifest",
    "targetSetSha256",
    "targets",
    "sourcePolicy",
    "providerCeilings",
    "verificationPolicy",
    "maxWallClockMs",
    "claims",
  ], "plan");
  if (value.schemaVersion !== PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION) {
    fail("PLAN_INVALID", `plan must use ${PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION}`);
  }
  const runId = safeIdentifier(value.runId, "plan.runId");
  if (value.mode !== "CANARY" && value.mode !== "WAVE") {
    fail("PLAN_INVALID", "plan.mode must be CANARY or WAVE");
  }
  const mode = value.mode;
  const createdAt = canonicalInstant(value.createdAt, "plan.createdAt");
  const expiresAt = canonicalInstant(value.expiresAt, "plan.expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1_000) {
    fail("PLAN_INVALID", "plan lifetime must be positive and at most 24 hours");
  }
  const targetFingerprint = sha256(value.targetFingerprint, "plan.targetFingerprint");

  if (!isRecord(value.manifest)) fail("PLAN_INVALID", "plan.manifest must be an object");
  assertExactKeys(
    value.manifest,
    ["schemaVersion", "sha256", "asOf", "liveListings"],
    "plan.manifest",
  );
  if (value.manifest.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION) {
    fail("PLAN_INVALID", `plan manifest must use ${PHASE1_SCOPE_MANIFEST_VERSION}`);
  }
  const manifestSha256 = sha256(value.manifest.sha256, "plan.manifest.sha256");
  const manifestAsOf = canonicalInstant(value.manifest.asOf, "plan.manifest.asOf");
  const liveListings = positiveInteger(
    value.manifest.liveListings,
    "plan.manifest.liveListings",
    10_000_000,
  );

  if (!Array.isArray(value.targets)) fail("PLAN_INVALID", "plan.targets must be an array");
  const minimum = mode === "CANARY" ? 5 : 1;
  const maximum = mode === "CANARY" ? 10 : 100;
  if (value.targets.length < minimum || value.targets.length > maximum) {
    fail("OPERATIONAL_SCOPE_INVALID", `${mode} requires ${minimum}-${maximum} targets`);
  }
  const targets = value.targets.map((raw, ordinal): ProductTruthOperationalTarget => {
    if (!isRecord(raw)) fail("PLAN_INVALID", `plan.targets[${ordinal}] must be an object`);
    assertExactKeys(raw, [
      "ordinal",
      "listingKey",
      "listingKeyVersion",
      "channel",
      "storeIndex",
      "sku",
      "requestedFields",
    ], `plan.targets[${ordinal}]`);
    if (raw.ordinal !== ordinal) {
      fail("OPERATIONAL_SCOPE_INVALID", "target ordinals must be contiguous and ordered");
    }
    if (raw.channel !== "amazon" && raw.channel !== "walmart") {
      fail("OPERATIONAL_SCOPE_INVALID", `target ${ordinal} has an unsupported channel`);
    }
    const scope = buildProductTruthListingScope({
      channel: raw.channel,
      storeIndex: positiveInteger(raw.storeIndex, `target ${ordinal}.storeIndex`, 1_000_000),
      sku: exactText(raw.sku, `target ${ordinal}.sku`, 500),
    });
    if (
      raw.listingKeyVersion !== PRODUCT_TRUTH_LISTING_KEY_VERSION
      || raw.listingKey !== scope.listingKey
    ) {
      fail("OPERATIONAL_SCOPE_INVALID", `target ${ordinal} listing identity is inconsistent`);
    }
    if (
      !Array.isArray(raw.requestedFields)
      || raw.requestedFields.length !== PRODUCT_TRUTH_OPERATIONAL_FIELDS.length
      || raw.requestedFields.some((field, index) => field !== PRODUCT_TRUTH_OPERATIONAL_FIELDS[index])
    ) {
      fail("OPERATIONAL_SCOPE_INVALID", `target ${ordinal} must request the complete v1 field set`);
    }
    return {
      ordinal,
      listingKey: scope.listingKey,
      listingKeyVersion: PRODUCT_TRUTH_LISTING_KEY_VERSION,
      channel: raw.channel,
      storeIndex: scope.storeIndex,
      sku: scope.sku,
      requestedFields: [...PRODUCT_TRUTH_OPERATIONAL_FIELDS],
    };
  });
  if (new Set(targets.map((target) => target.listingKey)).size !== targets.length) {
    fail("OPERATIONAL_SCOPE_INVALID", "plan targets contain duplicate listing scopes");
  }
  const targetSetSha256 = sha256(value.targetSetSha256, "plan.targetSetSha256");
  if (productTruthOperationalSha256(targets) !== targetSetSha256) {
    fail("PLAN_HASH_MISMATCH", "plan targetSetSha256 does not match its targets");
  }

  const sourcePolicy = validateSourcePolicy(value.sourcePolicy as ProductTruthSourcePolicy);
  if (renderProductTruthOperationalJson(sourcePolicy) !== renderProductTruthOperationalJson(value.sourcePolicy)) {
    fail("PLAN_INVALID", "plan source policy is not canonical");
  }
  const providerCeilings = canonicalProviders(
    value.providerCeilings as readonly ProductTruthProviderCeiling[],
    sourcePolicy,
  );
  if (renderProductTruthOperationalJson(providerCeilings) !== renderProductTruthOperationalJson(value.providerCeilings)) {
    fail("PLAN_INVALID", "plan provider ceilings are not canonical");
  }

  if (!isRecord(value.verificationPolicy)) {
    fail("PLAN_INVALID", "plan.verificationPolicy must be an object");
  }
  assertExactKeys(
    value.verificationPolicy,
    ["maxPriceAgeMs", "minGalleryImages"],
    "plan.verificationPolicy",
  );
  const maxPriceAgeMs = positiveInteger(
    value.verificationPolicy.maxPriceAgeMs,
    "plan.verificationPolicy.maxPriceAgeMs",
    30 * 24 * 60 * 60 * 1_000,
  );
  if (value.verificationPolicy.minGalleryImages !== 5) {
    fail("PLAN_INVALID", "plan verification requires exactly five gallery images");
  }
  const maxWallClockMs = positiveInteger(
    value.maxWallClockMs,
    "plan.maxWallClockMs",
    24 * 60 * 60 * 1_000,
  );

  if (!isRecord(value.claims)) fail("PLAN_INVALID", "plan.claims must be an object");
  assertExactKeys(value.claims, [
    "defaultDryRun",
    "automaticPublish",
    "automaticDelist",
    "automaticReprice",
    "automaticPurchase",
  ], "plan.claims");
  if (
    value.claims.defaultDryRun !== true
    || value.claims.automaticPublish !== false
    || value.claims.automaticDelist !== false
    || value.claims.automaticReprice !== false
    || value.claims.automaticPurchase !== false
  ) {
    fail("PLAN_INVALID", "plan mutation claims violate the v1 safety boundary");
  }

  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_PLAN_VERSION,
    runId,
    mode,
    createdAt,
    expiresAt,
    targetFingerprint,
    manifest: {
      schemaVersion: PHASE1_SCOPE_MANIFEST_VERSION,
      sha256: manifestSha256,
      asOf: manifestAsOf,
      liveListings,
    },
    targetSetSha256,
    targets,
    sourcePolicy,
    providerCeilings,
    verificationPolicy: { maxPriceAgeMs, minGalleryImages: 5 },
    maxWallClockMs,
    claims: {
      defaultDryRun: true,
      automaticPublish: false,
      automaticDelist: false,
      automaticReprice: false,
      automaticPurchase: false,
    },
  };
}

/** Prove that execution is using the same full authoritative manifest as plan. */
export function assertProductTruthOperationalManifestBinding(input: {
  plan: ProductTruthOperationalPlan;
  manifest: unknown;
  manifestJson: string;
}): Phase1ScopeManifest {
  const plan = parseProductTruthOperationalPlan(input.plan);
  const manifest = parseManifest(input.manifest);
  const canonical = renderPhase1ScopeManifestJson(manifest);
  if (input.manifestJson !== canonical) {
    fail("MANIFEST_HASH_MISMATCH", "execution manifest bytes are not canonical");
  }
  if (
    sha256Text(input.manifestJson) !== plan.manifest.sha256
    || new Date(Date.parse(manifest.asOf)).toISOString() !== plan.manifest.asOf
    || manifest.listings.length !== plan.manifest.liveListings
  ) {
    fail("MANIFEST_HASH_MISMATCH", "execution manifest differs from the sealed plan");
  }
  const listings = new Map(manifest.listings.map((listing) => [listing.listingKey, listing]));
  for (const target of plan.targets) {
    const listing = listings.get(target.listingKey);
    if (
      !listing
      || listing.channel !== target.channel
      || listing.storeIndex !== target.storeIndex
      || listing.sku !== target.sku
    ) {
      fail("OPERATIONAL_SCOPE_INVALID", `${target.listingKey} is not exact in the execution manifest`);
    }
  }
  return manifest;
}

export function expectedProductTruthExecutionConfirmation(
  planSha256: string,
  approvalId: string,
): string {
  return `EXECUTE_PRODUCT_TRUTH_PLAN_V1:${sha256(planSha256, "planSha256")}:${safeIdentifier(approvalId, "approvalId")}`;
}

function allowanceEqualsCeiling(
  allowance: MeteredProviderAllowance,
  ceiling: ProductTruthProviderCeiling,
): boolean {
  const operations = [...new Set(allowance.operations)].sort();
  return operations.length === ceiling.operations.length
    && operations.every((operation, index) => operation === ceiling.operations[index])
    && allowance.maxCalls === ceiling.maxCalls
    && (allowance.maxUnits ?? null) === ceiling.maxUnits;
}

export function validateProductTruthOperationalApproval(input: {
  plan: ProductTruthOperationalPlan;
  planSha256: string;
  approval: unknown;
  executionConfirmation: string;
  now: string;
}): ValidatedProductTruthOperationalApproval {
  const plan = parseProductTruthOperationalPlan(input.plan);
  const expectedPlanSha256 = productTruthOperationalSha256(plan);
  const planSha256 = sha256(input.planSha256, "planSha256");
  if (expectedPlanSha256 !== planSha256) {
    fail("PLAN_HASH_MISMATCH", "plan content does not match planSha256");
  }
  if (!isRecord(input.approval)) fail("APPROVAL_INVALID", "approval must be an object");
  const approval = input.approval as unknown as ProductTruthOperationalApproval;
  if (
    approval.schemaVersion !== PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION
    || approval.approvedBy !== "owner"
  ) {
    fail("APPROVAL_INVALID", `approval must use ${PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION}`);
  }
  const runId = safeIdentifier(approval.runId, "approval.runId");
  const approvalId = safeIdentifier(approval.approvalId, "approval.approvalId");
  if (runId !== plan.runId) fail("APPROVAL_SCOPE_MISMATCH", "approval runId differs from plan");
  if (approval.planSha256 !== planSha256) fail("APPROVAL_SCOPE_MISMATCH", "approval plan hash differs");
  if (approval.targetFingerprint !== plan.targetFingerprint) {
    fail("APPROVAL_SCOPE_MISMATCH", "approval target fingerprint differs");
  }
  const expectedAction = plan.mode === "CANARY" ? "EXECUTE_CANARY" : "EXECUTE_WAVE";
  if (approval.action !== expectedAction) fail("APPROVAL_SCOPE_MISMATCH", "approval action differs from plan mode");
  const issuedAt = canonicalInstant(approval.issuedAt, "approval.issuedAt");
  const expiresAt = canonicalInstant(approval.expiresAt, "approval.expiresAt");
  const now = canonicalInstant(input.now, "now");
  if (
    Date.parse(issuedAt) > Date.parse(now)
    || Date.parse(expiresAt) <= Date.parse(now)
    || Date.parse(expiresAt) > Date.parse(plan.expiresAt)
  ) {
    fail("APPROVAL_NOT_CURRENT", "approval is not current or outlives the plan");
  }
  const expectedExecutionConfirmation = expectedProductTruthExecutionConfirmation(planSha256, approvalId);
  if (input.executionConfirmation !== expectedExecutionConfirmation) {
    fail("APPROVAL_CONFIRMATION_MISMATCH", "exact execution confirmation is required");
  }
  const permitRaw = Buffer.from(JSON.stringify(approval.meteredPermit), "utf8").toString("base64url");
  const permit = decodeMeteredRunPermit(permitRaw);
  if (!permit || permit.runId !== runId || permit.approvalId !== approvalId) {
    fail("APPROVAL_PERMIT_MISMATCH", "metered permit is invalid or belongs to another run");
  }
  if (permit.issuedAt !== issuedAt || permit.expiresAt !== expiresAt) {
    fail("APPROVAL_PERMIT_MISMATCH", "metered permit window differs from approval");
  }
  const ceilings = new Map(plan.providerCeilings.map((ceiling) => [ceiling.provider, ceiling]));
  const permitProviders = Object.entries(permit.providers);
  if (permitProviders.length !== ceilings.size) {
    fail("APPROVAL_PERMIT_MISMATCH", "permit provider set differs from plan ceilings");
  }
  for (const [providerName, allowance] of permitProviders) {
    const provider = providerName as MeteredProvider;
    const ceiling = ceilings.get(provider);
    if (!ceiling || !allowance || !allowanceEqualsCeiling(allowance, ceiling)) {
      fail("APPROVAL_PERMIT_MISMATCH", `${provider} allowance differs from the sealed plan`);
    }
  }

  const balances = Array.isArray(approval.balanceEvidence) ? approval.balanceEvidence : [];
  const unwrangle = ceilings.get("unwrangle");
  if (unwrangle) {
    if (balances.length !== 1 || balances[0]?.provider !== "unwrangle") {
      fail("BALANCE_EVIDENCE_REQUIRED", "one fresh Unwrangle balance observation is required");
    }
    const balance = balances[0];
    const observedAt = canonicalInstant(balance.observedAt, "balanceEvidence.observedAt");
    if (Date.parse(now) - Date.parse(observedAt) > 10 * 60 * 1_000 || Date.parse(observedAt) > Date.parse(now)) {
      fail("BALANCE_EVIDENCE_STALE", "Unwrangle balance evidence must be no older than ten minutes");
    }
    const balanceUnits = finiteNonNegative(balance.balanceUnits, "balanceEvidence.balanceUnits");
    const reserveFloor = finiteNonNegative(balance.reserveFloor, "balanceEvidence.reserveFloor");
    sha256(balance.evidenceSha256, "balanceEvidence.evidenceSha256");
    if (reserveFloor !== unwrangle.reserveFloor) {
      fail("BALANCE_FLOOR_MISMATCH", "balance reserve floor differs from the sealed plan");
    }
    if (balanceUnits - (unwrangle.maxUnits ?? 0) < reserveFloor) {
      fail("BALANCE_FLOOR_EXCEEDED", "approved maximum spend would cross the reserve floor");
    }
  } else if (balances.length !== 0) {
    fail("APPROVAL_INVALID", "balance evidence is present without an Unwrangle ceiling");
  }

  return {
    approval,
    permit,
    encodedPermit: permitRaw,
    meteredConfirmation: expectedMeteredRunConfirmation(permit),
    executionConfirmation: expectedExecutionConfirmation,
  };
}
