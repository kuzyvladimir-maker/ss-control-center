import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "./product-truth-read-contract-version";

export const PRODUCT_TRUTH_CONSUMER_ACTIVATION_VERSION =
  "product-truth-consumer-activation/1.0.0" as const;

/**
 * This order is part of the canonical hash-bound contract. An activation may contain a
 * non-empty subset, but it must preserve this global order exactly.
 */
export const PRODUCT_TRUTH_CONSUMERS = Object.freeze([
  "BUNDLE_FACTORY",
  "LISTING_IMPROVEMENT",
  "UNIT_ECONOMICS",
  "PROCUREMENT",
] as const);

export const PRODUCT_TRUTH_CONSUMER_ACTIVATION_MODES = Object.freeze([
  "SHADOW",
  "ENFORCED",
] as const);

export const PRODUCT_TRUTH_CONSUMER_MAX_PRICE_AGE_MS =
  30 * 24 * 60 * 60 * 1_000;
export const PRODUCT_TRUTH_CONSUMER_MAX_BATCH_SIZE = 100;
export const PRODUCT_TRUTH_CONSUMER_MAX_ACTIVATION_LIFETIME_MS =
  30 * 24 * 60 * 60 * 1_000;

export type ProductTruthConsumer = (typeof PRODUCT_TRUTH_CONSUMERS)[number];
export type ProductTruthConsumerActivationMode =
  (typeof PRODUCT_TRUTH_CONSUMER_ACTIVATION_MODES)[number];
export type ProductTruthConsumerEffectiveMode =
  | "OFF"
  | ProductTruthConsumerActivationMode;

export interface ProductTruthConsumerBatchPolicy {
  strategy: "SET_BASED";
  maxListingsPerBatch: number;
  maxConcurrentBatches: 1;
  allowPerListingFallback: false;
}

export interface ProductTruthConsumerActivation {
  schemaVersion: typeof PRODUCT_TRUTH_CONSUMER_ACTIVATION_VERSION;
  ownerApproval: {
    approvedBy: "owner";
    approvalId: string;
    action: "ACTIVATE_SHADOW" | "ACTIVATE_ENFORCED";
  };
  mode: ProductTruthConsumerActivationMode;
  readContractVersion: typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION;
  authoritativeManifestSha256: string;
  databaseTargetFingerprint: string;
  consumers: readonly ProductTruthConsumer[];
  issuedAt: string;
  expiresAt: string;
  readPolicy: {
    maxPriceAgeMs: number;
    batch: ProductTruthConsumerBatchPolicy;
  };
  claims: {
    readOnly: true;
    databaseWrites: false;
    retailerNetworkCalls: false;
    enrichmentMutations: false;
    marketplaceMutations: false;
    procurementMutations: false;
  };
}

export interface BuildProductTruthConsumerActivationInput {
  approvalId: string;
  mode: ProductTruthConsumerActivationMode;
  authoritativeManifestSha256: string;
  databaseTargetFingerprint: string;
  consumers: readonly ProductTruthConsumer[];
  issuedAt: string;
  expiresAt: string;
  maxPriceAgeMs: number;
  maxListingsPerBatch: number;
}

export interface ProductTruthConsumerRuntimeBinding {
  mode: ProductTruthConsumerActivationMode;
  readContractVersion: typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION;
  authoritativeManifestSha256: string;
  databaseTargetFingerprint: string;
  consumers: readonly ProductTruthConsumer[];
  maxPriceAgeMs: number;
  maxListingsPerBatch: number;
}

const VALIDATED_PRODUCT_TRUTH_CONSUMER_ACTIVATION = Symbol(
  "VALIDATED_PRODUCT_TRUTH_CONSUMER_ACTIVATION",
);

export interface ValidatedProductTruthConsumerActivation {
  readonly [VALIDATED_PRODUCT_TRUTH_CONSUMER_ACTIVATION]: true;
  readonly activation: Readonly<ProductTruthConsumerActivation>;
  readonly activationSha256: string;
  readonly confirmation: string;
}

export class ProductTruthConsumerActivationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthConsumerActivationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthConsumerActivationError(code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CONSUMER_ACTIVATION_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      "CONSUMER_ACTIVATION_INVALID",
      `${label} keys must be exactly: ${wanted.join(", ")}`,
    );
  }
}

function exactText(value: unknown, label: string, maximum = 200): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
  ) {
    fail(
      "CONSUMER_ACTIVATION_INVALID",
      `${label} must be 1-${maximum} exact characters`,
    );
  }
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  const result = exactText(value, label, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    fail("CONSUMER_ACTIVATION_INVALID", `${label} contains unsafe characters`);
  }
  return result;
}

function exactSha256(value: unknown, label: string): string {
  const result = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) {
    fail(
      "CONSUMER_ACTIVATION_INVALID",
      `${label} must be exactly 64 lowercase hexadecimal characters`,
    );
  }
  return result;
}

function canonicalInstant(value: unknown, label: string): string {
  const result = exactText(value, label, 80);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result) {
    fail(
      "CONSUMER_ACTIVATION_INVALID",
      `${label} must be a canonical UTC ISO-8601 instant`,
    );
  }
  return result;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    fail(
      "CONSUMER_ACTIVATION_INVALID",
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
  return Number(value);
}

function activationMode(value: unknown, label: string): ProductTruthConsumerActivationMode {
  if (value !== "SHADOW" && value !== "ENFORCED") {
    fail(
      "CONSUMER_ACTIVATION_INVALID",
      `${label} must be SHADOW or ENFORCED; OFF is represented by no validated activation`,
    );
  }
  return value;
}

function canonicalConsumerSubset(
  value: unknown,
  label: string,
): ProductTruthConsumer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PRODUCT_TRUTH_CONSUMERS.length) {
    fail(
      "CONSUMER_ACTIVATION_CONSUMERS_INVALID",
      `${label} must be a non-empty subset of the four canonical consumers`,
    );
  }
  const globalOrdinal = new Map<string, number>(
    PRODUCT_TRUTH_CONSUMERS.map((consumer, index) => [consumer, index]),
  );
  const result = value.map((raw, index) => {
    if (typeof raw !== "string" || !globalOrdinal.has(raw)) {
      fail(
        "CONSUMER_ACTIVATION_CONSUMERS_INVALID",
        `${label}[${index}] is not a canonical Product Truth consumer`,
      );
    }
    return raw as ProductTruthConsumer;
  });
  if (new Set(result).size !== result.length) {
    fail(
      "CONSUMER_ACTIVATION_CONSUMERS_INVALID",
      `${label} contains duplicate consumers`,
    );
  }
  for (let index = 1; index < result.length; index += 1) {
    if (globalOrdinal.get(result[index - 1])! >= globalOrdinal.get(result[index])!) {
      fail(
        "CONSUMER_ACTIVATION_CONSUMERS_INVALID",
        `${label} must preserve the canonical global consumer order`,
      );
    }
  }
  return result;
}

function expectedOwnerAction(
  mode: ProductTruthConsumerActivationMode,
): "ACTIVATE_SHADOW" | "ACTIVATE_ENFORCED" {
  return mode === "SHADOW" ? "ACTIVATE_SHADOW" : "ACTIVATE_ENFORCED";
}

function parseBatchPolicy(value: unknown, label: string): ProductTruthConsumerBatchPolicy {
  const input = record(value, label);
  exactKeys(input, [
    "strategy",
    "maxListingsPerBatch",
    "maxConcurrentBatches",
    "allowPerListingFallback",
  ], label);
  if (
    input.strategy !== "SET_BASED"
    || input.maxConcurrentBatches !== 1
    || input.allowPerListingFallback !== false
  ) {
    fail(
      "CONSUMER_ACTIVATION_UNSAFE",
      `${label} must require bounded set-based reads with no per-listing fallback`,
    );
  }
  return {
    strategy: "SET_BASED",
    maxListingsPerBatch: positiveInteger(
      input.maxListingsPerBatch,
      `${label}.maxListingsPerBatch`,
      PRODUCT_TRUTH_CONSUMER_MAX_BATCH_SIZE,
    ),
    maxConcurrentBatches: 1,
    allowPerListingFallback: false,
  };
}

