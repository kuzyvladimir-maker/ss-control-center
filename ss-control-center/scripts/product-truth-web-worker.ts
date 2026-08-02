#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createClient } from "@libsql/client";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
import {
  productTruthExecutableTreeSha256,
} from "../src/lib/sourcing/product-truth-web-control-runtime";
import {
  PRODUCT_TRUTH_WORKER_RESULT_VERSION,
  parseProductTruthWorkerResult,
} from "../src/lib/sourcing/product-truth-web-control-worker-contract";
import type {
  ProductTruthWebWorkerClaim,
} from "../src/lib/sourcing/product-truth-web-control-worker";
import {
  PRODUCT_TRUTH_WORKER_CONTROL_API_TIMEOUT_MS,
  PRODUCT_TRUTH_WORKER_HEARTBEAT_MS,
  ProductTruthHeartbeatRetryPolicy,
  ProductTruthWorkerLease,
  productTruthControlApiFailureDisposition,
  productTruthHeartbeatFailureRequiresTermination,
  retryProductTruthLeaseOperation,
  terminateProductTruthWorkerProcessTree,
} from "../src/lib/sourcing/product-truth-worker-lease";
import {
  PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
  expectedProductTruthExecutionConfirmation,
  renderProductTruthOperationalJson,
  type ProductTruthOperationalApproval,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import {
  parseProductTruthTargetedWalmartEvidencePlan,
} from "../src/lib/sourcing/product-truth-targeted-walmart-evidence-contract";
import {
  parseProductTruthWalmartEnrichmentQuote,
} from "../src/lib/sourcing/product-truth-walmart-enrichment-quote";
import {
  PRODUCT_TRUTH_WALMART_ENRICHMENT_PROGRESS_VERSION,
  PRODUCT_TRUTH_WALMART_ENRICHMENT_RESULT_VERSION,
  assertProductTruthWalmartEnrichmentResult,
  parseProductTruthWalmartEnrichmentProgress,
  type ProductTruthWalmartEnrichmentProgress,
  type ProductTruthWalmartEnrichmentStage,
  type ProductTruthWalmartEnrichmentResult,
} from "../src/lib/sourcing/product-truth-walmart-enrichment-worker-contract";
import {
  expectedMeteredRunConfirmation,
  type MeteredRunPermit,
} from "../src/lib/sourcing/metered-call-guard";
import {
  withMeteredProviderCall,
  type MeteredProviderAuthorization,
} from "../src/lib/sourcing/metered-provider-call";
import {
  ensureMeteredProviderBudget,
} from "../src/lib/sourcing/metered-budget-store";
import {
  readProductTruthOperationalLedger,
} from "../src/lib/sourcing/product-truth-operational-ledger";

const POLL_MS = 5_000;
const COMPLETION_ATTEMPTS = 3;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const RUNNER_PATH = resolve(
  process.cwd(),
  "scripts/product-truth-runner.ts",
);

interface WorkerRuntime {
  baseUrl: string;
  token: string;
  workerId: string;
  databaseUrl: string;
  authTokenEnv: string | null;
  once: boolean;
  release: {
    releaseId: string;
    commitSha: string;
    treeSha: string;
    executableTreeSha256: string;
    manifestSha256: string;
  };
}

class WorkerControlApiError extends Error {
  readonly retryable: boolean;
  readonly authorityRejected: boolean;
  readonly code: string | null;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      authorityRejected?: boolean;
      code?: string | null;
      cause?: unknown;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WorkerControlApiError";
    this.retryable = options.retryable;
    this.authorityRejected = options.authorityRejected ?? false;
    this.code = options.code ?? null;
  }
}

function fail(message: string): never {
  throw new Error(`PRODUCT_TRUTH_WEB_WORKER_INVALID: ${message}`);
}

