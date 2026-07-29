#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
import {
  parseProductTruthStandingWavePlan,
} from "../src/lib/sourcing/product-truth-standing-wave";
import {
  PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION,
  parseProductTruthStandingWaveWebRequest,
  parseProductTruthStandingWaveWebResult,
  type ProductTruthStandingWaveWebResult,
  type ProductTruthStandingWaveWebResultFile,
} from "../src/lib/sourcing/product-truth-standing-wave-web-contract";
import type {
  ProductTruthStandingWaveWebClaim,
} from "../src/lib/sourcing/product-truth-standing-wave-web-store";
import {
  productTruthExecutableTreeSha256,
} from "../src/lib/sourcing/product-truth-web-control-runtime";

const POLL_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_READINESS_BYTES = 16 * 1024 * 1024;
const RUNNER_PATH = resolve(
  process.cwd(),
  "scripts/product-truth-standing-wave.ts",
);

interface WorkerRuntime {
  baseUrl: string;
  token: string;
  workerId: string;
  databaseUrl: string;
  authTokenEnv: string | null;
  custodyRoot: string;
  once: boolean;
  release: {
    releaseId: string;
    commitSha: string;
    treeSha: string;
    executableTreeSha256: string;
    manifestSha256: string;
  };
  inputs: {
    manifestPath: string;
    standingProviderPolicyPath: string;
    standingProviderPolicySha256: string;
    standingNoPaidPolicyPath: string;
    standingNoPaidPolicySha256: string;
  };
}

interface StageExecution {
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
}

class WorkerStageError extends Error {
  readonly stage: string;
  readonly exitCode: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;

  constructor(stage: string, execution: StageExecution) {
    super(`standing-wave ${stage} exited ${execution.exitCode}`);
    this.name = "WorkerStageError";
    this.stage = stage;
    this.exitCode = execution.exitCode;
    this.stdoutSha256 = execution.stdoutSha256;
    this.stderrSha256 = execution.stderrSha256;
  }
}

function fail(message: string): never {
  throw new Error(`PRODUCT_TRUTH_STANDING_WAVE_WORKER_INVALID: ${message}`);
}

function exactEnv(name: string): string {
  const value = process.env[name];
  if (!value || value !== value.trim()) fail(`${name} is required as exact text`);
  return value;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function exactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) fail(`${label} must be lowercase SHA-256`);
  return value;
}

function exactAbsolutePath(value: string, label: string): string {
  if (resolve(value) !== value) fail(`${label} must be an absolute normalized path`);
  return value;
}

async function verifiedRegularFile(
  path: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  const [info, actualPath, bytes] = await Promise.all([
    lstat(path),
    realpath(path),
    readFile(path),
  ]);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || actualPath !== path
    || sha256(bytes) !== expectedSha256
  ) {
    fail(`${label} is not the exact pinned regular file`);
  }
}

async function verifiedCustodyRoot(path: string): Promise<void> {
  const [info, actualPath] = await Promise.all([lstat(path), realpath(path)]);
  if (!info.isDirectory() || info.isSymbolicLink() || actualPath !== path) {
    fail("custody root must be an existing non-symlink directory");
  }
}