function parseClaims(
  value: unknown,
): ProductTruthConsumerActivation["claims"] {
  const input = record(value, "activation.claims");
  exactKeys(input, [
    "readOnly",
    "databaseWrites",
    "retailerNetworkCalls",
    "enrichmentMutations",
    "marketplaceMutations",
    "procurementMutations",
  ], "activation.claims");
  if (
    input.readOnly !== true
    || input.databaseWrites !== false
    || input.retailerNetworkCalls !== false
    || input.enrichmentMutations !== false
    || input.marketplaceMutations !== false
    || input.procurementMutations !== false
  ) {
    fail(
      "CONSUMER_ACTIVATION_UNSAFE",
      "activation must authorize read-only Product Truth consumption and no mutations",
    );
  }
  return {
    readOnly: true,
    databaseWrites: false,
    retailerNetworkCalls: false,
    enrichmentMutations: false,
    marketplaceMutations: false,
    procurementMutations: false,
  };
}

/** Parse an untrusted activation artifact without consulting ambient state. */
export function parseProductTruthConsumerActivation(
  value: unknown,
): ProductTruthConsumerActivation {
  const input = record(value, "activation");
  exactKeys(input, [
    "schemaVersion",
    "ownerApproval",
    "mode",
    "readContractVersion",
    "authoritativeManifestSha256",
    "databaseTargetFingerprint",
    "consumers",
    "issuedAt",
    "expiresAt",
    "readPolicy",
    "claims",
  ], "activation");
  if (input.schemaVersion !== PRODUCT_TRUTH_CONSUMER_ACTIVATION_VERSION) {
    fail(
      "CONSUMER_ACTIVATION_INVALID",
      `schemaVersion must be ${PRODUCT_TRUTH_CONSUMER_ACTIVATION_VERSION}`,
    );
  }
  const mode = activationMode(input.mode, "activation.mode");
  if (input.readContractVersion !== PRODUCT_TRUTH_READ_CONTRACT_VERSION) {
    fail(
      "CONSUMER_ACTIVATION_SCOPE_MISMATCH",
      `readContractVersion must be exactly ${PRODUCT_TRUTH_READ_CONTRACT_VERSION}`,
    );
  }

  const ownerApproval = record(input.ownerApproval, "activation.ownerApproval");
  exactKeys(
    ownerApproval,
    ["approvedBy", "approvalId", "action"],
    "activation.ownerApproval",
  );
  if (ownerApproval.approvedBy !== "owner") {
    fail(
      "CONSUMER_ACTIVATION_UNSAFE",
      "activation.ownerApproval.approvedBy must be owner",
    );
  }
  const approvalId = safeIdentifier(
    ownerApproval.approvalId,
    "activation.ownerApproval.approvalId",
  );
  const action = expectedOwnerAction(mode);
  if (ownerApproval.action !== action) {
    fail(
      "CONSUMER_ACTIVATION_SCOPE_MISMATCH",
      "owner approval action does not match activation mode",
    );
  }

  const issuedAt = canonicalInstant(input.issuedAt, "activation.issuedAt");
  const expiresAt = canonicalInstant(input.expiresAt, "activation.expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (
    lifetime <= 0
    || lifetime > PRODUCT_TRUTH_CONSUMER_MAX_ACTIVATION_LIFETIME_MS
  ) {
    fail(
      "CONSUMER_ACTIVATION_INVALID",
      "activation lifetime must be positive and at most 30 days",
    );
  }

  const readPolicy = record(input.readPolicy, "activation.readPolicy");
  exactKeys(
    readPolicy,
    ["maxPriceAgeMs", "batch"],
    "activation.readPolicy",
  );

  return {
    schemaVersion: PRODUCT_TRUTH_CONSUMER_ACTIVATION_VERSION,
    ownerApproval: {
      approvedBy: "owner",
      approvalId,
      action,
    },
    mode,
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    authoritativeManifestSha256: exactSha256(
      input.authoritativeManifestSha256,
      "activation.authoritativeManifestSha256",
    ),
    databaseTargetFingerprint: exactSha256(
      input.databaseTargetFingerprint,
      "activation.databaseTargetFingerprint",
    ),
    consumers: canonicalConsumerSubset(input.consumers, "activation.consumers"),
    issuedAt,
    expiresAt,
    readPolicy: {
      maxPriceAgeMs: positiveInteger(
        readPolicy.maxPriceAgeMs,
        "activation.readPolicy.maxPriceAgeMs",
        PRODUCT_TRUTH_CONSUMER_MAX_PRICE_AGE_MS,
      ),
      batch: parseBatchPolicy(readPolicy.batch, "activation.readPolicy.batch"),
    },
    claims: parseClaims(input.claims),
  };
}

