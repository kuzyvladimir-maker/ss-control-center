import { lstat } from "node:fs/promises";

import { createClient, type Client } from "@libsql/client";

import {
  validateProductTruthConsumerActivation,
  type ValidatedProductTruthConsumerActivation,
} from "./product-truth-consumer-activation";
import {
  resolveProductTruthDatabaseTarget,
  type ProductTruthDatabaseTarget,
} from "./product-truth-database-target";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "./product-truth-read-contract-version";

export const PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_VERSION =
  "product-truth-unit-economics-runtime/1.0.0" as const;

export const PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV = Object.freeze({
  enabled: "PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_ENABLED",
  activationJson: "PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_ACTIVATION_JSON",
  activationSha256: "PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_ACTIVATION_SHA256",
  confirmation: "PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_CONFIRMATION",
  manifestSha256: "PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_MANIFEST_SHA256",
  databaseTargetFingerprint:
    "PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_DATABASE_TARGET_FINGERPRINT",
  maxPriceAgeMs: "PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_MAX_PRICE_AGE_MS",
  maxListingsPerBatch:
    "PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_MAX_LISTINGS_PER_BATCH",
  accessToken: "PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_ACCESS_TOKEN",
} as const);

type RuntimeEnvironment = Record<string, string | undefined>;

export interface ProductTruthUnitEconomicsRuntimeOff {
  schemaVersion: typeof PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_VERSION;
  status: "OFF";
  reason: "NO_OWNER_ACTIVATION_CONFIGURED";
}

export interface ProductTruthUnitEconomicsRuntimeActive {
  schemaVersion: typeof PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_VERSION;
  status: "SHADOW";
  validatedActivation: ValidatedProductTruthConsumerActivation;
  database: {
    target: ProductTruthDatabaseTarget;
    authToken?: string;
  };
  accessToken: string;
}

export type ProductTruthUnitEconomicsRuntime =
  | ProductTruthUnitEconomicsRuntimeOff
  | ProductTruthUnitEconomicsRuntimeActive;

export class ProductTruthConsumerRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthConsumerRuntimeError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthConsumerRuntimeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^['"]|['"]$/g, "") || undefined;
}

function exactRequiredEnv(env: RuntimeEnvironment, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || !value || value !== value.trim()) {
    fail("CONSUMER_RUNTIME_CONFIG_INCOMPLETE", `${name} is required as exact text`);
  }
  return value;
}

function requiredJsonEnv(env: RuntimeEnvironment, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) {
    fail("CONSUMER_RUNTIME_CONFIG_INCOMPLETE", `${name} is required`);
  }
  // The detached digest is over the parsed canonical artifact, not transport
  // whitespace. Deployment secret stores commonly preserve a final newline.
  return value.trim();
}

function exactSha256(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail("CONSUMER_RUNTIME_CONFIG_INVALID", `${name} must be lowercase SHA-256`);
  }
  return value;
}

