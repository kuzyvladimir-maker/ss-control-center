import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_TRUTH_WEB_CONTROL_ENV,
  ProductTruthWebControlRuntimeError,
  expectedProductTruthWebControlConfirmation,
  loadProductTruthWebControlRuntime,
  productTruthWebControlPublicStatus,
} from "../product-truth-web-control-runtime";

const RELEASE = "product-truth-web-control-test-r1";
const TARGET = "a".repeat(64);
const MANIFEST = "b".repeat(64);

function activeEnv(
  stage: "ADMISSION_ONLY" | "LOCAL_NO_SPEND" | "PRODUCTION_READ_ONLY",
  environment: "LOCAL" | "STAGING" | "PRODUCTION",
) {
  return {
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.stage]: stage,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.confirmation]:
      expectedProductTruthWebControlConfirmation({
        stage,
        releaseId: RELEASE,
        databaseTargetFingerprint: TARGET,
        manifestSha256: MANIFEST,
      }),
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.releaseId]: RELEASE,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.commitSha]: "c".repeat(40),
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.treeSha]: "d".repeat(40),
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.executableTreeSha256]: "e".repeat(64),
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.environment]: environment,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.databaseTargetFingerprint]: TARGET,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.manifestSha256]: MANIFEST,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.unwrangleReserveFloor]: "100",
  };
}

function isRuntimeError(code: string) {
  return (error: unknown) =>
    error instanceof ProductTruthWebControlRuntimeError
    && error.code === code;
}

test("defaults fully OFF when no activation config exists", () => {
  const runtime = loadProductTruthWebControlRuntime({ env: {} });
  assert.deepEqual(productTruthWebControlPublicStatus(runtime), {
    status: "OFF",
    stage: "OFF",
    command_admission: false,
    worker_claims: false,
    metered_execution: false,
    provider_calls_from_web: false,
    marketplace_mutations: false,
  });
});

test("ADMISSION_ONLY allows custody writes but never worker or metered execution", () => {
  const runtime = loadProductTruthWebControlRuntime({
    env: activeEnv("ADMISSION_ONLY", "PRODUCTION"),
  });
  assert.equal(runtime.status, "ACTIVE");
  if (runtime.status !== "ACTIVE") return;
  assert.equal(runtime.stage, "ADMISSION_ONLY");
  assert.equal(runtime.workerTokenSha256, null);
  assert.equal(runtime.claims.workerClaims, false);
  assert.equal(runtime.claims.meteredExecutionAdmission, false);
  assert.equal(runtime.unwrangleReserveFloor, 100);
});

test("worker stages require an exact separate worker credential", () => {
  assert.throws(
    () =>
      loadProductTruthWebControlRuntime({
        env: activeEnv("LOCAL_NO_SPEND", "LOCAL"),
      }),
    isRuntimeError("WEB_CONTROL_CONFIG_INCOMPLETE"),
  );
  const env = {
    ...activeEnv("LOCAL_NO_SPEND", "LOCAL"),
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.workerTokenSha256]: "f".repeat(64),
  };
  const runtime = loadProductTruthWebControlRuntime({ env });
  assert.equal(runtime.status, "ACTIVE");
  if (runtime.status !== "ACTIVE") return;
  assert.equal(runtime.claims.workerClaims, true);
});

test("production read-only worker cannot be pointed at a local target", () => {
  const env = {
    ...activeEnv("PRODUCTION_READ_ONLY", "LOCAL"),
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.workerTokenSha256]: "f".repeat(64),
  };
  assert.throws(
    () => loadProductTruthWebControlRuntime({ env }),
    isRuntimeError("WEB_CONTROL_STAGE_TARGET_MISMATCH"),
  );
});

test("partial config and wrong activation confirmation fail closed", () => {
  assert.throws(
    () =>
      loadProductTruthWebControlRuntime({
        env: {
          [PRODUCT_TRUTH_WEB_CONTROL_ENV.stage]: "ADMISSION_ONLY",
        },
      }),
    isRuntimeError("WEB_CONTROL_CONFIG_INCOMPLETE"),
  );
  const env = {
    ...activeEnv("ADMISSION_ONLY", "PRODUCTION"),
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.confirmation]: "wrong",
  };
  assert.throws(
    () => loadProductTruthWebControlRuntime({ env }),
    isRuntimeError("WEB_CONTROL_CONFIRMATION_INVALID"),
  );
});
