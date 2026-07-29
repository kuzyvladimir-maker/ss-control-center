import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  PRODUCT_TRUTH_WEB_CONTROL_ENV,
  expectedProductTruthWebControlConfirmation,
  productTruthExecutableTreeSha256,
} from "../product-truth-web-control-runtime";
import {
  PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV,
  expectedProductTruthStandingWaveWebConfirmation,
  loadProductTruthStandingWaveWebRuntime,
} from "../product-truth-standing-wave-web-runtime";
import {
  PRODUCT_TRUTH_STANDING_WAVE_WEB_REQUEST_VERSION,
  PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION,
  parseProductTruthStandingWaveWebRequest,
  parseProductTruthStandingWaveWebRequestBytes,
  parseProductTruthStandingWaveWebResult,
  productTruthStandingWaveSidecarName,
  renderProductTruthStandingWaveWebRequest,
} from "../product-truth-standing-wave-web-contract";

const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
const EXECUTABLE = productTruthExecutableTreeSha256(TREE);
const TARGET = "3".repeat(64);
const MANIFEST = "4".repeat(64);
const PROVIDER_POLICY = "5".repeat(64);
const NO_PAID_POLICY = "6".repeat(64);
const WORKER_TOKEN_SHA = "7".repeat(64);

test("standing-wave worker resolves canonical runner sidecar names", () => {
  assert.equal(
    productTruthStandingWaveSidecarName("wave-plan.json"),
    "wave-plan.sha256",
  );
  assert.equal(
    productTruthStandingWaveSidecarName("wave-report.json"),
    "wave-report.sha256",
  );
  assert.equal(
    productTruthStandingWaveSidecarName("artifact-index.json"),
    "artifact-index.sha256",
  );
  assert.equal(
    productTruthStandingWaveSidecarName("readiness-report.json"),
    "readiness-report.sha256",
  );
  assert.throws(
    () => productTruthStandingWaveSidecarName("wave-plan.json.sha256"),
    /simple \.json filename/u,
  );
});

function activeEnv() {
  const base = {
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.stage]: "PRODUCTION_READ_ONLY",
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.releaseId]: "product-truth-web-test-r2",
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.commitSha]: COMMIT,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.treeSha]: TREE,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.executableTreeSha256]: EXECUTABLE,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.environment]: "PRODUCTION",
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.databaseTargetFingerprint]: TARGET,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.manifestSha256]: MANIFEST,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.unwrangleReserveFloor]: "15000",
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.workerTokenSha256]: WORKER_TOKEN_SHA,
  };
  const confirmation = expectedProductTruthWebControlConfirmation({
    stage: "PRODUCTION_READ_ONLY",
    releaseId: base[PRODUCT_TRUTH_WEB_CONTROL_ENV.releaseId],
    commitSha: COMMIT,
    treeSha: TREE,
    executableTreeSha256: EXECUTABLE,
    databaseTargetFingerprint: TARGET,
    manifestSha256: MANIFEST,
  });
  const runtimeBase = {
    ...base,
    [PRODUCT_TRUTH_WEB_CONTROL_ENV.confirmation]: confirmation,
  };
  const standingInput = {
    schemaVersion: "product-truth-web-control-runtime/1.0.0" as const,
    status: "ACTIVE" as const,
    stage: "PRODUCTION_READ_ONLY" as const,
    engine: {
      commandSchemaVersion: "product-truth-control-command/1.0.0" as const,
      releaseId: base[PRODUCT_TRUTH_WEB_CONTROL_ENV.releaseId],
      commitSha: COMMIT,
      treeSha: TREE,
      executableTreeSha256: EXECUTABLE,
    },
    target: {
      environment: "PRODUCTION" as const,
      databaseTargetFingerprint: TARGET,
      manifestSha256: MANIFEST,
    },
    unwrangleReserveFloor: 15000,
    workerTokenSha256: WORKER_TOKEN_SHA,
    claims: {
      commandAdmission: true as const,
      controlDatabaseWrites: true as const,
      workerClaims: true,
      processSpawnInWebRuntime: false as const,
      providerCallsInWebRuntime: false as const,
      marketplaceMutations: false as const,
      meteredExecutionAdmission: false as const,
    },
  };
  return {
    ...runtimeBase,
    [PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.enabled]: "1",
    [PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.standingProviderPolicySha256]:
      PROVIDER_POLICY,
    [PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.standingNoPaidPolicySha256]:
      NO_PAID_POLICY,
    [PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.confirmation]:
      expectedProductTruthStandingWaveWebConfirmation({
        base: standingInput,
        standingProviderPolicySha256: PROVIDER_POLICY,
        standingNoPaidPolicySha256: NO_PAID_POLICY,
      }),
  };
}