function exactPositiveInteger(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    fail("CONSUMER_RUNTIME_CONFIG_INVALID", `${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail("CONSUMER_RUNTIME_CONFIG_INVALID", `${name} exceeds safe integer range`);
  }
  return parsed;
}

function exactAccessToken(value: string, name: string): string {
  if (value.length < 32 || value.length > 512 || value !== value.trim()) {
    fail(
      "CONSUMER_RUNTIME_CONFIG_INVALID",
      `${name} must be 32-512 exact non-whitespace-bound characters`,
    );
  }
  return value;
}

function canonicalNow(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("CONSUMER_RUNTIME_NOW_INVALID", "now must be a canonical UTC instant");
  }
  return value;
}

function configuredRuntimeKeys(env: RuntimeEnvironment): string[] {
  return Object.values(PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV).filter(
    (name) => env[name] !== undefined,
  );
}

function resolveRuntimeDatabase(env: RuntimeEnvironment): {
  target: ProductTruthDatabaseTarget;
  authToken?: string;
} {
  const tursoUrl = cleanEnv(env.TURSO_DATABASE_URL);
  const tursoToken = cleanEnv(env.TURSO_AUTH_TOKEN);
  const databaseUrl = cleanEnv(env.DATABASE_URL);
  const selectedUrl = tursoUrl && tursoToken ? tursoUrl : databaseUrl;
  const authToken = tursoUrl && tursoToken ? tursoToken : undefined;
  if (!selectedUrl) {
    fail(
      "CONSUMER_RUNTIME_DATABASE_URL_REQUIRED",
      "the runtime database URL is not configured",
    );
  }
  let target: ProductTruthDatabaseTarget;
  try {
    target = resolveProductTruthDatabaseTarget(selectedUrl);
  } catch (error) {
    fail("CONSUMER_RUNTIME_DATABASE_TARGET_INVALID", "database target is invalid", error);
  }
  if (target.kind === "remote" && !authToken) {
    fail(
      "CONSUMER_RUNTIME_DATABASE_AUTH_REQUIRED",
      "remote Product Truth reads require an out-of-band auth token",
    );
  }
  if (target.kind === "local" && authToken) {
    fail(
      "CONSUMER_RUNTIME_DATABASE_AUTH_FORBIDDEN",
      "local Product Truth reads do not accept a remote auth token",
    );
  }
  return { target, ...(authToken ? { authToken } : {}) };
}

/**
 * Loads only server-controlled deployment configuration. No request body,
 * query parameter, database row or ambient default can activate SHADOW mode.
 */
export function loadProductTruthUnitEconomicsRuntime(input: {
  env?: RuntimeEnvironment;
  now: string;
}): ProductTruthUnitEconomicsRuntime {
  const env = input.env ?? process.env;
  const configured = configuredRuntimeKeys(env);
  if (configured.length === 0) {
    return {
      schemaVersion: PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_VERSION,
      status: "OFF",
      reason: "NO_OWNER_ACTIVATION_CONFIGURED",
    };
  }
  if (env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.enabled] !== "1") {
    fail(
      "CONSUMER_RUNTIME_CONFIG_INCOMPLETE",
      `${PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.enabled} must be exactly 1`,
    );
  }

  const activationJson = requiredJsonEnv(
    env,
    PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationJson,
  );
  let activation: unknown;
  try {
    activation = JSON.parse(activationJson) as unknown;
  } catch (error) {
    fail("CONSUMER_RUNTIME_ACTIVATION_INVALID", "activation JSON is invalid", error);
  }
  const activationSha256 = exactSha256(
    exactRequiredEnv(env, PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationSha256),
    PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationSha256,
  );
  const confirmation = exactRequiredEnv(
    env,
    PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.confirmation,
  );
  const manifestSha256 = exactSha256(
    exactRequiredEnv(env, PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.manifestSha256),
    PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.manifestSha256,
  );
  const configuredTargetFingerprint = exactSha256(
    exactRequiredEnv(
      env,
      PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.databaseTargetFingerprint,
    ),
    PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.databaseTargetFingerprint,
  );
  const maxPriceAgeMs = exactPositiveInteger(
    exactRequiredEnv(env, PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.maxPriceAgeMs),
    PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.maxPriceAgeMs,
  );
  const maxListingsPerBatch = exactPositiveInteger(
    exactRequiredEnv(
      env,
      PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.maxListingsPerBatch,
    ),
    PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.maxListingsPerBatch,
  );
  const accessToken = exactAccessToken(
    exactRequiredEnv(env, PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.accessToken),
    PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.accessToken,
  );
  const database = resolveRuntimeDatabase(env);
  if (database.target.fingerprint !== configuredTargetFingerprint) {
    fail(
      "CONSUMER_RUNTIME_DATABASE_TARGET_MISMATCH",
      "configured database fingerprint differs from the actual runtime target",
    );
  }

  let validatedActivation: ValidatedProductTruthConsumerActivation;
  try {
    validatedActivation = validateProductTruthConsumerActivation({
      activation,
      activationSha256,
      confirmation,
      runtimeBinding: {
        mode: "SHADOW",
        readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
        authoritativeManifestSha256: manifestSha256,
        databaseTargetFingerprint: database.target.fingerprint,
        consumers: ["UNIT_ECONOMICS"],
        maxPriceAgeMs,
        maxListingsPerBatch,
      },
      now: canonicalNow(input.now),
    });
  } catch (error) {
    fail(
      "CONSUMER_RUNTIME_ACTIVATION_REJECTED",
      "owner activation failed exact runtime validation",
      error,
    );
  }
  if (
    validatedActivation.activation.mode !== "SHADOW"
    || validatedActivation.activation.consumers.length !== 1
    || validatedActivation.activation.consumers[0] !== "UNIT_ECONOMICS"
  ) {
    fail(
      "CONSUMER_RUNTIME_SCOPE_FORBIDDEN",
      "this runtime accepts only SHADOW activation for UNIT_ECONOMICS",
    );
  }
  return {
    schemaVersion: PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_VERSION,
    status: "SHADOW",
    validatedActivation,
    database,
    accessToken,
  };
}

/** Opens a read client only after the complete owner/runtime binding passes. */
export async function openProductTruthConsumerReadClient(
  runtime: ProductTruthUnitEconomicsRuntimeActive,
): Promise<Client> {
  if (runtime.database.target.kind === "local" && runtime.database.target.localPath) {
    try {
      const entry = await lstat(runtime.database.target.localPath);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(
          "CONSUMER_RUNTIME_LOCAL_DATABASE_INVALID",
          "local Product Truth target must be an existing regular non-symlink file",
        );
      }
    } catch (error) {
      if (error instanceof ProductTruthConsumerRuntimeError) throw error;
      fail(
        "CONSUMER_RUNTIME_LOCAL_DATABASE_MISSING",
        "local Product Truth target does not exist",
        error,
      );
    }
  }
  return createClient({
    url: runtime.database.target.clientUrl,
    ...(runtime.database.authToken
      ? { authToken: runtime.database.authToken }
      : {}),
  });
}
