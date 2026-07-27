import { lstat } from "node:fs/promises";

import { createClient, type Client } from "@libsql/client";

import {
  resolveProductTruthDatabaseTarget,
  type ProductTruthDatabaseTarget,
} from "./product-truth-database-target";

export const PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_VERSION =
  "product-truth-control-center-runtime/1.0.0" as const;

export const PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV = Object.freeze({
  enabled: "PRODUCT_TRUTH_CONTROL_CENTER_ENABLED",
  confirmation: "PRODUCT_TRUTH_CONTROL_CENTER_CONFIRMATION",
  manifestSha256: "PRODUCT_TRUTH_CONTROL_CENTER_MANIFEST_SHA256",
  databaseTargetFingerprint:
    "PRODUCT_TRUTH_CONTROL_CENTER_DATABASE_TARGET_FINGERPRINT",
  maxPriceAgeMs: "PRODUCT_TRUTH_CONTROL_CENTER_MAX_PRICE_AGE_MS",
} as const);

type RuntimeEnvironment = Record<string, string | undefined>;

export interface ProductTruthControlCenterRuntimeOff {
  schemaVersion: typeof PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_VERSION;
  status: "OFF";
  reason: "NO_READ_ONLY_RUNTIME_CONFIGURED";
}

export interface ProductTruthControlCenterRuntimeActive {
  schemaVersion: typeof PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_VERSION;
  status: "READ_ONLY";
  authoritativeManifestSha256: string;
  maxPriceAgeMs: number;
  database: {
    target: ProductTruthDatabaseTarget;
    authToken?: string;
  };
  claims: {
    databaseWrites: false;
    providerCalls: false;
    paidCalls: false;
    marketplaceMutations: false;
  };
}

export type ProductTruthControlCenterRuntime =
  | ProductTruthControlCenterRuntimeOff
  | ProductTruthControlCenterRuntimeActive;

export class ProductTruthControlCenterRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthControlCenterRuntimeError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthControlCenterRuntimeError(
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
    fail("CONTROL_CENTER_RUNTIME_CONFIG_INCOMPLETE", `${name} is required as exact text`);
  }
  return value;
}

function exactSha256(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail("CONTROL_CENTER_RUNTIME_CONFIG_INVALID", `${name} must be lowercase SHA-256`);
  }
  return value;
}

function exactMaxPriceAgeMs(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    fail(
      "CONTROL_CENTER_RUNTIME_CONFIG_INVALID",
      `${PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.maxPriceAgeMs} must be a positive integer`,
    );
  }
  const parsed = Number(value);
  const maximum = 30 * 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    fail(
      "CONTROL_CENTER_RUNTIME_CONFIG_INVALID",
      `${PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.maxPriceAgeMs} must be at most 30 days`,
    );
  }
  return parsed;
}

function configuredRuntimeKeys(env: RuntimeEnvironment): string[] {
  return Object.values(PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV).filter(
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
      "CONTROL_CENTER_RUNTIME_DATABASE_URL_REQUIRED",
      "the Product Truth database URL is not configured",
    );
  }
  let target: ProductTruthDatabaseTarget;
  try {
    target = resolveProductTruthDatabaseTarget(selectedUrl);
  } catch (error) {
    fail("CONTROL_CENTER_RUNTIME_DATABASE_TARGET_INVALID", "database target is invalid", error);
  }
  if (target.kind === "remote" && !authToken) {
    fail(
      "CONTROL_CENTER_RUNTIME_DATABASE_AUTH_REQUIRED",
      "remote Product Truth reads require an out-of-band auth token",
    );
  }
  if (target.kind === "local" && authToken) {
    fail(
      "CONTROL_CENTER_RUNTIME_DATABASE_AUTH_FORBIDDEN",
      "local Product Truth reads do not accept a remote auth token",
    );
  }
  return { target, ...(authToken ? { authToken } : {}) };
}