function request(operation: "START" | "RESUME" = "START") {
  return {
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_REQUEST_VERSION,
    requestId: "ptsw-request-00000001",
    operation,
    requestedAt: "2026-07-29T20:00:00.000Z",
    expiresAt: "2026-07-30T20:00:00.000Z",
    sourceCommandId:
      operation === "RESUME" ? "ptsw-command-00000001" : null,
    bindings: {
      manifestSha256: MANIFEST,
      standingProviderPolicySha256: PROVIDER_POLICY,
      standingNoPaidPolicySha256: NO_PAID_POLICY,
    },
    limits: {
      maxTargets: 5,
      maxLinkedListings: 100,
      maxProviderUnits: 30,
      maxLifetimeMs: 86_400_000,
      targetConcurrency: 1,
      maxAttemptsPerTarget: 1,
      automaticRetry: false,
    },
    claims: {
      authority: "PINNED_STANDING_POLICY",
      authoritativePhase1Only: true,
      noImplicitScope: true,
      noParallelCatalog: true,
      ambiguousNeverReplay: true,
      noMarketplaceMutation: true,
      noPriceOrInventoryChange: true,
      noDelisting: true,
      noConsumerActivation: true,
      noProcurement: true,
      noClubs: true,
      noBjs: true,
    },
  };
}

