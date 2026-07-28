#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
    (claim.command_kind !== "DOCTOR" && claim.command_kind !== "RUN_PLAN")
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