export function expectedProductTruthControlCenterConfirmation(input: {
  authoritativeManifestSha256: string;
  databaseTargetFingerprint: string;
}): string {
  return [
    "ENABLE_PRODUCT_TRUTH_CONTROL_CENTER_READ_ONLY",
    exactSha256(input.authoritativeManifestSha256, "authoritativeManifestSha256"),
    exactSha256(input.databaseTargetFingerprint, "databaseTargetFingerprint"),
  ].join(":");
}

/**
 * The UI runtime is deliberately independent from consumer cutover activation.
 * It is disabled by default and can only read one exact database target and one
 * immutable Phase 1 manifest. No request value can select either binding.
 */
export function loadProductTruthControlCenterRuntime(input: {
  env?: RuntimeEnvironment;
} = {}): ProductTruthControlCenterRuntime {
  const env = input.env ?? process.env;
  const configured = configuredRuntimeKeys(env);
  if (configured.length === 0) {
    return {
      schemaVersion: PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_VERSION,
      status: "OFF",
      reason: "NO_READ_ONLY_RUNTIME_CONFIGURED",
    };
  }
  if (env[PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.enabled] !== "1") {
    fail(
      "CONTROL_CENTER_RUNTIME_CONFIG_INCOMPLETE",
      `${PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.enabled} must be exactly 1`,
    );
  }
  const authoritativeManifestSha256 = exactSha256(
    exactRequiredEnv(env, PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.manifestSha256),
    PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.manifestSha256,
  );
  const database = resolveRuntimeDatabase(env);
  const configuredTargetFingerprint = exactSha256(
    exactRequiredEnv(
      env,
      PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.databaseTargetFingerprint,
    ),
    PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.databaseTargetFingerprint,
  );
  if (database.target.fingerprint !== configuredTargetFingerprint) {
    fail(
      "CONTROL_CENTER_RUNTIME_DATABASE_TARGET_MISMATCH",
      "configured database fingerprint differs from the actual runtime target",
    );
  }
  const expectedConfirmation = expectedProductTruthControlCenterConfirmation({
    authoritativeManifestSha256,
    databaseTargetFingerprint: database.target.fingerprint,
  });
  if (
    exactRequiredEnv(env, PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.confirmation)
      !== expectedConfirmation
  ) {
    fail(
      "CONTROL_CENTER_RUNTIME_CONFIRMATION_INVALID",
      "read-only runtime confirmation does not bind the exact manifest and database target",
    );
  }
  return {
    schemaVersion: PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_VERSION,
    status: "READ_ONLY",
    authoritativeManifestSha256,
    maxPriceAgeMs: exactMaxPriceAgeMs(
      exactRequiredEnv(env, PRODUCT_TRUTH_CONTROL_CENTER_RUNTIME_ENV.maxPriceAgeMs),
    ),
    database,
    claims: {
      databaseWrites: false,
      providerCalls: false,
      paidCalls: false,
      marketplaceMutations: false,
    },
  };
}

export async function openProductTruthControlCenterReadClient(
  runtime: ProductTruthControlCenterRuntimeActive,
): Promise<Client> {
  if (runtime.database.target.kind === "local" && runtime.database.target.localPath) {
    try {
      const entry = await lstat(runtime.database.target.localPath);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(
          "CONTROL_CENTER_RUNTIME_LOCAL_DATABASE_INVALID",
          "local Product Truth target must be an existing regular non-symlink file",
        );
      }
    } catch (error) {
      if (error instanceof ProductTruthControlCenterRuntimeError) throw error;
      fail(
        "CONTROL_CENTER_RUNTIME_LOCAL_DATABASE_MISSING",
        "local Product Truth target does not exist",
        error,
      );
    }
  }
  return createClient({
    url: runtime.database.target.clientUrl,
    ...(runtime.database.authToken ? { authToken: runtime.database.authToken } : {}),
  });
}