export function buildProductTruthConsumerActivation(
  input: BuildProductTruthConsumerActivationInput,
): ProductTruthConsumerActivation {
  const mode = activationMode(input.mode, "mode");
  return parseProductTruthConsumerActivation({
    schemaVersion: PRODUCT_TRUTH_CONSUMER_ACTIVATION_VERSION,
    ownerApproval: {
      approvedBy: "owner",
      approvalId: input.approvalId,
      action: expectedOwnerAction(mode),
    },
    mode,
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    authoritativeManifestSha256: input.authoritativeManifestSha256,
    databaseTargetFingerprint: input.databaseTargetFingerprint,
    consumers: input.consumers,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    readPolicy: {
      maxPriceAgeMs: input.maxPriceAgeMs,
      batch: {
        strategy: "SET_BASED",
        maxListingsPerBatch: input.maxListingsPerBatch,
        maxConcurrentBatches: 1,
        allowPerListingFallback: false,
      },
    },
    claims: {
      readOnly: true,
      databaseWrites: false,
      retailerNetworkCalls: false,
      enrichmentMutations: false,
      marketplaceMutations: false,
      procurementMutations: false,
    },
  });
}

export function renderProductTruthConsumerActivationJson(value: unknown): string {
  return renderProductTruthOperationalJson(
    parseProductTruthConsumerActivation(value),
  );
}

export function productTruthConsumerActivationSha256(value: unknown): string {
  return productTruthOperationalSha256(
    parseProductTruthConsumerActivation(value),
  );
}

export function expectedProductTruthConsumerActivationConfirmation(
  activationSha256: string,
  approvalId: string,
  mode: ProductTruthConsumerActivationMode,
): string {
  return [
    "ACTIVATE_PRODUCT_TRUTH_CONSUMERS_V1",
    activationMode(mode, "mode"),
    exactSha256(activationSha256, "activationSha256"),
    safeIdentifier(approvalId, "approvalId"),
  ].join(":");
}

function parseRuntimeBinding(
  value: ProductTruthConsumerRuntimeBinding,
): ProductTruthConsumerRuntimeBinding {
  const input = record(value, "runtimeBinding");
  exactKeys(input, [
    "mode",
    "readContractVersion",
    "authoritativeManifestSha256",
    "databaseTargetFingerprint",
    "consumers",
    "maxPriceAgeMs",
    "maxListingsPerBatch",
  ], "runtimeBinding");
  const mode = activationMode(input.mode, "runtimeBinding.mode");
  if (input.readContractVersion !== PRODUCT_TRUTH_READ_CONTRACT_VERSION) {
    fail(
      "CONSUMER_ACTIVATION_SCOPE_MISMATCH",
      "runtime read-contract version is not the exact current version",
    );
  }
  return {
    mode,
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    authoritativeManifestSha256: exactSha256(
      input.authoritativeManifestSha256,
      "runtimeBinding.authoritativeManifestSha256",
    ),
    databaseTargetFingerprint: exactSha256(
      input.databaseTargetFingerprint,
      "runtimeBinding.databaseTargetFingerprint",
    ),
    consumers: canonicalConsumerSubset(
      input.consumers,
      "runtimeBinding.consumers",
    ),
    maxPriceAgeMs: positiveInteger(
      input.maxPriceAgeMs,
      "runtimeBinding.maxPriceAgeMs",
      PRODUCT_TRUTH_CONSUMER_MAX_PRICE_AGE_MS,
    ),
    maxListingsPerBatch: positiveInteger(
      input.maxListingsPerBatch,
      "runtimeBinding.maxListingsPerBatch",
      PRODUCT_TRUTH_CONSUMER_MAX_BATCH_SIZE,
    ),
  };
}

