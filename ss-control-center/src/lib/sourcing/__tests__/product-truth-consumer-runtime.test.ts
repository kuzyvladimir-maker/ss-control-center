import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildProductTruthConsumerActivation,
  expectedProductTruthConsumerActivationConfirmation,
  productTruthConsumerActivationSha256,
} from "../product-truth-consumer-activation";
import {
  PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV,
  ProductTruthConsumerRuntimeError,
  loadProductTruthUnitEconomicsRuntime,
  openProductTruthConsumerReadClient,
} from "../product-truth-consumer-runtime";
import { resolveProductTruthDatabaseTarget } from "../product-truth-database-target";

const NOW = "2026-07-19T12:30:00.000Z";
const ISSUED_AT = "2026-07-19T12:00:00.000Z";
const EXPIRES_AT = "2026-07-20T12:00:00.000Z";
const MANIFEST = "a".repeat(64);
const URL = "file::memory:";
const TARGET = resolveProductTruthDatabaseTarget(URL).fingerprint;

function runtimeEnv(overrides: Record<string, string | undefined> = {}) {
  const activation = buildProductTruthConsumerActivation({
    approvalId: "owner-unit-economics-shadow-1",
    mode: "SHADOW",
    authoritativeManifestSha256: MANIFEST,
    databaseTargetFingerprint: TARGET,
    consumers: ["UNIT_ECONOMICS"],
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    maxPriceAgeMs: 86_400_000,
    maxListingsPerBatch: 100,
  });
  const digest = productTruthConsumerActivationSha256(activation);
  return {
    [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.enabled]: "1",
    [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationJson]:
      JSON.stringify(activation),
    [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationSha256]: digest,
    [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.confirmation]:
      expectedProductTruthConsumerActivationConfirmation(
        digest,
        activation.ownerApproval.approvalId,
        activation.mode,
      ),
    [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.manifestSha256]: MANIFEST,
    [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.databaseTargetFingerprint]: TARGET,
    [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.maxPriceAgeMs]: "86400000",
    [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.maxListingsPerBatch]: "100",
    [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.accessToken]:
      "unit-economics-shadow-test-access-token-0001",
    DATABASE_URL: URL,
    ...overrides,
  };
}

function code(error: unknown): string | undefined {
  return error instanceof ProductTruthConsumerRuntimeError ? error.code : undefined;
}

test("runtime is strictly OFF when no owner activation configuration exists", () => {
  const runtime = loadProductTruthUnitEconomicsRuntime({ env: {}, now: NOW });
  assert.deepEqual(runtime, {
    schemaVersion: "product-truth-unit-economics-runtime/1.0.0",
    status: "OFF",
    reason: "NO_OWNER_ACTIVATION_CONFIGURED",
  });
});

test("partial configuration fails closed instead of becoming implicit shadow", () => {
  assert.throws(
    () => loadProductTruthUnitEconomicsRuntime({
      env: { [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.enabled]: "1" },
      now: NOW,
    }),
    (error) => code(error) === "CONSUMER_RUNTIME_CONFIG_INCOMPLETE",
  );
  assert.throws(
    () => loadProductTruthUnitEconomicsRuntime({
      env: {
        [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationJson]: "{}",
      },
      now: NOW,
    }),
    (error) => code(error) === "CONSUMER_RUNTIME_CONFIG_INCOMPLETE",
  );
});

test("valid activation pins exact SHADOW consumer, manifest and actual DB target", () => {
  const runtime = loadProductTruthUnitEconomicsRuntime({
    env: runtimeEnv(),
    now: NOW,
  });
  assert.equal(runtime.status, "SHADOW");
  if (runtime.status !== "SHADOW") return;
  assert.deepEqual(runtime.validatedActivation.activation.consumers, ["UNIT_ECONOMICS"]);
  assert.equal(runtime.validatedActivation.activation.mode, "SHADOW");
  assert.equal(
    runtime.validatedActivation.activation.authoritativeManifestSha256,
    MANIFEST,
  );
  assert.equal(runtime.database.target.fingerprint, TARGET);
});

test("activation JSON transport whitespace does not alter the canonical artifact", () => {
  const env = runtimeEnv();
  const compact = env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationJson];
  assert.ok(compact);
  env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationJson] =
    `\n  ${JSON.stringify(JSON.parse(compact), null, 2)}\n`;
  const runtime = loadProductTruthUnitEconomicsRuntime({ env, now: NOW });
  assert.equal(runtime.status, "SHADOW");
});

