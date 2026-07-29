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
  PRODUCT_TRUTH_WALMART_ENRICHMENT_RESULT_VERSION,
  assertProductTruthWalmartEnrichmentResult,
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
const HEARTBEAT_MS = 30_000;
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
    const code =
      value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && "code" in value
      && typeof value.code === "string"
        ? ` (${value.code})`
        : "";
    fail(`control API ${path} returned HTTP ${response.status}${code}`);
  }
  return value as Record<string, unknown>;
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
}): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [...input.args], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectPromise);
    let heartbeatInFlight: Promise<void> | null = null;
    let heartbeatError: unknown;
    const timer = setInterval(() => {
      if (heartbeatInFlight !== null) return;
      heartbeatInFlight = input
        .heartbeat()
        .catch((error: unknown) => {
          heartbeatError = error;
          child.kill("SIGTERM");
        })
        .finally(() => {
          heartbeatInFlight = null;
        });
    }, HEARTBEAT_MS);
    child.on("close", async (code) => {
      clearInterval(timer);
      const pendingHeartbeat = heartbeatInFlight;
      if (pendingHeartbeat !== null) await pendingHeartbeat;
      if (heartbeatError !== undefined) {
        rejectPromise(heartbeatError);
        return;
      }
      resolvePromise({
        exitCode: typeof code === "number" && code >= 0 ? code : 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
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
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sscc-product-truth-execute-")),
    );
    let reportSha256: string | null = null;
    let nextBalanceEvidence: BalanceEvidence | null = null;
    let status:
      ProductTruthWalmartEnrichmentResult["jobs"][number]["status"] = "FAILED";
    let reason = "TARGETED_EXECUTION_FAILED";
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
          await api(
            runtime,
            `/api/external/product-truth/control/${claim.command_id}/heartbeat`,
            { lease_token: claim.lease_token },
          );
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
    if (status !== "COMPLETED") {
      terminal = status === "AMBIGUOUS" ? "AMBIGUOUS" : "BLOCKED";
      terminalReason = reason;
    } else if (nextBalanceEvidence) {
      currentBalance = nextBalanceEvidence;
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
  await api(
    runtime,
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
    await api(
      runtime,
      `/api/external/product-truth/control/${claim.command_id}/complete`,
      {
        lease_token: claim.lease_token,
        result,
      },
    );
    return;
  }
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sscc-product-truth-worker-")),
  );
  try {
    const command = await runnerArgs(runtime, claim, root);
    const execution = await spawnRunner({
      args: command.args,
      heartbeat: async () => {
        await api(
          runtime,
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
    await api(
      runtime,
      `/api/external/product-truth/control/${claim.command_id}/complete`,
      {
        lease_token: claim.lease_token,
        result,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const runtime = runtimeFromEnv();
  await verifyPinnedCheckout(runtime);
  for (;;) {
    const response = await api(
      runtime,
      "/api/external/product-truth/control/claim",
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