function exactEnv(name: string): string {
  const value = process.env[name];
  if (!value || value !== value.trim()) fail(`${name} is required as exact text`);
  return value;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
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
    let outputTooLarge = false;
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      byteSize += chunk.byteLength;
      if (byteSize > MAX_GIT_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (outputTooLarge) {
        rejectPromise(
          new Error("pinned git verification exceeded its output limit"),
        );
        return;
      }
      if (code !== 0) {
        rejectPromise(
          new Error(
            `pinned git verification failed: ${Buffer.concat(stderr)
              .toString("utf8")
              .trim() || `exit ${String(code)}`}`,
          ),
        );
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
  const topLevel = topLevelRaw.trim();
  const commitSha = commitRaw.trim();
  const treeSha = treeRaw.trim();
  const [actualCwd, expectedCwd] = await Promise.all([
    realpath(process.cwd()),
    realpath(join(topLevel, "ss-control-center")),
  ]);
  if (actualCwd !== expectedCwd) {
    fail("worker must start from the pinned ss-control-center directory");
  }
  if (status.length !== 0) {
    fail("worker checkout contains tracked or untracked release drift");
  }
  if (
    commitSha !== runtime.release.commitSha
    || treeSha !== runtime.release.treeSha
    || productTruthExecutableTreeSha256(treeSha)
      !== runtime.release.executableTreeSha256
  ) {
    fail("worker checkout differs from the pinned release");
  }
}

function runtimeFromEnv(): WorkerRuntime {
  const once = process.argv.length === 3 && process.argv[2] === "--once";
  if (
    process.argv.length !== (once ? 3 : 2)
  ) {
    fail("usage: product-truth-web-worker.ts [--once]");
  }
  const baseUrl = exactEnv("PRODUCT_TRUTH_WEB_WORKER_BASE_URL").replace(/\/+$/u, "");
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
    workerId: exactEnv("PRODUCT_TRUTH_WEB_WORKER_ID"),
    databaseUrl: exactEnv("PRODUCT_TRUTH_WORKER_DATABASE_URL"),
    authTokenEnv,
    once,
    release: {
      releaseId: exactEnv("PRODUCT_TRUTH_WORKER_RELEASE_ID"),
      commitSha: exactEnv("PRODUCT_TRUTH_WORKER_COMMIT_SHA"),
      treeSha: exactEnv("PRODUCT_TRUTH_WORKER_TREE_SHA"),
      executableTreeSha256: exactEnv(
        "PRODUCT_TRUTH_WORKER_EXECUTABLE_TREE_SHA256",
      ),
      manifestSha256: exactEnv("PRODUCT_TRUTH_WORKER_MANIFEST_SHA256"),
    },
  };
}

async function api(
  runtime: WorkerRuntime,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${runtime.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        PRODUCT_TRUTH_WORKER_CONTROL_API_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    throw new WorkerControlApiError(
      `control API ${path} was temporarily unreachable`,
      { retryable: true, cause: error },
    );
  }
  let value: unknown;
  try {
    value = await response.json() as unknown;
  } catch (error) {
    throw new WorkerControlApiError(
      `control API ${path} returned unreadable JSON`,
      {
        retryable:
          response.ok
          || productTruthControlApiFailureDisposition({
            status: response.status,
            code: null,
          }).retryable,
        cause: error,
      },
    );
  }
  if (
    !response.ok
    || value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    const code =
      value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && typeof (value as { code?: unknown }).code === "string"
        ? (value as { code: string }).code
        : null;
    const disposition = productTruthControlApiFailureDisposition({
      status: response.status,
      code,
    });
    throw new WorkerControlApiError(
      `control API ${path} returned HTTP ${response.status}${
        code ? ` (${code})` : ""
      }`,
      { ...disposition, code },
    );
  }
  return value as Record<string, unknown>;
}

function retryableControlError(error: unknown): boolean {
  return error instanceof WorkerControlApiError && error.retryable;
}

async function leaseBoundApi(
  runtime: WorkerRuntime,
  lease: ProductTruthWorkerLease,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  return retryProductTruthLeaseOperation({
    lease,
    shouldRetry: retryableControlError,
    operation: () => api(runtime, path, body),
  });
}

async function heartbeatLeaseBoundApi(
  runtime: WorkerRuntime,
  lease: ProductTruthWorkerLease,
  path: string,
  body: unknown,
): Promise<void> {
  const retryPolicy = new ProductTruthHeartbeatRetryPolicy();
  await retryProductTruthLeaseOperation({
    lease,
    shouldRetry: (error) =>
      retryPolicy.shouldRetry({
        retryable: retryableControlError(error),
        authorityRejected:
          error instanceof WorkerControlApiError
          && error.authorityRejected,
      }),
    operation: async () => {
      const response = await api(runtime, path, body);
      try {
        refreshLease(lease, response);
      } catch (error) {
        throw new WorkerControlApiError(
          `control API ${path} returned an invalid lease renewal`,
          { retryable: true, cause: error },
        );
      }
    },
  });
}

function refreshLease(
  lease: ProductTruthWorkerLease,
  response: Record<string, unknown>,
): void {
  if (typeof response.lease_expires_at !== "string") {
    fail("heartbeat omitted its lease expiry");
  }
  lease.refresh(response.lease_expires_at);
}

/**
 * Retry only the control-plane acknowledgement with the exact same immutable
 * result. The paid provider work has already ended before this function is
 * entered, so a transient remote database failure can never replay a provider
 * request or advance another enrichment job.
 */
async function completeClaim(
  runtime: WorkerRuntime,
  claim: ProductTruthWebWorkerClaim,
  result: unknown,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt += 1) {
    try {
      await api(
        runtime,
        `/api/external/product-truth/control/${claim.command_id}/complete`,
        {
          lease_token: claim.lease_token,
          result,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < COMPLETION_ATTEMPTS) {
        await new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, attempt * 250);
        });
      }
    }
  }
  throw lastError;
}

function parseClaim(value: unknown): ProductTruthWebWorkerClaim | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    fail("claim is not an object");
  }
  const claim = value as ProductTruthWebWorkerClaim;
  if (
    (
      claim.command_kind !== "DOCTOR"
      && claim.command_kind !== "RUN_PLAN"
      && claim.command_kind !== "EXECUTE"
    )
    || claim.spec?.kind !== claim.command_kind
    || !claim.command_id
    || !claim.lease_token
  ) {
    fail("claim identity or typed spec is invalid");
  }
  return claim;
}

function verifyClaimPins(
  runtime: WorkerRuntime,
  claim: ProductTruthWebWorkerClaim,
): void {
  const target = resolveProductTruthDatabaseTarget(runtime.databaseUrl);
  if (
    claim.engine.release_id !== runtime.release.releaseId
    || claim.engine.commit_sha !== runtime.release.commitSha
    || claim.engine.tree_sha !== runtime.release.treeSha
    || claim.engine.executable_tree_sha256
      !== runtime.release.executableTreeSha256
    || claim.target.manifest_sha256 !== runtime.release.manifestSha256
    || claim.target.database_target_fingerprint !== target.fingerprint
  ) {
    fail("claim differs from worker-pinned release/target/manifest");
  }
  if (target.kind === "remote" && runtime.authTokenEnv === null) {
    fail("remote Product Truth target requires an out-of-band auth token env");
  }
  if (target.kind === "local" && runtime.authTokenEnv !== null) {
    fail("local Product Truth target cannot carry remote authentication");
  }
}