test("database target rejects transport parameters instead of fingerprinting options", () => {
  assert.throws(
    () => resolveProductTruthDatabaseTarget("libsql://database.example.invalid?mode=ro"),
    (error: unknown) => error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "DATABASE_URL_PARAMETERS_FORBIDDEN",
  );
  assert.throws(
    () => resolveProductTruthDatabaseTarget("file:catalog.db?mode=ro"),
    (error: unknown) => error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "DATABASE_URL_PARAMETERS_FORBIDDEN",
  );
  assert.equal(
    resolveProductTruthDatabaseTarget("file::memory:?cache=shared").clientUrl,
    "file::memory:?cache=shared",
  );
});

test("runtime rejects drifted DB target before a client or read can exist", () => {
  assert.throws(
    () => loadProductTruthUnitEconomicsRuntime({
      env: runtimeEnv({
        DATABASE_URL: "file:another.db",
      }),
      now: NOW,
    }),
    (error) => code(error) === "CONSUMER_RUNTIME_DATABASE_TARGET_MISMATCH",
  );
});

test("runtime requires a dedicated bounded SHADOW access token", () => {
  assert.throws(
    () => loadProductTruthUnitEconomicsRuntime({
      env: runtimeEnv({
        [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.accessToken]: undefined,
      }),
      now: NOW,
    }),
    (error) => code(error) === "CONSUMER_RUNTIME_CONFIG_INCOMPLETE",
  );
  assert.throws(
    () => loadProductTruthUnitEconomicsRuntime({
      env: runtimeEnv({
        [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.accessToken]: "too-short",
      }),
      now: NOW,
    }),
    (error) => code(error) === "CONSUMER_RUNTIME_CONFIG_INVALID",
  );
});

test("runtime rejects altered confirmation, expired activation and ENFORCED mode", () => {
  assert.throws(
    () => loadProductTruthUnitEconomicsRuntime({
      env: runtimeEnv({
        [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.confirmation]: "wrong",
      }),
      now: NOW,
    }),
    (error) => code(error) === "CONSUMER_RUNTIME_ACTIVATION_REJECTED",
  );
  assert.throws(
    () => loadProductTruthUnitEconomicsRuntime({
      env: runtimeEnv(),
      now: EXPIRES_AT,
    }),
    (error) => code(error) === "CONSUMER_RUNTIME_ACTIVATION_REJECTED",
  );

  const enforced = buildProductTruthConsumerActivation({
    approvalId: "owner-unit-economics-enforced-1",
    mode: "ENFORCED",
    authoritativeManifestSha256: MANIFEST,
    databaseTargetFingerprint: TARGET,
    consumers: ["UNIT_ECONOMICS"],
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    maxPriceAgeMs: 86_400_000,
    maxListingsPerBatch: 100,
  });
  const digest = productTruthConsumerActivationSha256(enforced);
  assert.throws(
    () => loadProductTruthUnitEconomicsRuntime({
      env: runtimeEnv({
        [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationJson]:
          JSON.stringify(enforced),
        [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationSha256]: digest,
        [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.confirmation]:
          expectedProductTruthConsumerActivationConfirmation(
            digest,
            enforced.ownerApproval.approvalId,
            enforced.mode,
          ),
      }),
      now: NOW,
    }),
    (error) => code(error) === "CONSUMER_RUNTIME_ACTIVATION_REJECTED",
  );
});

test("local target must already exist before the read client opens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "product-truth-runtime-missing-"));
  const missingUrl = `file:${join(directory, "does-not-exist.db")}`;
  const missingTarget = resolveProductTruthDatabaseTarget(missingUrl);
  const activation = buildProductTruthConsumerActivation({
    approvalId: "owner-unit-economics-shadow-local",
    mode: "SHADOW",
    authoritativeManifestSha256: MANIFEST,
    databaseTargetFingerprint: missingTarget.fingerprint,
    consumers: ["UNIT_ECONOMICS"],
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    maxPriceAgeMs: 86_400_000,
    maxListingsPerBatch: 100,
  });
  const digest = productTruthConsumerActivationSha256(activation);
  const runtime = loadProductTruthUnitEconomicsRuntime({
    env: runtimeEnv({
      DATABASE_URL: missingUrl,
      [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.databaseTargetFingerprint]:
        missingTarget.fingerprint,
      [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationJson]:
        JSON.stringify(activation),
      [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationSha256]: digest,
      [PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.confirmation]:
        expectedProductTruthConsumerActivationConfirmation(
          digest,
          activation.ownerApproval.approvalId,
          activation.mode,
        ),
    }),
    now: NOW,
  });
  assert.equal(runtime.status, "SHADOW");
  if (runtime.status !== "SHADOW") return;
  await assert.rejects(
    () => openProductTruthConsumerReadClient(runtime),
    (error) => code(error) === "CONSUMER_RUNTIME_LOCAL_DATABASE_MISSING",
  );
});