async function runPinnedGit(args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", [...args], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let byteSize = 0;
    let overflow = false;
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      byteSize += chunk.byteLength;
      if (byteSize > 64 * 1024) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (overflow || code !== 0) {
        rejectPromise(new Error("pinned Git verification failed"));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function verifyPinnedCheckout(runtime: WorkerRuntime): Promise<void> {
  const [topLevelRaw, commitRaw, treeRaw, status] = await Promise.all([
    runPinnedGit(["rev-parse", "--show-toplevel"]),
    runPinnedGit(["rev-parse", "HEAD"]),
    runPinnedGit(["rev-parse", "HEAD^{tree}"]),
    runPinnedGit([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]),
  ]);
  const [actualCwd, expectedCwd] = await Promise.all([
    realpath(process.cwd()),
    realpath(join(topLevelRaw.trim(), "ss-control-center")),
  ]);
  const commitSha = commitRaw.trim();
  const treeSha = treeRaw.trim();
  if (
    actualCwd !== expectedCwd
    || status.length !== 0
    || commitSha !== runtime.release.commitSha
    || treeSha !== runtime.release.treeSha
    || productTruthExecutableTreeSha256(treeSha)
      !== runtime.release.executableTreeSha256
  ) {
    fail("worker checkout differs from the exact clean release");
  }
}

function runtimeFromEnv(): WorkerRuntime {
  const once = process.argv.length === 3 && process.argv[2] === "--once";
  if (process.argv.length !== (once ? 3 : 2)) {
    fail("usage: product-truth-standing-wave-worker.ts [--once]");
  }
  for (const providerEnv of [
    "UNWRANGLE_API_KEY",
    "OXYLABS_USERNAME",
    "OXYLABS_PASSWORD",
  ]) exactEnv(providerEnv);
  const baseUrl = exactEnv("PRODUCT_TRUTH_WEB_WORKER_BASE_URL")
    .replace(/\/+$/u, "");
  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== "https:" && parsedBase.hostname !== "localhost") {
    fail("worker base URL must use HTTPS except localhost");
  }
  const authTokenEnv =
    process.env.PRODUCT_TRUTH_WORKER_DATABASE_AUTH_TOKEN_ENV?.trim() || null;
  if (
    authTokenEnv !== null
    && !/^[A-Z][A-Z0-9_]{2,100}$/u.test(authTokenEnv)
  ) {
    fail("PRODUCT_TRUTH_WORKER_DATABASE_AUTH_TOKEN_ENV is invalid");
  }
  if (authTokenEnv !== null && !process.env[authTokenEnv]) {
    fail(`database auth token env ${authTokenEnv} is absent`);
  }
  return {
    baseUrl,
    token: exactEnv("PRODUCT_TRUTH_WEB_WORKER_TOKEN"),
    workerId: exactEnv("PRODUCT_TRUTH_STANDING_WAVE_WORKER_ID"),
    databaseUrl: exactEnv("PRODUCT_TRUTH_WORKER_DATABASE_URL"),
    authTokenEnv,
    custodyRoot: exactAbsolutePath(
      exactEnv("PRODUCT_TRUTH_STANDING_WAVE_CUSTODY_ROOT"),
      "PRODUCT_TRUTH_STANDING_WAVE_CUSTODY_ROOT",
    ),
    once,
    release: {
      releaseId: exactEnv("PRODUCT_TRUTH_WORKER_RELEASE_ID"),
      commitSha: exactEnv("PRODUCT_TRUTH_WORKER_COMMIT_SHA"),
      treeSha: exactEnv("PRODUCT_TRUTH_WORKER_TREE_SHA"),
      executableTreeSha256: exactSha(
        exactEnv("PRODUCT_TRUTH_WORKER_EXECUTABLE_TREE_SHA256"),
        "PRODUCT_TRUTH_WORKER_EXECUTABLE_TREE_SHA256",
      ),
      manifestSha256: exactSha(
        exactEnv("PRODUCT_TRUTH_WORKER_MANIFEST_SHA256"),
        "PRODUCT_TRUTH_WORKER_MANIFEST_SHA256",
      ),
    },
    inputs: {
      manifestPath: exactAbsolutePath(
        exactEnv("PRODUCT_TRUTH_STANDING_WAVE_MANIFEST_PATH"),
        "PRODUCT_TRUTH_STANDING_WAVE_MANIFEST_PATH",
      ),
      standingProviderPolicyPath: exactAbsolutePath(
        exactEnv("PRODUCT_TRUTH_STANDING_WAVE_PROVIDER_POLICY_PATH"),
        "PRODUCT_TRUTH_STANDING_WAVE_PROVIDER_POLICY_PATH",
      ),
      standingProviderPolicySha256: exactSha(
        exactEnv("PRODUCT_TRUTH_STANDING_WAVE_PROVIDER_POLICY_SHA256"),
        "PRODUCT_TRUTH_STANDING_WAVE_PROVIDER_POLICY_SHA256",
      ),
      standingNoPaidPolicyPath: exactAbsolutePath(
        exactEnv("PRODUCT_TRUTH_STANDING_WAVE_NO_PAID_POLICY_PATH"),
        "PRODUCT_TRUTH_STANDING_WAVE_NO_PAID_POLICY_PATH",
      ),
      standingNoPaidPolicySha256: exactSha(
        exactEnv("PRODUCT_TRUTH_STANDING_WAVE_NO_PAID_POLICY_SHA256"),
        "PRODUCT_TRUTH_STANDING_WAVE_NO_PAID_POLICY_SHA256",
      ),
    },
  };
}

async function verifyRuntime(runtime: WorkerRuntime): Promise<void> {
  const target = resolveProductTruthDatabaseTarget(runtime.databaseUrl);
  if (target.kind !== "remote" || runtime.authTokenEnv === null) {
    fail("standing-wave worker requires an authenticated remote Product Truth target");
  }
  await Promise.all([
    verifyPinnedCheckout(runtime),
    verifiedCustodyRoot(runtime.custodyRoot),
    verifiedRegularFile(
      runtime.inputs.manifestPath,
      runtime.release.manifestSha256,
      "authoritative manifest",
    ),
    verifiedRegularFile(
      runtime.inputs.standingProviderPolicyPath,
      runtime.inputs.standingProviderPolicySha256,
      "standing provider policy",
    ),
    verifiedRegularFile(
      runtime.inputs.standingNoPaidPolicyPath,
      runtime.inputs.standingNoPaidPolicySha256,
      "standing no-paid policy",
    ),
  ]);
}

async function api(
  runtime: WorkerRuntime,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${runtime.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json() as unknown;
  if (
    !response.ok
    || value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    fail(`control API ${path} returned HTTP ${response.status}`);
  }
  return value as Record<string, unknown>;
}

function parseClaim(value: unknown): ProductTruthStandingWaveWebClaim | null {
  if (value === null) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("claim is not an object");
  }
  const claim = value as ProductTruthStandingWaveWebClaim;
  const request = parseProductTruthStandingWaveWebRequest(claim.request);
  if (
    claim.schema_version !== "product-truth-standing-wave-web-store/1.0.0"
    || !/^ptswc-[a-f0-9]{32}$/u.test(claim.command_id)
    || !/^ptswc-[a-f0-9]{32}$/u.test(claim.workspace_key)
    || (claim.operation !== "START" && claim.operation !== "RESUME")
    || request.operation !== claim.operation
    || typeof claim.lease_token !== "string"
    || claim.lease_token.length < 32
  ) {
    fail("claim identity or request binding is invalid");
  }
  return { ...claim, request };
}

function verifyClaimPins(
  runtime: WorkerRuntime,
  claim: ProductTruthStandingWaveWebClaim,
): void {
  const target = resolveProductTruthDatabaseTarget(runtime.databaseUrl);
  if (
    claim.engine.release_id !== runtime.release.releaseId
    || claim.engine.commit_sha !== runtime.release.commitSha
    || claim.engine.tree_sha !== runtime.release.treeSha
    || claim.engine.executable_tree_sha256
      !== runtime.release.executableTreeSha256
    || claim.target.environment !== "PRODUCTION"
    || claim.target.database_target_fingerprint !== target.fingerprint
    || claim.target.manifest_sha256 !== runtime.release.manifestSha256
    || claim.request.bindings.manifestSha256 !== runtime.release.manifestSha256
    || claim.request.bindings.standingProviderPolicySha256
      !== runtime.inputs.standingProviderPolicySha256
    || claim.request.bindings.standingNoPaidPolicySha256
      !== runtime.inputs.standingNoPaidPolicySha256
    || Date.parse(claim.request.expiresAt) <= Date.now()
  ) {
    fail("claim differs from worker-pinned release/target/manifest/policies");
  }
}

function commonArgs(
  runtime: WorkerRuntime,
  claim: ProductTruthStandingWaveWebClaim,
): string[] {
  return [
    "--manifest",
    runtime.inputs.manifestPath,
    "--manifest-sha256",
    claim.request.bindings.manifestSha256,
    "--standing-provider-policy",
    runtime.inputs.standingProviderPolicyPath,
    "--standing-provider-policy-sha256",
    claim.request.bindings.standingProviderPolicySha256,
    "--standing-no-paid-policy",
    runtime.inputs.standingNoPaidPolicyPath,
    "--standing-no-paid-policy-sha256",
    claim.request.bindings.standingNoPaidPolicySha256,
    "--url",
    runtime.databaseUrl,
    "--allow-remote",
    ...(runtime.authTokenEnv
      ? ["--auth-token-env", runtime.authTokenEnv]
      : []),
  ];
}

async function spawnRunner(input: {
  args: readonly string[];
  heartbeat: () => Promise<void>;
}): Promise<StageExecution> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [...input.args], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const capture = (
      target: Buffer[],
      counter: () => number,
      increment: (amount: number) => void,
    ) => (chunk: Buffer) => {
      increment(chunk.byteLength);
      if (counter() > MAX_CAPTURE_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on(
      "data",
      capture(stdout, () => stdoutBytes, (amount) => {
        stdoutBytes += amount;
      }),
    );
    child.stderr.on(
      "data",
      capture(stderr, () => stderrBytes, (amount) => {
        stderrBytes += amount;
      }),
    );
    child.on("error", rejectPromise);
    const timer = setInterval(() => {
      void input.heartbeat().catch(() => child.kill("SIGTERM"));
    }, HEARTBEAT_MS);
    child.on("close", (code) => {
      clearInterval(timer);
      const stdoutValue = Buffer.concat(stdout);
      const stderrValue = Buffer.concat(stderr);
      resolvePromise({
        exitCode:
          !overflow && typeof code === "number" && code >= 0 ? code : 1,
        stdoutSha256: sha256(stdoutValue),
        stderrSha256: sha256(stderrValue),
      });
    });
  });
}