function commonDatabaseArgs(runtime: WorkerRuntime): string[] {
  const target = resolveProductTruthDatabaseTarget(runtime.databaseUrl);
  return [
    "--url",
    runtime.databaseUrl,
    ...(target.kind === "remote" ? ["--allow-remote"] : []),
    ...(runtime.authTokenEnv
      ? ["--auth-token-env", runtime.authTokenEnv]
      : []),
  ];
}

async function runnerArgs(
  runtime: WorkerRuntime,
  claim: ProductTruthWebWorkerClaim,
  root: string,
): Promise<{ args: string[]; outputDirectory: string }> {
  const outputDirectory = join(root, "output");
  if (claim.spec.kind === "DOCTOR") {
    return {
      args: [
        "--import",
        "tsx",
        RUNNER_PATH,
        "doctor",
        ...commonDatabaseArgs(runtime),
        "--donor-product-id",
        claim.spec.donor_product_id,
        "--query",
        claim.spec.query,
        "--run-id",
        claim.spec.run_id,
        "--expires-at",
        claim.spec.expires_at,
        "--unwrangle-reserve-floor",
        String(claim.spec.unwrangle_reserve_floor),
        "--out",
        outputDirectory,
      ],
      outputDirectory,
    };
  }
  if (claim.spec.kind !== "RUN_PLAN") {
    fail("EXECUTE claims use the owner-gated batch executor");
  }
  const requestPath = join(root, "request.json");
  const requestBytes = Buffer.from(
    claim.spec.request_content_base64,
    "base64",
  );
  if (sha256(requestBytes) !== claim.spec.request_sha256) {
    fail("RUN_PLAN request bytes differ from their server seal");
  }
  await writeFile(requestPath, requestBytes, { flag: "wx", mode: 0o600 });
  return {
    args: [
      "--import",
      "tsx",
      RUNNER_PATH,
      "plan",
      ...commonDatabaseArgs(runtime),
      "--request",
      requestPath,
      "--out",
      outputDirectory,
    ],
    outputDirectory,
  };
}

async function spawnRunner(input: {
  args: readonly string[];
  heartbeat: () => Promise<void>;
  lease: ProductTruthWorkerLease;
}): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [...input.args], {
      cwd: process.cwd(),
      env: process.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let heartbeatInFlight = false;
    let terminationRequested = false;
    const terminateTree = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminateProductTruthWorkerProcessTree({
        pid: child.pid,
        killChild: (signal) => child.kill(signal),
      });
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectPromise);
    let heartbeatInFlight: Promise<void> | null = null;
    let heartbeatError: unknown;
    const timer = setInterval(() => {
      if (!input.lease.canContinue()) {
        terminateTree();
        return;
      }
      if (heartbeatInFlight !== null) return;
      heartbeatInFlight = input
        .heartbeat()
        .catch((error: unknown) => {
          // The heartbeat callback already retried transient control-plane
          // failures (ProductTruthHeartbeatRetryPolicy). Terminate the child
          // only when the lease itself can no longer be trusted; a transient
          // remote-database hiccup must never kill a free job.
          if (
            productTruthHeartbeatFailureRequiresTermination({
              lease: input.lease,
              retryable: retryableControlError(error),
            })
          ) {
            heartbeatError = error;
            terminateTree();
          }
        })
        .finally(() => {
          heartbeatInFlight = null;
          if (!input.lease.canContinue()) terminateTree();
        });
    }, PRODUCT_TRUTH_WORKER_HEARTBEAT_MS);
    child.on("close", async (code) => {
      clearInterval(timer);
      const pendingHeartbeat = heartbeatInFlight;
      if (pendingHeartbeat !== null) await pendingHeartbeat;
      const heartbeatFailure = heartbeatError === undefined
        ? Buffer.alloc(0)
        : Buffer.from(
            `Control heartbeat failed: ${
              heartbeatError instanceof Error
                ? heartbeatError.message
                : String(heartbeatError)
            }\n`,
            "utf8",
          );
      resolvePromise({
        exitCode: heartbeatError === undefined
          && typeof code === "number"
          && code >= 0
          ? code
          : 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat([...stderr, heartbeatFailure]),
      });
    });
  });
}

async function resultFiles(input: {
  commandKind: "DOCTOR" | "RUN_PLAN";
  exitCode: number;
  outputDirectory: string;
  stdout: Buffer;
  stderr: Buffer;
}) {
  const names =
    input.exitCode === 0
      ? input.commandKind === "DOCTOR"
        ? ["request.json", "request.sha256"]
        : ["approval-instructions.json", "plan.json", "plan.sha256"]
      : ["stderr.txt", "stdout.txt"];
  const files = [];
  for (const name of names) {
    const content =
      input.exitCode === 0
        ? await readFile(join(input.outputDirectory, name))
        : name === "stderr.txt"
          ? input.stderr.length > 0
            ? input.stderr
            : Buffer.from("runner exited without stderr\n", "utf8")
          : input.stdout.length > 0
            ? input.stdout
            : Buffer.from("runner exited without stdout\n", "utf8");
    files.push({
      name,
      byteSize: content.byteLength,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    });
  }
  return files;
}

type BalanceEvidence = {
  provider: "unwrangle";
  observedAt: string;
  balanceUnits: number;
  reserveFloor: number;
  evidenceSha256: string;
};