function freezeActivation(
  activation: ProductTruthConsumerActivation,
): Readonly<ProductTruthConsumerActivation> {
  Object.freeze(activation.ownerApproval);
  Object.freeze(activation.consumers);
  Object.freeze(activation.readPolicy.batch);
  Object.freeze(activation.readPolicy);
  Object.freeze(activation.claims);
  return Object.freeze(activation);
}

/**
 * Validate the artifact, its detached digest, its exact runtime bindings, the
 * owner confirmation, and its validity window. No ambient environment is read.
 */
export function validateProductTruthConsumerActivation(input: {
  activation: unknown;
  activationSha256: string;
  confirmation: string;
  runtimeBinding: ProductTruthConsumerRuntimeBinding;
  now: string;
}): ValidatedProductTruthConsumerActivation {
  const activation = parseProductTruthConsumerActivation(input.activation);
  const activationSha256 = exactSha256(
    input.activationSha256,
    "activationSha256",
  );
  const actualSha256 = productTruthOperationalSha256(activation);
  if (actualSha256 !== activationSha256) {
    fail(
      "CONSUMER_ACTIVATION_HASH_MISMATCH",
      "activation content does not match the detached SHA-256 digest",
    );
  }

  const runtime = parseRuntimeBinding(input.runtimeBinding);
  if (
    activation.mode !== runtime.mode
    || activation.readContractVersion !== runtime.readContractVersion
    || activation.authoritativeManifestSha256
      !== runtime.authoritativeManifestSha256
    || activation.databaseTargetFingerprint !== runtime.databaseTargetFingerprint
    || renderProductTruthOperationalJson(activation.consumers)
      !== renderProductTruthOperationalJson(runtime.consumers)
    || activation.readPolicy.maxPriceAgeMs !== runtime.maxPriceAgeMs
    || activation.readPolicy.batch.maxListingsPerBatch
      !== runtime.maxListingsPerBatch
  ) {
    fail(
      "CONSUMER_ACTIVATION_SCOPE_MISMATCH",
      "activation does not exactly match the runtime consumer/read/data target binding",
    );
  }

  const expectedConfirmation =
    expectedProductTruthConsumerActivationConfirmation(
      activationSha256,
      activation.ownerApproval.approvalId,
      activation.mode,
    );
  if (input.confirmation !== expectedConfirmation) {
    fail(
      "CONSUMER_ACTIVATION_CONFIRMATION_MISMATCH",
      "a separate exact owner activation confirmation is required",
    );
  }

  const now = canonicalInstant(input.now, "now");
  if (
    Date.parse(activation.issuedAt) > Date.parse(now)
    || Date.parse(activation.expiresAt) <= Date.parse(now)
  ) {
    fail(
      "CONSUMER_ACTIVATION_NOT_CURRENT",
      "activation is not yet current or has expired",
    );
  }

  return Object.freeze({
    [VALIDATED_PRODUCT_TRUTH_CONSUMER_ACTIVATION]: true as const,
    activation: freezeActivation(activation),
    activationSha256,
    confirmation: expectedConfirmation,
  });
}

/** OFF is derived only from the absence of a validated activation for a consumer. */
export function productTruthConsumerEffectiveMode(
  consumer: ProductTruthConsumer,
  validated: ValidatedProductTruthConsumerActivation | null | undefined,
): ProductTruthConsumerEffectiveMode {
  if (!(PRODUCT_TRUTH_CONSUMERS as readonly string[]).includes(consumer)) {
    fail(
      "CONSUMER_ACTIVATION_CONSUMERS_INVALID",
      "consumer is not one of the four canonical Product Truth consumers",
    );
  }
  if (!validated) return "OFF";
  if (validated[VALIDATED_PRODUCT_TRUTH_CONSUMER_ACTIVATION] !== true) {
    fail(
      "CONSUMER_ACTIVATION_INVALID",
      "effective mode requires the result of activation validation",
    );
  }
  if (!validated.activation.consumers.includes(consumer)) return "OFF";
  return validated.activation.mode;
}