async function runStage(input: {
  stage: string;
  args: readonly string[];
  heartbeat: () => Promise<void>;
}): Promise<void> {
  const execution = await spawnRunner({
    args: input.args,
    heartbeat: input.heartbeat,
  });
  if (execution.exitCode !== 0) {
    throw new WorkerStageError(input.stage, execution);
  }
}

async function exactFile(
  path: string,
  maximumBytes = 4 * 1024 * 1024,
): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
    fail(`artifact ${path} is not a bounded regular file`);
  }
  return readFile(path);
}

async function sealedFile(
  root: string,
  name: string,
  maximumBytes?: number,
): Promise<{ bytes: Buffer; sha256: string; sidecar: Buffer }> {
  const bytes = await exactFile(join(root, name), maximumBytes);
  const digest = sha256(bytes);
  const sidecar = await exactFile(join(root, `${name.replace(/\\.json$/u, "")}.sha256`));
  if (sidecar.toString("utf8") !== `${digest}\n`) {
    fail(`${name} sidecar differs from exact bytes`);
  }
  return { bytes, sha256: digest, sidecar };
}

function resultFile(
  name: string,
  mediaType: string,
  bytes: Buffer,
): ProductTruthStandingWaveWebResultFile {
  return {
    name,
    mediaType,
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
    contentBase64: bytes.toString("base64"),
  };
}