function meteredRuntimeEnv(runtime: WorkerRuntime, permit: MeteredRunPermit) {
  const authToken = runtime.authTokenEnv
    ? process.env[runtime.authTokenEnv]
    : undefined;
  return {
    SS_METERED_RUN_PERMIT:
      Buffer.from(JSON.stringify(permit), "utf8").toString("base64url"),
    SS_METERED_RUN_CONFIRM: expectedMeteredRunConfirmation(permit),
    TURSO_DATABASE_URL: runtime.databaseUrl,
    DATABASE_URL: runtime.databaseUrl,
    ...(authToken ? { TURSO_AUTH_TOKEN: authToken } : {}),
  };
}

async function initialUnwrangleBalanceEvidence(input: {
  runtime: WorkerRuntime;
  claim: ProductTruthWebWorkerClaim & {
    spec: Extract<ProductTruthWebWorkerClaim["spec"], { kind: "EXECUTE" }>;
  };
  quoteId: string;
  quoteExpiresAt: string;
  reserveFloor: number;
}): Promise<BalanceEvidence> {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Math.min(
    Date.now() + 30 * 60_000,
    Date.parse(input.quoteExpiresAt),
  )).toISOString();
  const permit: MeteredRunPermit = {
    version: 1,
    runId: `${input.claim.spec.batch_id}-balance-probe`,
    approvalId: `${input.quoteId}_balance_probe`,
    approvedBy: "owner",
    issuedAt,
    expiresAt,
    providers: {
      unwrangle: {
        operations: ["balance_probe"],
        maxCalls: 1,
        maxUnits: 2.5,
      },
    },
  };
  const environment = meteredRuntimeEnv(input.runtime, permit);
  const db = createClient({
    url: input.runtime.databaseUrl,
    ...(environment.TURSO_AUTH_TOKEN
      ? { authToken: environment.TURSO_AUTH_TOKEN }
      : {}),
  });
  let authorization: MeteredProviderAuthorization | null = null;
  try {
    await ensureMeteredProviderBudget(db, {
      permit,
      confirmation: environment.SS_METERED_RUN_CONFIRM,
      provider: "unwrangle",
    });
    const apiKey = exactEnv("UNWRANGLE_API_KEY");
    const balanceUnits = await withMeteredProviderCall({
      provider: "unwrangle",
      operation: "balance_probe",
      units: 2.5,
      requestFingerprint: {
        schemaVersion: "product-truth-unwrangle-balance-probe/1.0.0",
        batchId: input.claim.spec.batch_id,
        quoteSha256: input.claim.spec.quote_sha256,
        platform: "target_search",
        search: "water",
      },
      onAuthorized: (value) => {
        authorization = value;
      },
    }, async () => {
      const response = await fetch(
        "https://data.unwrangle.com/api/getter/"
        + `?platform=target_search&search=water&api_key=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(25_000) },
      );
      if (!response.ok) {
        throw new Error(`Unwrangle balance probe returned HTTP ${response.status}`);
      }
      const value = await response.json() as Record<string, unknown>;
      const remaining = value.remaining_credits;
      if (
        typeof remaining !== "number"
        || !Number.isFinite(remaining)
        || remaining < 0
      ) {
        throw new Error("Unwrangle balance response omitted remaining_credits");
      }
      return remaining;
    }, environment);
    if (!authorization) {
      fail("balance probe did not produce a durable reservation");
    }
    const observedAt = new Date().toISOString();
    const evidenceCore = {
      schemaVersion: "unwrangle-balance-observation/1.0.0",
      provider: "unwrangle",
      observedAt,
      balanceUnits,
      reserveFloor: input.reserveFloor,
      receiptId: authorization.receiptId,
      batchId: input.claim.spec.batch_id,
      quoteSha256: input.claim.spec.quote_sha256,
    };
    return {
      provider: "unwrangle",
      observedAt,
      balanceUnits,
      reserveFloor: input.reserveFloor,
      evidenceSha256: sha256(`${JSON.stringify(evidenceCore)}\n`),
    };
  } finally {
    await db.close();
  }
}

function approvalForPlan(input: {
  plan: ReturnType<typeof parseProductTruthTargetedWalmartEvidencePlan>;
  planSha256: string;
  quoteId: string;
  balanceEvidence: BalanceEvidence;
}): {
  approval: ProductTruthOperationalApproval;
  confirmation: string;
} {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Math.min(
    Date.now() + 30 * 60_000,
    Date.parse(input.plan.expiresAt),
  )).toISOString();
  const approvalId =
    `ptwa_${sha256(`${input.quoteId}:${input.planSha256}`).slice(0, 32)}`;
  const permit: MeteredRunPermit = {
    version: 1,
    runId: input.plan.runId,
    approvalId,
    approvedBy: "owner",
    issuedAt,
    expiresAt,
    providers: Object.fromEntries(
      input.plan.providerCeilings.map((ceiling) => [
        ceiling.provider,
        {
          operations: [...ceiling.operations],
          maxCalls: ceiling.maxCalls,
          ...(ceiling.maxUnits == null
            ? {}
            : { maxUnits: ceiling.maxUnits }),
        },
      ]),
    ),
  };
  const approval: ProductTruthOperationalApproval = {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
    approvedBy: "owner",
    runId: input.plan.runId,
    approvalId,
    action: "EXECUTE_WAVE",
    planSha256: input.planSha256,
    targetFingerprint: input.plan.targetFingerprint,
    issuedAt,
    expiresAt,
    meteredPermit: permit,
    balanceEvidence: [input.balanceEvidence],
  };
  return {
    approval,
    confirmation:
      expectedProductTruthExecutionConfirmation(input.planSha256, approvalId),
  };
}

async function readLedger(
  runtime: WorkerRuntime,
  runId: string,
) {
  const authToken = runtime.authTokenEnv
    ? process.env[runtime.authTokenEnv]
    : undefined;
  const db = createClient({
    url: runtime.databaseUrl,
    ...(authToken ? { authToken } : {}),
  });
  try {
    return await readProductTruthOperationalLedger(db, runId);
  } finally {
    await db.close();
  }
}

function enrichmentProgress(input: {
  batchId: string;
  totalJobs: number;
  currentOrdinal: number | null;
  currentRunId: string | null;
  currentTitle: string | null;
  stage: ProductTruthWalmartEnrichmentStage;
  completedJobs: number;
  stoppedJobs: number;
  providerCalls: number;
  providerUnits: number;
  messageCode: string;
}): ProductTruthWalmartEnrichmentProgress {
  return parseProductTruthWalmartEnrichmentProgress({
    schemaVersion: PRODUCT_TRUTH_WALMART_ENRICHMENT_PROGRESS_VERSION,
    ...input,
    observedAt: new Date().toISOString(),
  });
}

async function sendEnrichmentProgress(input: {
  runtime: WorkerRuntime;
  claim: ProductTruthWebWorkerClaim & {
    spec: Extract<ProductTruthWebWorkerClaim["spec"], { kind: "EXECUTE" }>;
  };
  progress: ProductTruthWalmartEnrichmentProgress;
}): Promise<void> {
  await api(
    input.runtime,
    `/api/external/product-truth/control/${input.claim.command_id}/heartbeat`,
    {
      lease_token: input.claim.lease_token,
      progress: input.progress,
    },
  );
}

async function inspectCurrentEnrichmentStage(input: {
  runtime: WorkerRuntime;
  runId: string;
}): Promise<{
  stage: ProductTruthWalmartEnrichmentStage;
  messageCode: string;
  providerCalls: number;
  providerUnits: number;
}> {
  const authToken = input.runtime.authTokenEnv
    ? process.env[input.runtime.authTokenEnv]
    : undefined;
  const db = createClient({
    url: input.runtime.databaseUrl,
    ...(authToken ? { authToken } : {}),
  });
  try {
    const [jobResult, ledger] = await Promise.all([
      db.execute({
        sql: `SELECT status,checkpoint,terminalReason,error
              FROM "EnrichmentJob" WHERE runId=?
              ORDER BY createdAt DESC,id DESC LIMIT 1`,
        args: [input.runId],
      }),
      readProductTruthOperationalLedger(db, input.runId),
    ]);
    const job = jobResult.rows[0] as Record<string, unknown> | undefined;
    const status = typeof job?.status === "string" ? job.status : null;
    if (status === "done") {
      return {
        stage: "ITEM_COMPLETE",
        messageCode: "EXACT_PRODUCT_READY",
        providerCalls: ledger.totals.calls,
        providerUnits: ledger.totals.units,
      };
    }
    if (
      status !== null
      && ["error", "cancelled", "source_unavailable"].includes(status)
    ) {
      const reason = typeof job?.terminalReason === "string"
        ? job.terminalReason
        : typeof job?.error === "string"
          ? job.error
          : "PRODUCT_ENRICHMENT_STOPPED";
      return {
        stage: "STOPPED",
        messageCode: /^[A-Z0-9_]{1,120}$/u.test(reason)
          ? reason
          : "PRODUCT_ENRICHMENT_STOPPED",
        providerCalls: ledger.totals.calls,
        providerUnits: ledger.totals.units,
      };
    }
    let checkpointStage: string | null = null;
    if (typeof job?.checkpoint === "string") {
      try {
        const checkpoint = JSON.parse(job.checkpoint) as unknown;
        if (
          checkpoint
          && typeof checkpoint === "object"
          && !Array.isArray(checkpoint)
          && typeof (checkpoint as { stage?: unknown }).stage === "string"
        ) {
          checkpointStage = (checkpoint as { stage: string }).stage;
        }
      } catch {
        checkpointStage = null;
      }
    }
    const hasDetail = ledger.receipts.some(
      (receipt) => receipt.provider === "unwrangle"
        && receipt.operation === "detail",
    );
    const hasSearch = ledger.receipts.some(
      (receipt) => receipt.provider === "oxylabs"
        && receipt.operation === "query",
    );
    if (checkpointStage === "EXACT_CANDIDATE_RECONCILED" || hasDetail) {
      return {
        stage: "CATALOG_RECONCILIATION",
        messageCode: "VERIFYING_EXACT_PRODUCT_DATA",
        providerCalls: ledger.totals.calls,
        providerUnits: ledger.totals.units,
      };
    }
    if (checkpointStage === "SEARCH_PERSISTED" || hasSearch) {
      return {
        stage: "EXACT_PRODUCT_DETAIL",
        messageCode: "CHECKING_EXACT_PRODUCT_CONTENT",
        providerCalls: ledger.totals.calls,
        providerUnits: ledger.totals.units,
      };
    }
    return {
      stage: status === null ? "ITEM_START" : "EXACT_WALMART_SEARCH",
      messageCode: status === null
        ? "PREPARING_EXACT_PRODUCT"
        : "CHECKING_EXACT_WALMART_ITEM",
      providerCalls: ledger.totals.calls,
      providerUnits: ledger.totals.units,
    };
  } finally {
    await db.close();
  }
}

async function executeEnrichmentBatch(
  runtime: WorkerRuntime,
  claim: ProductTruthWebWorkerClaim & {
    spec: Extract<ProductTruthWebWorkerClaim["spec"], { kind: "EXECUTE" }>;
  },
): Promise<ProductTruthWalmartEnrichmentResult> {
  const quoteBytes = Buffer.from(
    claim.spec.quote_content_base64,
    "base64",
  );
  const quote = parseProductTruthWalmartEnrichmentQuote(
    JSON.parse(quoteBytes.toString("utf8")),
  );
  if (
    quote.batchId !== claim.spec.batch_id
    || sha256(quoteBytes) !== claim.spec.quote_sha256
    || quote.actions.jobs.length !== claim.spec.plans.length
  ) {
    fail("execute claim quote differs from its exact server seal");
  }
  const plans = claim.spec.plans.map((entry, index) => {
    const bytes = Buffer.from(entry.plan_content_base64, "base64");
    const plan = parseProductTruthTargetedWalmartEvidencePlan(
      JSON.parse(bytes.toString("utf8")),
    );
    const quoted = quote.actions.jobs[index]!;
    if (
      entry.run_id !== quoted.runId
      || entry.plan_sha256 !== quoted.planSha256
      || plan.runId !== entry.run_id
      || sha256(bytes) !== entry.plan_sha256
      || renderProductTruthOperationalJson(plan) !== bytes.toString("utf8")
    ) {
      fail(`execute plan ${index + 1} differs from the approved quote`);
    }
    return { plan, bytes, planSha256: entry.plan_sha256 };
  });
  const reserveFloor =
    plans[0]!.plan.providerCeilings.find(
      (ceiling) => ceiling.provider === "unwrangle",
    )?.reserveFloor;
  if (
    typeof reserveFloor !== "number"
    || plans.some(({ plan }) =>
      plan.providerCeilings.find(
        (ceiling) => ceiling.provider === "unwrangle",
      )?.reserveFloor !== reserveFloor)
  ) {
    fail("execute plans do not share one exact Unwrangle reserve floor");
  }
  let initialBalanceEvidence: BalanceEvidence | null = null;
  let currentBalance: BalanceEvidence | null = null;
  const jobs: ProductTruthWalmartEnrichmentResult["jobs"][number][] = [];
  let terminal:
    ProductTruthWalmartEnrichmentResult["status"] = "COMPLETED";
  let terminalReason = "ALL_EXACT_TARGETS_ENRICHED";
  await sendEnrichmentProgress({
    runtime,
    claim,
    progress: enrichmentProgress({
      batchId: quote.batchId,
      totalJobs: plans.length,
      currentOrdinal: null,
      currentRunId: null,
      currentTitle: null,
      stage: "BALANCE_CHECK",
      completedJobs: 0,
      stoppedJobs: 0,
      providerCalls: 0,
      providerUnits: 0,
      messageCode: "CHECKING_PROVIDER_BALANCE",
    }),
  });
  try {
    initialBalanceEvidence = await initialUnwrangleBalanceEvidence({
      runtime,
      claim,
      quoteId: quote.quoteId,
      quoteExpiresAt: quote.expiresAt,
      reserveFloor,
    });
    currentBalance = initialBalanceEvidence;
    if (currentBalance.balanceUnits - 2.5 < reserveFloor) {
      terminal = "BLOCKED";
      terminalReason = "UNWRANGLE_RESERVE_FLOOR_WOULD_BE_CROSSED";
    }
  } catch (error) {
    terminal = "FAILED";
    terminalReason =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "BALANCE_PROBE_FAILED";
  }
  const balanceLedgerAfterProbe = await readLedger(
    runtime,
    `${claim.spec.batch_id}-balance-probe`,
  );

  for (const [index, entry] of plans.entries()) {
    if (terminal !== "COMPLETED" || !currentBalance) {
      jobs.push({
        ordinal: index + 1,
        runId: entry.plan.runId,
        planSha256: entry.planSha256,
        status: "NOT_STARTED",
        reason: "BATCH_STOPPED_BEFORE_THIS_JOB",
        providerCalls: 0,
        providerUnits: 0,
        reportSha256: null,
        nextBalanceEvidence: null,
      });
      continue;
    }
    if (
      Date.now() - Date.parse(currentBalance.observedAt) > 10 * 60_000
      || currentBalance.balanceUnits - 2.5 < reserveFloor
    ) {
      terminal = "BLOCKED";
      terminalReason = "FRESH_BALANCE_EVIDENCE_REQUIRED_NO_EXTRA_PROBE_AUTHORIZED";
      jobs.push({
        ordinal: index + 1,
        runId: entry.plan.runId,
        planSha256: entry.planSha256,
        status: "NOT_STARTED",
        reason: terminalReason,
        providerCalls: 0,
        providerUnits: 0,
        reportSha256: null,
        nextBalanceEvidence: null,
      });
      continue;
    }
    await sendEnrichmentProgress({
      runtime,
      claim,
      progress: enrichmentProgress({
        batchId: quote.batchId,
        totalJobs: plans.length,
        currentOrdinal: index + 1,
        currentRunId: entry.plan.runId,
        currentTitle: quote.actions.jobs[index]!.title,
        stage: "ITEM_START",
        completedJobs: jobs.filter((job) => job.status === "COMPLETED").length,
        stoppedJobs: jobs.filter((job) => (
          job.status !== "COMPLETED" && job.status !== "NOT_STARTED"
        )).length,
        providerCalls:
          balanceLedgerAfterProbe.totals.calls
          + jobs.reduce((sum, job) => sum + job.providerCalls, 0),
        providerUnits:
          balanceLedgerAfterProbe.totals.units
          + jobs.reduce((sum, job) => sum + job.providerUnits, 0),
        messageCode: "PREPARING_EXACT_PRODUCT",
      }),
    });
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sscc-product-truth-execute-")),
    );
    let reportSha256: string | null = null;
    let nextBalanceEvidence: BalanceEvidence | null = null;
    let status:
      ProductTruthWalmartEnrichmentResult["jobs"][number]["status"] = "FAILED";
    let reason = "TARGETED_EXECUTION_FAILED";
    let detailCalled = false;
    try {
      const planPath = join(root, "plan.json");
      const planShaPath = join(root, "plan.sha256");
      const approvalPath = join(root, "approval.json");
      const outputDirectory = join(root, "output");
      const approved = approvalForPlan({
        plan: entry.plan,
        planSha256: entry.planSha256,
        quoteId: quote.quoteId,
        balanceEvidence: currentBalance,
      });
      await writeFile(planPath, entry.bytes, { flag: "wx", mode: 0o600 });
      await writeFile(
        planShaPath,
        `${entry.planSha256}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(
        approvalPath,
        renderProductTruthOperationalJson(approved.approval),
        { flag: "wx", mode: 0o600 },
      );
      const execution = await spawnRunner({
        args: [
          "--import",
          "tsx",
          RUNNER_PATH,
          "execute",
          ...commonDatabaseArgs(runtime),
          "--plan",
          planPath,
          "--plan-sha",
          planShaPath,
          "--approval",
          approvalPath,
          "--confirm",
          approved.confirmation,
          "--out",
          outputDirectory,
        ],
        heartbeat: async () => {
          const current = await inspectCurrentEnrichmentStage({
            runtime,
            runId: entry.plan.runId,
          });
          await sendEnrichmentProgress({
            runtime,
            claim,
            progress: enrichmentProgress({
              batchId: quote.batchId,
              totalJobs: plans.length,
              currentOrdinal: index + 1,
              currentRunId: entry.plan.runId,
              currentTitle: quote.actions.jobs[index]!.title,
              stage: current.stage,
              completedJobs: jobs.filter(
                (job) => job.status === "COMPLETED",
              ).length,
              stoppedJobs: jobs.filter((job) => (
                job.status !== "COMPLETED" && job.status !== "NOT_STARTED"
              )).length,
              providerCalls:
                balanceLedgerAfterProbe.totals.calls
                + jobs.reduce((sum, job) => sum + job.providerCalls, 0)
                + current.providerCalls,
              providerUnits:
                balanceLedgerAfterProbe.totals.units
                + jobs.reduce((sum, job) => sum + job.providerUnits, 0)
                + current.providerUnits,
              messageCode: current.messageCode,
            }),
          });
        },
      });
      const reportBytes = await readFile(join(outputDirectory, "report.json"))
        .catch(() => null);
      if (reportBytes) {
        reportSha256 = sha256(reportBytes);
        const report = JSON.parse(reportBytes.toString("utf8")) as {
          outcome?: string;
          reason?: string;
          nextBalanceEvidence?: BalanceEvidence | null;
        };
        reason =
          typeof report.reason === "string"
            ? report.reason.slice(0, 500)
            : `TARGETED_RUN_EXIT_${execution.exitCode}`;
        status =
          report.outcome === "COMPLETED"
            ? "COMPLETED"
            : report.outcome === "AMBIGUOUS"
              ? "AMBIGUOUS"
              : report.outcome === "BLOCKED"
                ? "BLOCKED"
                : "FAILED";
        nextBalanceEvidence = report.nextBalanceEvidence ?? null;
      } else {
        reason = execution.stderr.toString("utf8").trim().slice(0, 500)
          || `TARGETED_RUN_EXIT_${execution.exitCode}`;
      }
    } catch (error) {
      reason =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "TARGETED_EXECUTION_FAILED";
    } finally {
      const ledger = await readLedger(runtime, entry.plan.runId);
      detailCalled = ledger.receipts.some(
        (receipt) => receipt.provider === "unwrangle"
          && receipt.operation === "detail",
      );
      jobs.push({
        ordinal: index + 1,
        runId: entry.plan.runId,
        planSha256: entry.planSha256,
        status,
        reason,
        providerCalls: ledger.totals.calls,
        providerUnits: ledger.totals.units,
        reportSha256,
        nextBalanceEvidence,
      });
      await rm(root, { recursive: true, force: true });
    }
    const recorded = jobs.at(-1)!;
    await sendEnrichmentProgress({
      runtime,
      claim,
      progress: enrichmentProgress({
        batchId: quote.batchId,
        totalJobs: plans.length,
        currentOrdinal: index + 1,
        currentRunId: entry.plan.runId,
        currentTitle: quote.actions.jobs[index]!.title,
        stage: recorded.status === "COMPLETED" ? "ITEM_COMPLETE" : "STOPPED",
        completedJobs: jobs.filter((job) => job.status === "COMPLETED").length,
        stoppedJobs: jobs.filter((job) => (
          job.status !== "COMPLETED" && job.status !== "NOT_STARTED"
        )).length,
        providerCalls:
          balanceLedgerAfterProbe.totals.calls
          + jobs.reduce((sum, job) => sum + job.providerCalls, 0),
        providerUnits:
          balanceLedgerAfterProbe.totals.units
          + jobs.reduce((sum, job) => sum + job.providerUnits, 0),
        messageCode: recorded.status === "COMPLETED"
          ? "EXACT_PRODUCT_READY"
          : /^[A-Z0-9_]{1,120}$/u.test(recorded.reason)
            ? recorded.reason
            : "PRODUCT_ENRICHMENT_STOPPED",
      }),
    });
    if (status !== "COMPLETED") {
      terminal = status === "AMBIGUOUS" ? "AMBIGUOUS" : "BLOCKED";
      terminalReason = reason;
    } else if (nextBalanceEvidence) {
      currentBalance = nextBalanceEvidence;
    } else if (!detailCalled) {
      // A fresh exact Walmart price can complete against already verified
      // exact-variant content without spending a detail credit. The current
      // Unwrangle balance observation therefore remains the correct evidence
      // for the next sequential product while it is still fresh.
    } else if (index < plans.length - 1) {
      terminal = "BLOCKED";
      terminalReason =
        "DETAIL_RESPONSE_OMITTED_BALANCE_EVIDENCE_NO_EXTRA_PROBE_AUTHORIZED";
      currentBalance = null;
    }
  }
  const balanceLedger = await readLedger(
    runtime,
    `${claim.spec.batch_id}-balance-probe`,
  );
  const result: ProductTruthWalmartEnrichmentResult = {
    schemaVersion: PRODUCT_TRUTH_WALMART_ENRICHMENT_RESULT_VERSION,
    commandId: claim.command_id,
    batchId: quote.batchId,
    quoteSha256: claim.spec.quote_sha256,
    status: terminal,
    reason: terminalReason,
    generatedAt: new Date().toISOString(),
    providerCalls:
      balanceLedger.totals.calls
      + jobs.reduce((sum, job) => sum + job.providerCalls, 0),
    providerUnits:
      balanceLedger.totals.units
      + jobs.reduce((sum, job) => sum + job.providerUnits, 0),
    marketplaceMutations: 0,
    initialBalanceEvidence,
    jobs,
    claims: {
      concurrency: 1,
      maxAttemptsPerJob: 1,
      automaticReplay: false,
      oneInitialBalanceProbeMaximum: true,
      marketplaceMutations: 0,
    },
  };
  const firstStopped = result.jobs.find((job) => (
    job.status !== "COMPLETED" && job.status !== "NOT_STARTED"
  ));
  const firstStoppedAction = firstStopped
    ? quote.actions.jobs[firstStopped.ordinal - 1]!
    : null;
  await sendEnrichmentProgress({
    runtime,
    claim,
    progress: enrichmentProgress({
      batchId: quote.batchId,
      totalJobs: plans.length,
      currentOrdinal: firstStopped?.ordinal ?? null,
      currentRunId: firstStopped?.runId ?? null,
      currentTitle: firstStoppedAction?.title ?? null,
      stage: result.status === "COMPLETED" ? "BATCH_COMPLETE" : "STOPPED",
      completedJobs: result.jobs.filter(
        (job) => job.status === "COMPLETED",
      ).length,
      stoppedJobs: result.jobs.filter((job) => (
        job.status !== "COMPLETED" && job.status !== "NOT_STARTED"
      )).length,
      providerCalls: result.providerCalls,
      providerUnits: result.providerUnits,
      messageCode: result.status === "COMPLETED"
        ? "ALL_EXACT_TARGETS_ENRICHED"
        : /^[A-Z0-9_]{1,120}$/u.test(result.reason)
          ? result.reason
          : "BATCH_ENRICHMENT_STOPPED",
    }),
  });
  return assertProductTruthWalmartEnrichmentResult({
    result,
    quote,
    commandId: claim.command_id,
  });
}

async function executeClaim(
  runtime: WorkerRuntime,
  claim: ProductTruthWebWorkerClaim,
): Promise<void> {
  verifyClaimPins(runtime, claim);
  const lease = new ProductTruthWorkerLease(claim.lease_expires_at);
  await leaseBoundApi(
    runtime,
    lease,
    `/api/external/product-truth/control/${claim.command_id}/start`,
    { lease_token: claim.lease_token },
  );
  if (claim.spec.kind === "EXECUTE") {
    const result = await executeEnrichmentBatch(
      runtime,
      claim as ProductTruthWebWorkerClaim & {
        spec: Extract<
          ProductTruthWebWorkerClaim["spec"],
          { kind: "EXECUTE" }
        >;
      },
    );
    await completeClaim(runtime, claim, result);
    return;
  }
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sscc-product-truth-worker-")),
  );
  try {
    const command = await runnerArgs(runtime, claim, root);
    const execution = await spawnRunner({
      args: command.args,
      lease,
      heartbeat: async () => {
        await heartbeatLeaseBoundApi(
          runtime,
          lease,
          `/api/external/product-truth/control/${claim.command_id}/heartbeat`,
          { lease_token: claim.lease_token },
        );
      },
    });
    const result = parseProductTruthWorkerResult({
      schemaVersion: PRODUCT_TRUTH_WORKER_RESULT_VERSION,
      commandId: claim.command_id,
      commandKind: claim.command_kind,
      exitCode: execution.exitCode,
      files: await resultFiles({
        commandKind: claim.command_kind,
        exitCode: execution.exitCode,
        outputDirectory: command.outputDirectory,
        stdout: execution.stdout,
        stderr: execution.stderr,
      }),
      claims: {
        shell: false,
        providerCalls: 0,
        marketplaceMutations: 0,
      },
    });
    // Terminal acknowledgement retries the exact same immutable result bytes
    // (completeClaim), independently of lease freshness: the server-side
    // completion is idempotent, and losing this write is what left EXECUTE
    // commands stuck in RUNNING on 2026-08-02.
    await completeClaim(runtime, claim, result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const runtime = runtimeFromEnv();
  await verifyPinnedCheckout(runtime);
  for (;;) {
    let response: Record<string, unknown>;
    try {
      response = await api(
        runtime,
        "/api/external/product-truth/control/claim",
        { worker_id: runtime.workerId },
      );
    } catch (error) {
      if (!retryableControlError(error) || runtime.once) throw error;
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, POLL_MS);
      });
      continue;
    }
    const claim = parseClaim(response.claim);
    if (claim) await executeClaim(runtime, claim);
    if (runtime.once) return;
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, claim ? 250 : POLL_MS);
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