function file(name: string, content: string | Buffer) {
  const bytes = typeof content === "string"
    ? Buffer.from(content, "utf8")
    : content;
  return {
    name,
    mediaType: "application/json",
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

test("standing-wave web runtime remains OFF or requires exact release/policy binding", () => {
  assert.equal(loadProductTruthStandingWaveWebRuntime({ env: {} }).status, "OFF");
  const runtime = loadProductTruthStandingWaveWebRuntime({ env: activeEnv() });
  assert.equal(runtime.status, "ACTIVE");
  if (runtime.status !== "ACTIVE") return;
  assert.deepEqual(runtime.limits, {
    maxTargets: 5,
    maxLinkedListings: 100,
    maxProviderUnits: 30,
    concurrency: 1,
    retries: 0,
  });
  assert.equal(runtime.claims.ownerPromptRequired, false);
  assert.throws(
    () => loadProductTruthStandingWaveWebRuntime({
      env: {
        ...activeEnv(),
        [PRODUCT_TRUTH_STANDING_WAVE_WEB_ENV.confirmation]: "wrong",
      },
    }),
    /STANDING_WAVE_WEB_CONFIRMATION_INVALID/u,
  );
  assert.throws(
    () => loadProductTruthStandingWaveWebRuntime({
      env: {
        ...activeEnv(),
        [PRODUCT_TRUTH_WEB_CONTROL_ENV.stage]: "ADMISSION_ONLY",
      },
    }),
    /STANDING_WAVE_WEB_BASE_RUNTIME_INVALID/u,
  );
});

test("standing-wave request is byte-canonical and standing-policy bounded", () => {
  const parsed = parseProductTruthStandingWaveWebRequest(request());
  assert.equal(parsed.operation, "START");
  assert.equal(parsed.limits.automaticRetry, false);
  assert.equal(
    parseProductTruthStandingWaveWebRequestBytes(
      Buffer.from(renderProductTruthStandingWaveWebRequest(parsed), "utf8"),
    ).requestId,
    parsed.requestId,
  );
  assert.throws(
    () => parseProductTruthStandingWaveWebRequest({
      ...request(),
      limits: { ...request().limits, maxProviderUnits: 31 },
    }),
    /STANDING_WAVE_WEB_LIMIT_DRIFT/u,
  );
  assert.throws(
    () => parseProductTruthStandingWaveWebRequest({
      ...request(),
      sourceCommandId: "ptsw-command-00000001",
    }),
    /STANDING_WAVE_WEB_SOURCE_INVALID/u,
  );
  assert.throws(
    () => parseProductTruthStandingWaveWebRequestBytes(
      Buffer.from(JSON.stringify(request()), "utf8"),
    ),
    /STANDING_WAVE_WEB_BYTES_INVALID/u,
  );
});

test("standing-wave result requires complete immutable custody and zero mutation claims", () => {
  const planBytes = Buffer.from("{}\n", "utf8");
  const reportBytes = Buffer.from("{}\n", "utf8");
  const indexBytes = Buffer.from("{}\n", "utf8");
  const readinessBytes = Buffer.from('{"counts":{}}\n', "utf8");
  const planSha = createHash("sha256").update(planBytes).digest("hex");
  const reportSha = createHash("sha256").update(reportBytes).digest("hex");
  const indexSha = createHash("sha256").update(indexBytes).digest("hex");
  const readinessSha = createHash("sha256").update(readinessBytes).digest("hex");
  const files = [
    file("artifact-index.json", indexBytes),
    file("artifact-index.sha256", `${indexSha}\n`),
    file("readiness-report.json.gz", gzipSync(readinessBytes)),
    file("readiness-report.sha256", `${readinessSha}\n`),
    file("wave-plan.json", planBytes),
    file("wave-plan.sha256", `${planSha}\n`),
    file("wave-report.json", reportBytes),
    file("wave-report.sha256", `${reportSha}\n`),
  ];
  const result = parseProductTruthStandingWaveWebResult({
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION,
    commandId: "ptsw-command-00000001",
    operation: "START",
    exitCode: 0,
    outcome: "COMPLETED",
    waveId: "ptsw-web-00000001",
    targetCount: 5,
    completedTargetCount: 3,
    ambiguousTargetCount: 2,
    actualProviderUnits: 25,
    planSha256: planSha,
    reportSha256: reportSha,
    readinessReportSha256: readinessSha,
    files,
    claims: {
      shell: false,
      automaticRetry: false,
      retries: 0,
      marketplaceMutations: 0,
      priceOrInventoryChanges: 0,
      delistings: 0,
      consumerActivations: 0,
      procurementActions: 0,
    },
  });
  assert.equal(result.actualProviderUnits, 25);
  assert.throws(
    () => parseProductTruthStandingWaveWebResult({
      ...result,
      files: files.slice(1),
    }),
    /completed custody set is incomplete/u,
  );
  assert.throws(
    () => parseProductTruthStandingWaveWebResult({
      ...result,
      claims: { ...result.claims, marketplaceMutations: 1 },
    }),
    /result safety claims drifted/u,
  );
  assert.throws(
    () => parseProductTruthStandingWaveWebResult({
      ...result,
      actualProviderUnits: null,
    }),
    /completed result is incomplete/u,
  );
  assert.throws(
    () => parseProductTruthStandingWaveWebResult({
      ...result,
      ambiguousTargetCount: 1,
    }),
    /completed result is incomplete/u,
  );
});

test("standing-wave worker routes are isolated behind the least-privilege worker token", async () => {
  const root = new URL("../../../../", import.meta.url);
  const proxy = await readFile(new URL("src/proxy.ts", root), "utf8");
  const worker = await readFile(
    new URL("scripts/product-truth-standing-wave-worker.ts", root),
    "utf8",
  );
  assert.match(
    proxy,
    /pathname\.startsWith\("\/api\/external\/product-truth\/standing-wave\/"\)/u,
  );
  assert.match(worker, /shell:\s*false/u);
  assert.match(worker, /verifyPinnedCheckout\(runtime\)/u);
  assert.match(worker, /automaticRetry:\s*false/u);
  assert.doesNotMatch(worker, /exec\(|execFile\(|shell:\s*true/u);
});