async function completedResult(input: {
  claim: ProductTruthStandingWaveWebClaim;
  workspace: string;
}): Promise<ProductTruthStandingWaveWebResult> {
  const planRoot = join(input.workspace, "plan");
  const runRoot = join(input.workspace, "run");
  const plan = await sealedFile(planRoot, "wave-plan.json");
  const report = await sealedFile(runRoot, "wave-report.json");
  const index = await sealedFile(runRoot, "artifact-index.json");
  const readiness = await sealedFile(
    join(runRoot, "readiness"),
    "readiness-report.json",
    MAX_READINESS_BYTES,
  );
  const parsedPlan = parseProductTruthStandingWavePlan(
    JSON.parse(plan.bytes.toString("utf8")),
  );
  const parsedReport = JSON.parse(report.bytes.toString("utf8")) as {
    status?: unknown;
    waveId?: unknown;
    planSha256?: unknown;
    targetReports?: unknown;
    totals?: unknown;
    readiness?: unknown;
    claims?: unknown;
  };
  const parsedIndex = JSON.parse(index.bytes.toString("utf8")) as {
    status?: unknown;
    waveId?: unknown;
    planSha256?: unknown;
    reportSha256?: unknown;
    readinessReportSha256?: unknown;
    targetCount?: unknown;
    actualProviderUnits?: unknown;
    retries?: unknown;
    marketplaceMutations?: unknown;
  };
  const targetReports = Array.isArray(parsedReport.targetReports)
    ? parsedReport.targetReports
    : [];
  const reportTotals = isRecord(parsedReport.totals)
    ? parsedReport.totals
    : null;
  const targetReportsAreExact = targetReports.every((entry) =>
    isRecord(entry)
    && (entry.outcome === "COMPLETED" || entry.outcome === "AMBIGUOUS")
    && finiteNonNegativeNumber(entry.actualProviderUnits),
  );
  const targetProviderUnits = targetReports.reduce(
    (total, entry) =>
      total + (
        isRecord(entry) && finiteNonNegativeNumber(entry.actualProviderUnits)
          ? entry.actualProviderUnits
          : 0
      ),
    0,
  );
  if (
    parsedReport.status !== "COMPLETED"
    || parsedReport.waveId !== parsedPlan.waveId
    || parsedReport.planSha256 !== plan.sha256
    || targetReports.length !== parsedPlan.targets.length
    || targetReports.length > input.claim.request.limits.maxTargets
    || !targetReportsAreExact
    || reportTotals === null
    || reportTotals.targets !== targetReports.length
    || reportTotals.maximumProviderUnits
      !== input.claim.request.limits.maxProviderUnits
    || reportTotals.retries !== 0
    || reportTotals.marketplaceMutations !== 0
    || !finiteNonNegativeNumber(reportTotals.actualProviderUnits)
    || parsedIndex.status !== "COMPLETED"
    || parsedIndex.waveId !== parsedPlan.waveId
    || parsedIndex.planSha256 !== plan.sha256
    || parsedIndex.reportSha256 !== report.sha256
    || parsedIndex.readinessReportSha256 !== readiness.sha256
    || parsedIndex.targetCount !== targetReports.length
    || parsedIndex.retries !== 0
    || parsedIndex.marketplaceMutations !== 0
    || !finiteNonNegativeNumber(parsedIndex.actualProviderUnits)
    || parsedIndex.actualProviderUnits
      > input.claim.request.limits.maxProviderUnits
    || parsedIndex.actualProviderUnits !== reportTotals.actualProviderUnits
    || Math.abs(targetProviderUnits - parsedIndex.actualProviderUnits) > 1e-9
  ) {
    fail("completed wave artifacts failed their cross-binding");
  }
  const completedTargetCount = targetReports.filter(
    (entry) =>
      entry !== null
      && typeof entry === "object"
      && !Array.isArray(entry)
      && (entry as { outcome?: unknown }).outcome === "COMPLETED",
  ).length;
  const ambiguousTargetCount = targetReports.filter(
    (entry) =>
      entry !== null
      && typeof entry === "object"
      && !Array.isArray(entry)
      && (entry as { outcome?: unknown }).outcome === "AMBIGUOUS",
  ).length;
  const files = [
    resultFile("artifact-index.json", "application/json", index.bytes),
    resultFile("artifact-index.sha256", "text/plain", index.sidecar),
    resultFile(
      "readiness-report.json.gz",
      "application/gzip",
      gzipSync(readiness.bytes, { level: 9 }),
    ),
    resultFile("readiness-report.sha256", "text/plain", readiness.sidecar),
    resultFile("wave-plan.json", "application/json", plan.bytes),
    resultFile("wave-plan.sha256", "text/plain", plan.sidecar),
    resultFile("wave-report.json", "application/json", report.bytes),
    resultFile("wave-report.sha256", "text/plain", report.sidecar),
  ].sort((left, right) => left.name.localeCompare(right.name, "en-US"));
  return parseProductTruthStandingWaveWebResult({
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION,
    commandId: input.claim.command_id,
    operation: input.claim.operation,
    exitCode: 0,
    outcome: "COMPLETED",
    waveId: parsedPlan.waveId,
    targetCount: parsedPlan.targets.length,
    completedTargetCount,
    ambiguousTargetCount,
    actualProviderUnits: parsedIndex.actualProviderUnits,
    planSha256: plan.sha256,
    reportSha256: report.sha256,
    readinessReportSha256: readiness.sha256,
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
}

function failedResult(input: {
  claim: ProductTruthStandingWaveWebClaim;
  error: unknown;
  providerBoundaryStarted: boolean;
}): ProductTruthStandingWaveWebResult {
  const stageError = input.error instanceof WorkerStageError
    ? input.error
    : null;
  const failureBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "product-truth-standing-wave-worker-failure/1.0.0",
    commandId: input.claim.command_id,
    operation: input.claim.operation,
    stage: stageError?.stage ?? "PREPARE",
    exitCode: stageError?.exitCode ?? 1,
    stdoutSha256: stageError?.stdoutSha256 ?? null,
    stderrSha256: stageError?.stderrSha256 ?? null,
    providerBoundaryStarted: input.providerBoundaryStarted,
    rawOutputIncluded: false,
  })}\n`, "utf8");
  return parseProductTruthStandingWaveWebResult({
    schemaVersion: PRODUCT_TRUTH_STANDING_WAVE_WEB_RESULT_VERSION,
    commandId: input.claim.command_id,
    operation: input.claim.operation,
    exitCode: stageError?.exitCode ?? 1,
    outcome: input.providerBoundaryStarted ? "AMBIGUOUS" : "FAILED",
    waveId: null,
    targetCount: null,
    completedTargetCount: 0,
    ambiguousTargetCount: 0,
    actualProviderUnits: input.providerBoundaryStarted ? null : 0,
    planSha256: null,
    reportSha256: null,
    readinessReportSha256: null,
    files: [resultFile("failure.json", "application/json", failureBytes)],
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
}

async function executeClaim(
  runtime: WorkerRuntime,
  claim: ProductTruthStandingWaveWebClaim,
): Promise<void> {
  verifyClaimPins(runtime, claim);
  await api(
    runtime,
    `/api/external/product-truth/standing-wave/${claim.command_id}/start`,
    { lease_token: claim.lease_token },
  );
  const workspace = join(runtime.custodyRoot, claim.workspace_key);
  let providerBoundaryStarted = false;
  const heartbeat = async () => {
    await api(
      runtime,
      `/api/external/product-truth/standing-wave/${claim.command_id}/heartbeat`,
      { lease_token: claim.lease_token },
    );
  };
  let result: ProductTruthStandingWaveWebResult;
  try {
    if (claim.operation === "START") {
      await mkdir(workspace, { recursive: false, mode: 0o700 });
      await runStage({
        stage: "PLAN",
        heartbeat,
        args: [
          "--import",
          "tsx",
          RUNNER_PATH,
          "plan",
          "--wave-id",
          `ptsw-web-${claim.workspace_key.slice(6)}`,
          "--created-at",
          claim.request.requestedAt,
          "--expires-at",
          claim.request.expiresAt,
          "--max-targets",
          String(claim.request.limits.maxTargets),
          ...commonArgs(runtime, claim),
          "--out",
          join(workspace, "plan"),
        ],
      });
    } else {
      const [info, actualWorkspace] = await Promise.all([
        lstat(workspace),
        realpath(workspace),
      ]);
      if (
        !info.isDirectory()
        || info.isSymbolicLink()
        || actualWorkspace !== workspace
      ) {
        fail("resume workspace is absent or unsafe");
      }
    }
    const plan = await sealedFile(join(workspace, "plan"), "wave-plan.json");
    providerBoundaryStarted = true;
    await runStage({
      stage: claim.operation === "START" ? "EXECUTE" : "RESUME",
      heartbeat,
      args: [
        "--import",
        "tsx",
        RUNNER_PATH,
        claim.operation === "START" ? "execute" : "resume",
        "--plan",
        join(workspace, "plan", "wave-plan.json"),
        "--plan-sha256",
        plan.sha256,
        "--work-dir",
        join(workspace, "run"),
        ...commonArgs(runtime, claim),
      ],
    });
    result = await completedResult({ claim, workspace });
  } catch (error) {
    result = failedResult({ claim, error, providerBoundaryStarted });
  }
  await api(
    runtime,
    `/api/external/product-truth/standing-wave/${claim.command_id}/complete`,
    {
      lease_token: claim.lease_token,
      result,
    },
  );
}

async function main(): Promise<void> {
  const runtime = runtimeFromEnv();
  await verifyRuntime(runtime);
  for (;;) {
    const response = await api(
      runtime,
      "/api/external/product-truth/standing-wave/claim",
      { worker_id: runtime.workerId },
    );
    const claim = parseClaim(response.claim);
    if (claim) await executeClaim(runtime, claim);
    if (runtime.once) return;
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, claim ? 250 : POLL_MS);
    });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
