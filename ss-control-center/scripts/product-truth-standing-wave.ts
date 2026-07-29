import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";

import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";
import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
import {
  PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256,
  validateProductTruthStandingProviderPolicy,
} from "../src/lib/sourcing/product-truth-standing-provider-authority";
import {
  parseProductTruthStandingWavePlan,
  productTruthStandingWavePlanSha256,
  rankProductTruthStandingWaveCandidates,
  renderProductTruthStandingWavePlan,
  sealProductTruthStandingWavePlan,
  type ProductTruthStandingWaveCandidate,
  type ProductTruthStandingWavePlan,
} from "../src/lib/sourcing/product-truth-standing-wave";

const WAVE_INDEX_VERSION =
  "product-truth-standing-wave-artifact-index/1.0.0" as const;
const WAVE_REPORT_VERSION =
  "product-truth-standing-wave-report/1.0.0" as const;
const TARGET_EXECUTION_MAX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const COGS_PLAN_LIFETIME_MS = 10 * 60 * 1_000;
const COGS_LISTING_CHUNK = 33;

type Command = "plan" | "execute" | "resume" | "status";

interface CommonOptions {
  command: Command;
  url: string;
  allowRemote: boolean;
  authTokenEnv: string | null;
  manifestPath: string;
  manifestSha256: string;
  standingProviderPolicyPath: string;
  standingProviderPolicySha256: string;
  standingNoPaidPolicyPath: string;
  standingNoPaidPolicySha256: string;
}

interface PlanOptions extends CommonOptions {
  command: "plan";
  waveId: string;
  createdAt: string;
  expiresAt: string;
  maxTargets: number;
  outDir: string;
}

export interface ProductTruthStandingWaveRunOptions extends CommonOptions {
  command: "execute" | "resume";
  planPath: string;
  planSha256: string;
  workDir: string;
}

interface StatusOptions {
  command: "status";
  workDir: string;
}

type Options =
  | PlanOptions
  | ProductTruthStandingWaveRunOptions
  | StatusOptions;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProductTruthStandingWaveCommandExecutor = (
  argv: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

class ProductTruthStandingWaveCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthStandingWaveCliError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthStandingWaveCliError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function usage(): string {
  return [
    "Product Truth standing wave orchestrator (one target at a time, no retry)",
    "",
    "Commands:",
    "  plan --wave-id ID --created-at ISO --expires-at ISO --max-targets 1..5",
    "       --manifest ABS_PATH --manifest-sha256 SHA",
    "       --standing-provider-policy ABS_PATH --standing-provider-policy-sha256 SHA",
    "       --standing-no-paid-policy ABS_PATH --standing-no-paid-policy-sha256 SHA",
    "       --url URL [--allow-remote --auth-token-env ENV] --out ABS_NEW_DIR",
    "",
    "  execute|resume --plan ABS_PATH --plan-sha256 SHA --work-dir ABS_PATH",
    "       --manifest ABS_PATH --manifest-sha256 SHA",
    "       --standing-provider-policy ABS_PATH --standing-provider-policy-sha256 SHA",
    "       --standing-no-paid-policy ABS_PATH --standing-no-paid-policy-sha256 SHA",
    "       --url URL [--allow-remote --auth-token-env ENV]",
    "",
    "  status --work-dir ABS_PATH",
    "",
    "execute requires a new work directory; resume requires the same existing",
    "directory. A partial provider stage is terminal ambiguous and is never replayed.",
  ].join("\n");
}

function parseFlags(argv: readonly string[]): {
  command: Command;
  values: Map<string, string>;
  booleans: Set<string>;
} {
  const command = argv[0];
  if (
    command !== "plan"
    && command !== "execute"
    && command !== "resume"
    && command !== "status"
  ) {
    fail("STANDING_WAVE_COMMAND_UNKNOWN", "expected plan, execute, resume, or status");
  }
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const allowedBooleans = new Set(["--allow-remote"]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) {
      fail("STANDING_WAVE_ARGUMENT_INVALID", `unexpected argument ${flag}`);
    }
    if (allowedBooleans.has(flag)) {
      if (booleans.has(flag)) {
        fail("STANDING_WAVE_ARGUMENT_DUPLICATE", `${flag} was repeated`);
      }
      booleans.add(flag);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("STANDING_WAVE_ARGUMENT_INVALID", `${flag} requires a value`);
    }
    if (values.has(flag)) {
      fail("STANDING_WAVE_ARGUMENT_DUPLICATE", `${flag} was repeated`);
    }
    values.set(flag, value);
    index += 1;
  }
  return { command, values, booleans };
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) fail("STANDING_WAVE_ARGUMENT_REQUIRED", `${flag} is required`);
  return value;
}

function exactPath(value: string, flag: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    fail("STANDING_WAVE_PATH_INVALID", `${flag} must be an absolute normalized path`);
  }
  return value;
}

function exactSha256(value: string, flag: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    fail("STANDING_WAVE_ARGUMENT_INVALID", `${flag} must be lowercase SHA-256`);
  }
  return value;
}

function exactToken(value: string, flag: string): string {
  if (
    value.length < 1
    || value.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  ) {
    fail("STANDING_WAVE_ARGUMENT_INVALID", `${flag} must be a safe token`);
  }
  return value;
}

function exactInstant(value: string, flag: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("STANDING_WAVE_ARGUMENT_INVALID", `${flag} must be canonical UTC`);
  }
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  const { command, values, booleans } = parseFlags(argv);
  if (command === "status") {
    const allowed = new Set(["--work-dir"]);
    if ([...values.keys()].some((flag) => !allowed.has(flag)) || booleans.size) {
      fail("STANDING_WAVE_ARGUMENT_INVALID", "status received unsupported flags");
    }
    return {
      command,
      workDir: exactPath(required(values, "--work-dir"), "--work-dir"),
    };
  }
  const commonAllowed = [
    "--url",
    "--auth-token-env",
    "--manifest",
    "--manifest-sha256",
    "--standing-provider-policy",
    "--standing-provider-policy-sha256",
    "--standing-no-paid-policy",
    "--standing-no-paid-policy-sha256",
  ];
  const commandAllowed =
    command === "plan"
      ? [
          "--wave-id",
          "--created-at",
          "--expires-at",
          "--max-targets",
          "--out",
        ]
      : ["--plan", "--plan-sha256", "--work-dir"];
  const allowed = new Set([...commonAllowed, ...commandAllowed]);
  const unknown = [...values.keys()].find((flag) => !allowed.has(flag));
  if (unknown) {
    fail("STANDING_WAVE_ARGUMENT_INVALID", `unsupported flag ${unknown}`);
  }
  const common: CommonOptions = {
    command,
    url: required(values, "--url"),
    allowRemote: booleans.has("--allow-remote"),
    authTokenEnv: values.get("--auth-token-env") ?? null,
    manifestPath: exactPath(required(values, "--manifest"), "--manifest"),
    manifestSha256: exactSha256(
      required(values, "--manifest-sha256"),
      "--manifest-sha256",
    ),
    standingProviderPolicyPath: exactPath(
      required(values, "--standing-provider-policy"),
      "--standing-provider-policy",
    ),
    standingProviderPolicySha256: exactSha256(
      required(values, "--standing-provider-policy-sha256"),
      "--standing-provider-policy-sha256",
    ),
    standingNoPaidPolicyPath: exactPath(
      required(values, "--standing-no-paid-policy"),
      "--standing-no-paid-policy",
    ),
    standingNoPaidPolicySha256: exactSha256(
      required(values, "--standing-no-paid-policy-sha256"),
      "--standing-no-paid-policy-sha256",
    ),
  };
  if (command === "plan") {
    const maxTargets = Number(required(values, "--max-targets"));
    if (!Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > 5) {
      fail("STANDING_WAVE_ARGUMENT_INVALID", "--max-targets must be 1-5");
    }
    return {
      ...common,
      command,
      waveId: exactToken(required(values, "--wave-id"), "--wave-id"),
      createdAt: exactInstant(required(values, "--created-at"), "--created-at"),
      expiresAt: exactInstant(required(values, "--expires-at"), "--expires-at"),
      maxTargets,
      outDir: exactPath(required(values, "--out"), "--out"),
    };
  }
  return {
    ...common,
    command,
    planPath: exactPath(required(values, "--plan"), "--plan"),
    planSha256: exactSha256(
      required(values, "--plan-sha256"),
      "--plan-sha256",
    ),
    workDir: exactPath(required(values, "--work-dir"), "--work-dir"),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readExactFile(path: string, label: string): Promise<string> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    fail("STANDING_WAVE_FILE_MISSING", `${label} is missing`, error);
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail("STANDING_WAVE_FILE_INVALID", `${label} must be a regular non-symlink file`);
  }
  const text = await readFile(path, "utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.startsWith("\uFEFF")) {
    fail("STANDING_WAVE_FILE_INVALID", `${label} must use canonical UTF-8/LF bytes`);
  }
  return text;
}

async function writeNew(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function createNewDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: false, mode: 0o700 });
  } catch (error) {
    fail("STANDING_WAVE_OUTPUT_EXISTS", `output directory is not new: ${path}`, error);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

async function validateArtifactDirectory(input: {
  path: string;
  requiredFiles: readonly string[];
  label: string;
}): Promise<"ABSENT" | "COMPLETE"> {
  if (!(await isDirectory(input.path))) return "ABSENT";
  for (const file of input.requiredFiles) {
    const path = join(input.path, file);
    let entry;
    try {
      entry = await lstat(path);
    } catch {
      fail(
        "STANDING_WAVE_STAGE_AMBIGUOUS",
        `${input.label} directory exists without complete sealed artifacts`,
      );
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(
        "STANDING_WAVE_STAGE_AMBIGUOUS",
        `${input.label} contains an unsafe artifact`,
      );
    }
  }
  return "COMPLETE";
}

async function validateOptionalArtifactSet(input: {
  root: string;
  requiredFiles: readonly string[];
  label: string;
}): Promise<"ABSENT" | "COMPLETE"> {
  if (!(await isDirectory(input.root))) return "ABSENT";
  const present: boolean[] = [];
  for (const file of input.requiredFiles) {
    try {
      const entry = await lstat(join(input.root, file));
      present.push(entry.isFile() && !entry.isSymbolicLink());
    } catch {
      present.push(false);
    }
  }
  if (present.every((value) => value === false)) return "ABSENT";
  if (present.every((value) => value === true)) return "COMPLETE";
  fail(
    "STANDING_WAVE_STAGE_AMBIGUOUS",
    `${input.label} artifacts are partial`,
  );
}

function authArgs(options: CommonOptions): string[] {
  return options.authTokenEnv
    ? ["--allow-remote", "--auth-token-env", options.authTokenEnv]
    : [];
}

function openDatabase(options: CommonOptions) {
  const target = resolveProductTruthDatabaseTarget(options.url, process.cwd());
  if (target.kind === "remote" && !options.allowRemote) {
    fail("STANDING_WAVE_REMOTE_REQUIRES_FLAG", "pass --allow-remote");
  }
  if (target.kind === "local" && options.authTokenEnv) {
    fail("STANDING_WAVE_LOCAL_AUTH_FORBIDDEN", "local DB cannot use an auth token");
  }
  const authToken = options.authTokenEnv
    ? process.env[options.authTokenEnv]?.trim()
    : undefined;
  if (target.kind === "remote" && (!options.authTokenEnv || !authToken)) {
    fail(
      "STANDING_WAVE_REMOTE_AUTH_REQUIRED",
      "--auth-token-env must name a populated variable",
    );
  }
  return {
    target,
    db: createClient({
      url: target.clientUrl,
      ...(authToken ? { authToken } : {}),
    }),
  };
}

async function validateBoundInputs(options: CommonOptions): Promise<{
  manifestJson: string;
  providerPolicyJson: string;
  noPaidPolicyJson: string;
}> {
  const [manifestJson, providerPolicyJson, noPaidPolicyJson] = await Promise.all([
    readExactFile(options.manifestPath, "Phase 1 manifest"),
    readExactFile(options.standingProviderPolicyPath, "standing provider policy"),
    readExactFile(options.standingNoPaidPolicyPath, "standing no-paid policy"),
  ]);
  if (sha256(manifestJson) !== options.manifestSha256) {
    fail("STANDING_WAVE_MANIFEST_SHA_MISMATCH", "manifest bytes differ");
  }
  if (
    options.standingProviderPolicySha256
      !== PRODUCT_TRUTH_STANDING_PROVIDER_POLICY_SHA256
    || sha256(providerPolicyJson) !== options.standingProviderPolicySha256
  ) {
    fail(
      "STANDING_WAVE_PROVIDER_POLICY_SHA_MISMATCH",
      "provider policy is not the pinned standing policy",
    );
  }
  if (sha256(noPaidPolicyJson) !== options.standingNoPaidPolicySha256) {
    fail("STANDING_WAVE_NO_PAID_POLICY_SHA_MISMATCH", "no-paid policy bytes differ");
  }
  let providerPolicy: unknown;
  try {
    providerPolicy = JSON.parse(providerPolicyJson);
  } catch (error) {
    fail("STANDING_WAVE_PROVIDER_POLICY_INVALID", "provider policy is not JSON", error);
  }
  validateProductTruthStandingProviderPolicy({
    policy: providerPolicy,
    policyJson: providerPolicyJson,
    policySha256: options.standingProviderPolicySha256,
  });
  return { manifestJson, providerPolicyJson, noPaidPolicyJson };
}

async function defaultExecutor(
  argv: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 255,
        stdout,
        stderr,
      });
    });
  });
}

function childFailureCode(result: CommandResult): string | null {
  for (const output of [result.stderr, result.stdout]) {
    const trimmed = output.trim();
    if (!trimmed || trimmed.length > 64 * 1024) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed !== null
        && typeof parsed === "object"
        && "error" in parsed
        && parsed.error !== null
        && typeof parsed.error === "object"
        && "code" in parsed.error
        && typeof parsed.error.code === "string"
        && /^[A-Z][A-Z0-9_]{2,100}$/u.test(parsed.error.code)
      ) {
        return parsed.error.code;
      }
    } catch {
      // Child output is not required to be JSON. Never echo arbitrary output.
    }
  }
  return null;
}

async function runSealedStage(input: {
  stagePath: string;
  requiredFiles: readonly string[];
  label: string;
  argv: readonly string[];
  cwd: string;
  executor: ProductTruthStandingWaveCommandExecutor;
  allowExisting: boolean;
  allowedExitCodes?: readonly number[];
}): Promise<"EXECUTED" | "REUSED"> {
  const state = await validateArtifactDirectory({
    path: input.stagePath,
    requiredFiles: input.requiredFiles,
    label: input.label,
  });
  if (state === "COMPLETE") {
    if (!input.allowExisting) {
      fail(
        "STANDING_WAVE_EXECUTE_REQUIRES_NEW_ROOT",
        `${input.label} already exists; use resume`,
      );
    }
    return "REUSED";
  }
  const result = await input.executor(input.argv, input.cwd);
  const completed = await validateArtifactDirectory({
    path: input.stagePath,
    requiredFiles: input.requiredFiles,
    label: input.label,
  });
  if (completed !== "COMPLETE") {
    const failureCode = childFailureCode(result);
    fail(
      "STANDING_WAVE_STAGE_AMBIGUOUS",
      `${input.label} exited ${result.exitCode}`
        + `${failureCode ? ` (${failureCode})` : ""}`
        + " without complete artifacts",
    );
  }
  if (!(input.allowedExitCodes ?? [0]).includes(result.exitCode)) {
    fail(
      "STANDING_WAVE_STAGE_FAILED",
      `${input.label} exited ${result.exitCode} after writing artifacts`,
    );
  }
  return "EXECUTED";
}

export function assertProductTruthStandingWaveProviderEnvironment(
  environment: Record<string, string | undefined>,
): void {
  const required = [
    "UNWRANGLE_API_KEY",
    "OXYLABS_USERNAME",
    "OXYLABS_PASSWORD",
  ] as const;
  const missing = required.filter((name) => {
    const raw = environment[name]?.trim() ?? "";
    return raw.replace(/^['"]|['"]$/gu, "").length === 0;
  });
  if (missing.length > 0) {
    fail(
      "STANDING_WAVE_PROVIDER_CREDENTIALS_MISSING",
      `${missing.join(", ")} must be present before the wave boundary;`
        + " no provider call was made",
    );
  }
}

async function exactDigest(path: string, label: string): Promise<string> {
  const text = await readExactFile(path, label);
  const digest = text.trim();
  return exactSha256(digest, label);
}

function targetDirectoryName(
  target: ProductTruthStandingWaveCandidate,
  ordinal: number,
): string {
  return `${String(ordinal + 1).padStart(2, "0")}-${sha256(
    target.donorProductId,
  ).slice(0, 16)}`;
}

function targetExpiry(plan: ProductTruthStandingWavePlan, now: Date): string {
  const expiresAt = Math.min(
    Date.parse(plan.expiresAt),
    now.getTime() + TARGET_EXECUTION_MAX_LIFETIME_MS,
  );
  if (expiresAt <= now.getTime()) {
    fail("STANDING_WAVE_EXPIRED", "wave expired before the next target");
  }
  return new Date(expiresAt).toISOString();
}

function cogsExpiry(plan: ProductTruthStandingWavePlan, now: Date): string {
  const expiresAt = Math.min(
    Date.parse(plan.expiresAt),
    now.getTime() + COGS_PLAN_LIFETIME_MS,
  );
  if (expiresAt <= now.getTime()) {
    fail("STANDING_WAVE_EXPIRED", "wave expired before COGS materialization");
  }
  return new Date(expiresAt).toISOString();
}

function readCheckpointPriceObservation(report: unknown): string | null {
  if (
    typeof report !== "object"
    || report === null
    || !("job" in report)
    || typeof report.job !== "object"
    || report.job === null
    || !("checkpoint" in report.job)
    || typeof report.job.checkpoint !== "object"
    || report.job.checkpoint === null
    || !("priceObservationId" in report.job.checkpoint)
  ) {
    return null;
  }
  const value = report.job.checkpoint.priceObservationId;
  return typeof value === "string" && value ? value : null;
}

function readTerminalOutcome(report: unknown): {
  outcome: string;
  reason: string;
  actualWorkingProviderUnits: number;
} {
  if (
    typeof report !== "object"
    || report === null
    || !("outcome" in report)
    || typeof report.outcome !== "string"
    || !("reason" in report)
    || typeof report.reason !== "string"
  ) {
    fail("STANDING_WAVE_EXECUTION_REPORT_INVALID", "execution report is incomplete");
  }
  let units = 0;
  if (
    "ledger" in report
    && typeof report.ledger === "object"
    && report.ledger !== null
    && "totals" in report.ledger
    && typeof report.ledger.totals === "object"
    && report.ledger.totals !== null
    && "units" in report.ledger.totals
    && typeof report.ledger.totals.units === "number"
    && Number.isFinite(report.ledger.totals.units)
  ) {
    units = report.ledger.totals.units;
  }
  return {
    outcome: report.outcome,
    reason: report.reason,
    actualWorkingProviderUnits: units,
  };
}

export function assertProductTruthStandingWaveExecuteArgv(input: {
  argv: unknown;
  cwd: string;
  planPath: string;
  planShaPath: string;
  approvalPath: string;
  executionPath: string;
  url: string;
  authTokenEnv: string | null;
}): readonly string[] {
  if (!Array.isArray(input.argv) || input.argv.some((entry) => typeof entry !== "string")) {
    fail("STANDING_WAVE_NEXT_ARGV_INVALID", "authorization next_argv is invalid");
  }
  const argv = input.argv as string[];
  const confirmationIndex = argv.indexOf("--confirm");
  if (
    confirmationIndex < 0
    || typeof argv[confirmationIndex + 1] !== "string"
    || !argv[confirmationIndex + 1].startsWith("EXECUTE_PRODUCT_TRUTH_PLAN_V1:")
  ) {
    fail("STANDING_WAVE_NEXT_ARGV_INVALID", "execution confirmation is absent");
  }
  const expected = [
    "npm",
    "run",
    "product-truth",
    "--",
    "execute",
    "--plan",
    input.planPath,
    "--plan-sha",
    input.planShaPath,
    "--approval",
    input.approvalPath,
    "--confirm",
    argv[confirmationIndex + 1],
    "--url",
    input.url,
    ...(input.authTokenEnv
      ? ["--allow-remote", "--auth-token-env", input.authTokenEnv]
      : []),
    "--out",
    input.executionPath,
  ];
  if (
    argv.length !== expected.length
    || argv.some((entry, index) => entry !== expected[index])
    || !isAbsolute(input.cwd)
  ) {
    fail(
      "STANDING_WAVE_NEXT_ARGV_INVALID",
      "authorization next_argv differs from the exact allowlisted execute command",
    );
  }
  return argv;
}

async function runCogsForTarget(input: {
  options: ProductTruthStandingWaveRunOptions;
  plan: ProductTruthStandingWavePlan;
  target: ProductTruthStandingWaveCandidate;
  targetRoot: string;
  cwd: string;
  executor: ProductTruthStandingWaveCommandExecutor;
  allowExisting: boolean;
}): Promise<readonly string[]> {
  const appliedReports: string[] = [];
  const chunks: string[][] = [];
  for (
    let offset = 0;
    offset < input.target.linkedListingKeys.length;
    offset += COGS_LISTING_CHUNK
  ) {
    chunks.push(
      input.target.linkedListingKeys.slice(offset, offset + COGS_LISTING_CHUNK),
    );
  }
  for (const [index, listingKeys] of chunks.entries()) {
    const prefix = `cogs-${String(index + 1).padStart(2, "0")}`;
    const planDir = join(input.targetRoot, `${prefix}-plan`);
    const preflightDir = join(input.targetRoot, `${prefix}-preflight`);
    const applyDir = join(input.targetRoot, `${prefix}-apply`);
    const createdAt = new Date();
    const expiresAt = cogsExpiry(input.plan, createdAt);
    await runSealedStage({
      stagePath: planDir,
      requiredFiles: [
        "reconcile-plan.json",
        "reconcile-plan.sha256",
        "artifact-index.json",
        "artifact-index.sha256",
      ],
      label: `${prefix} plan`,
      argv: [
        "npm",
        "run",
        "product-truth:canonical-cogs-reconcile",
        "--",
        "plan",
        "--url",
        input.options.url,
        ...authArgs(input.options),
        "--manifest-sha256",
        input.plan.manifestSha256,
        ...listingKeys.flatMap((listingKey) => ["--listing-key", listingKey]),
        "--created-at",
        createdAt.toISOString(),
        "--expires-at",
        expiresAt,
        "--out",
        planDir,
      ],
      cwd: input.cwd,
      executor: input.executor,
      allowExisting: input.allowExisting,
    });
    const reconcilePlanSha = await exactDigest(
      join(planDir, "reconcile-plan.sha256"),
      `${prefix} plan SHA`,
    );
    const checkedAt = new Date().toISOString();
    await runSealedStage({
      stagePath: preflightDir,
      requiredFiles: [
        "preflight-report.json",
        "preflight-report.sha256",
        "artifact-index.json",
        "artifact-index.sha256",
      ],
      label: `${prefix} preflight`,
      argv: [
        "npm",
        "run",
        "product-truth:canonical-cogs-reconcile",
        "--",
        "preflight",
        "--url",
        input.options.url,
        ...authArgs(input.options),
        "--plan",
        join(planDir, "reconcile-plan.json"),
        "--plan-sha256",
        reconcilePlanSha,
        "--checked-at",
        checkedAt,
        "--out",
        preflightDir,
      ],
      cwd: input.cwd,
      executor: input.executor,
      allowExisting: input.allowExisting,
    });
    const preflightSha = await exactDigest(
      join(preflightDir, "preflight-report.sha256"),
      `${prefix} preflight SHA`,
    );
    await runSealedStage({
      stagePath: applyDir,
      requiredFiles: [
        "apply-report.json",
        "apply-report.sha256",
        "artifact-index.json",
        "artifact-index.sha256",
      ],
      label: `${prefix} apply`,
      argv: [
        "npm",
        "run",
        "product-truth:canonical-cogs-reconcile",
        "--",
        "apply",
        "--url",
        input.options.url,
        ...authArgs(input.options),
        "--plan",
        join(planDir, "reconcile-plan.json"),
        "--plan-sha256",
        reconcilePlanSha,
        "--standing-policy",
        input.options.standingNoPaidPolicyPath,
        "--standing-policy-sha256",
        input.options.standingNoPaidPolicySha256,
        "--preflight",
        join(preflightDir, "preflight-report.json"),
        "--preflight-sha256",
        preflightSha,
        "--started-at",
        new Date().toISOString(),
        "--out",
        applyDir,
      ],
      cwd: input.cwd,
      executor: input.executor,
      allowExisting: input.allowExisting,
    });
    appliedReports.push(join(applyDir, "apply-report.json"));
  }
  return appliedReports;
}

interface TargetReport {
  ordinal: number;
  donorProductId: string;
  listingKey: string;
  linkedListingCount: number;
  runId: string;
  outcome: string;
  reason: string;
  priceObservationId: string | null;
  actualProviderUnits: number;
  cogsApplyReports: readonly string[];
}

async function runTarget(input: {
  options: ProductTruthStandingWaveRunOptions;
  plan: ProductTruthStandingWavePlan;
  target: ProductTruthStandingWaveCandidate;
  ordinal: number;
  cwd: string;
  executor: ProductTruthStandingWaveCommandExecutor;
  allowExisting: boolean;
}): Promise<TargetReport> {
  const targetRoot = join(
    input.options.workDir,
    targetDirectoryName(input.target, input.ordinal),
  );
  if (!(await isDirectory(targetRoot))) {
    await createNewDirectory(targetRoot);
  } else if (!input.allowExisting) {
    fail(
      "STANDING_WAVE_EXECUTE_REQUIRES_NEW_ROOT",
      `target root already exists: ${targetRoot}`,
    );
  }
  const doctorDir = join(targetRoot, "doctor");
  const planDir = join(targetRoot, "plan");
  const balanceDir = join(targetRoot, "balance");
  const authorizationDir = join(targetRoot, "authorization");
  const executionDir = join(targetRoot, "execution");
  const runId = `${input.plan.waveId}-${String(input.ordinal + 1).padStart(2, "0")}`;
  await runSealedStage({
    stagePath: doctorDir,
    requiredFiles: ["request.json", "request.sha256"],
    label: `target ${input.ordinal + 1} doctor`,
    argv: [
      "npm",
      "run",
      "product-truth",
      "--",
      "doctor",
      "--donor-product-id",
      input.target.donorProductId,
      "--query",
      input.target.query,
      "--run-id",
      runId,
      "--expires-at",
      targetExpiry(input.plan, new Date()),
      "--unwrangle-reserve-floor",
      "15000",
      "--listing-key",
      input.target.representative.listingKey,
      "--component-index",
      String(input.target.representative.componentIndex),
      "--url",
      input.options.url,
      ...authArgs(input.options),
      "--out",
      doctorDir,
    ],
    cwd: input.cwd,
    executor: input.executor,
    allowExisting: input.allowExisting,
  });
  await runSealedStage({
    stagePath: planDir,
    requiredFiles: ["approval-instructions.json", "plan.json", "plan.sha256"],
    label: `target ${input.ordinal + 1} plan`,
    argv: [
      "npm",
      "run",
      "product-truth",
      "--",
      "plan",
      "--request",
      join(doctorDir, "request.json"),
      "--url",
      input.options.url,
      ...authArgs(input.options),
      "--out",
      planDir,
    ],
    cwd: input.cwd,
    executor: input.executor,
    allowExisting: input.allowExisting,
  });
  await runSealedStage({
    stagePath: balanceDir,
    requiredFiles: [
      "artifact-index.json",
      "artifact-index.sha256",
      "balance-evidence.json",
      "balance-evidence.sha256",
      "raw-response.json",
      "raw-response.sha256",
    ],
    label: `target ${input.ordinal + 1} balance`,
    argv: [
      "npm",
      "run",
      "product-truth",
      "--",
      "balance-probe",
      "--plan",
      join(planDir, "plan.json"),
      "--plan-sha",
      join(planDir, "plan.sha256"),
      "--standing-policy",
      input.options.standingProviderPolicyPath,
      "--url",
      input.options.url,
      ...authArgs(input.options),
      "--out",
      balanceDir,
    ],
    cwd: input.cwd,
    executor: input.executor,
    allowExisting: input.allowExisting,
  });
  await runSealedStage({
    stagePath: authorizationDir,
    requiredFiles: [
      "approval.json",
      "approval.sha256",
      "artifact-index.json",
      "artifact-index.sha256",
      "authorization.json",
      "authorization.sha256",
    ],
    label: `target ${input.ordinal + 1} authorization`,
    argv: [
      "npm",
      "run",
      "product-truth",
      "--",
      "authorize",
      "--plan",
      join(planDir, "plan.json"),
      "--plan-sha",
      join(planDir, "plan.sha256"),
      "--standing-policy",
      input.options.standingProviderPolicyPath,
      "--balance-evidence",
      join(balanceDir, "balance-evidence.json"),
      "--balance-evidence-sha",
      join(balanceDir, "balance-evidence.sha256"),
      "--balance-raw-response",
      join(balanceDir, "raw-response.json"),
      "--url",
      input.options.url,
      ...authArgs(input.options),
      "--out",
      authorizationDir,
      "--execute-out",
      executionDir,
    ],
    cwd: input.cwd,
    executor: input.executor,
    allowExisting: input.allowExisting,
  });
  const authorizationJson = await readExactFile(
    join(authorizationDir, "authorization.json"),
    "standing authorization",
  );
  let authorization: unknown;
  try {
    authorization = JSON.parse(authorizationJson);
  } catch (error) {
    fail("STANDING_WAVE_AUTHORIZATION_INVALID", "authorization is not JSON", error);
  }
  if (
    typeof authorization !== "object"
    || authorization === null
    || !("next_argv" in authorization)
  ) {
    fail("STANDING_WAVE_AUTHORIZATION_INVALID", "authorization has no next_argv");
  }
  const executeArgv = assertProductTruthStandingWaveExecuteArgv({
    argv: authorization.next_argv,
    cwd: input.cwd,
    planPath: join(planDir, "plan.json"),
    planShaPath: join(planDir, "plan.sha256"),
    approvalPath: join(authorizationDir, "approval.json"),
    executionPath: executionDir,
    url: input.options.url,
    authTokenEnv: input.options.authTokenEnv,
  });
  await runSealedStage({
    stagePath: executionDir,
    requiredFiles: [
      "artifact-index.json",
      "artifact-index.sha256",
      "report.json",
      "report.sha256",
    ],
    label: `target ${input.ordinal + 1} execute`,
    argv: executeArgv,
    cwd: input.cwd,
    executor: input.executor,
    allowExisting: input.allowExisting,
    allowedExitCodes: [0, 2],
  });
  const executionJson = await readExactFile(
    join(executionDir, "report.json"),
    "target execution report",
  );
  let executionReport: unknown;
  try {
    executionReport = JSON.parse(executionJson);
  } catch (error) {
    fail("STANDING_WAVE_EXECUTION_REPORT_INVALID", "report is not JSON", error);
  }
  const terminal = readTerminalOutcome(executionReport);
  const priceObservationId = readCheckpointPriceObservation(executionReport);
  const cogsApplyReports = priceObservationId
    ? await runCogsForTarget({
        options: input.options,
        plan: input.plan,
        target: input.target,
        targetRoot,
        cwd: input.cwd,
        executor: input.executor,
        allowExisting: input.allowExisting,
      })
    : [];
  return {
    ordinal: input.ordinal,
    donorProductId: input.target.donorProductId,
    listingKey: input.target.representative.listingKey,
    linkedListingCount: input.target.linkedListingKeys.length,
    runId,
    outcome: terminal.outcome,
    reason: terminal.reason,
    priceObservationId,
    actualProviderUnits: 2.5 + terminal.actualWorkingProviderUnits,
    cogsApplyReports,
  };
}

async function runPlan(options: PlanOptions): Promise<void> {
  await validateBoundInputs(options);
  const { target, db } = openDatabase(options);
  try {
    const candidates = await rankProductTruthStandingWaveCandidates({
      db,
      manifestSha256: options.manifestSha256,
      limit: options.maxTargets,
    });
    if (candidates.length < 1) {
      fail(
        "STANDING_WAVE_NO_ELIGIBLE_TARGETS",
        "no untouched exact current-recipe target is eligible",
      );
    }
    const sealed = sealProductTruthStandingWavePlan({
      waveId: options.waveId,
      createdAt: options.createdAt,
      expiresAt: options.expiresAt,
      databaseTargetFingerprint: target.fingerprint,
      manifestSha256: options.manifestSha256,
      standingProviderPolicySha256: options.standingProviderPolicySha256,
      standingNoPaidPolicySha256: options.standingNoPaidPolicySha256,
      maxTargets: options.maxTargets,
      candidates,
    });
    const planJson = renderProductTruthStandingWavePlan(sealed.plan);
    const indexJson = renderProductTruthOperationalJson({
      schemaVersion: WAVE_INDEX_VERSION,
      status: "PLANNED",
      waveId: sealed.plan.waveId,
      generatedAt: sealed.plan.createdAt,
      planSha256: sealed.planSha256,
      targetCount: sealed.plan.targets.length,
      maximumProviderUnits: sealed.plan.workflow.maximumWaveProviderUnits,
      ownerActionRequired: false,
      claims: {
        databaseWrites: 0,
        providerCalls: 0,
        paidCalls: 0,
        marketplaceMutations: 0,
      },
      artifacts: [
        { role: "wave_plan", file: "wave-plan.json", sha256: sealed.planSha256 },
      ],
    });
    await createNewDirectory(options.outDir);
    await Promise.all([
      writeNew(join(options.outDir, "wave-plan.json"), planJson),
      writeNew(
        join(options.outDir, "wave-plan.sha256"),
        `${sealed.planSha256}\n`,
      ),
      writeNew(join(options.outDir, "artifact-index.json"), indexJson),
      writeNew(
        join(options.outDir, "artifact-index.sha256"),
        `${sha256(indexJson)}\n`,
      ),
    ]);
    process.stdout.write(indexJson);
  } finally {
    db.close();
  }
}

async function loadPlan(
  options: ProductTruthStandingWaveRunOptions,
): Promise<ProductTruthStandingWavePlan> {
  const planJson = await readExactFile(options.planPath, "standing wave plan");
  if (
    sha256(planJson) !== options.planSha256
    || productTruthStandingWavePlanSha256(JSON.parse(planJson))
      !== options.planSha256
  ) {
    fail("STANDING_WAVE_PLAN_SHA_MISMATCH", "wave plan bytes differ");
  }
  const plan = parseProductTruthStandingWavePlan(JSON.parse(planJson));
  const target = resolveProductTruthDatabaseTarget(options.url, process.cwd());
  if (
    plan.databaseTargetFingerprint !== target.fingerprint
    || plan.manifestSha256 !== options.manifestSha256
    || plan.authority.standingProviderPolicySha256
      !== options.standingProviderPolicySha256
    || plan.authority.standingNoPaidPolicySha256
      !== options.standingNoPaidPolicySha256
  ) {
    fail(
      "STANDING_WAVE_PLAN_BINDING_MISMATCH",
      "runtime inputs differ from the sealed wave plan",
    );
  }
  return plan;
}

async function writeWaveReport(input: {
  options: ProductTruthStandingWaveRunOptions;
  plan: ProductTruthStandingWavePlan;
  planSha256: string;
  targetReports: readonly TargetReport[];
  readinessDir: string;
}): Promise<void> {
  const readinessSha256 = await exactDigest(
    join(input.readinessDir, "readiness-report.sha256"),
    "readiness report SHA",
  );
  const report = {
    schemaVersion: WAVE_REPORT_VERSION,
    waveId: input.plan.waveId,
    planSha256: input.planSha256,
    completedAt: new Date().toISOString(),
    status: "COMPLETED",
    targetReports: input.targetReports,
    totals: {
      targets: input.targetReports.length,
      priceObservations: input.targetReports.filter(
        (target) => target.priceObservationId !== null,
      ).length,
      cogsApplyReports: input.targetReports.reduce(
        (total, target) => total + target.cogsApplyReports.length,
        0,
      ),
      actualProviderUnits: input.targetReports.reduce(
        (total, target) => total + target.actualProviderUnits,
        0,
      ),
      maximumProviderUnits: input.plan.workflow.maximumWaveProviderUnits,
      retries: 0,
      marketplaceMutations: 0,
    },
    readiness: {
      reportPath: join(input.readinessDir, "readiness-report.json"),
      reportSha256: readinessSha256,
    },
    claims: input.plan.claims,
  };
  const reportJson = renderProductTruthOperationalJson(report);
  const reportSha256 = productTruthOperationalSha256(report);
  const indexJson = renderProductTruthOperationalJson({
    schemaVersion: WAVE_INDEX_VERSION,
    status: "COMPLETED",
    waveId: input.plan.waveId,
    generatedAt: report.completedAt,
    planSha256: input.planSha256,
    reportSha256,
    readinessReportSha256: readinessSha256,
    targetCount: input.targetReports.length,
    actualProviderUnits: report.totals.actualProviderUnits,
    retries: 0,
    marketplaceMutations: 0,
    artifacts: [
      { role: "wave_report", file: "wave-report.json", sha256: reportSha256 },
    ],
  });
  await Promise.all([
    writeNew(join(input.options.workDir, "wave-report.json"), reportJson),
    writeNew(
      join(input.options.workDir, "wave-report.sha256"),
      `${reportSha256}\n`,
    ),
    writeNew(join(input.options.workDir, "artifact-index.json"), indexJson),
    writeNew(
      join(input.options.workDir, "artifact-index.sha256"),
      `${sha256(indexJson)}\n`,
    ),
  ]);
  process.stdout.write(indexJson);
}

export async function runProductTruthStandingWave(
  options: ProductTruthStandingWaveRunOptions,
  executor: ProductTruthStandingWaveCommandExecutor = defaultExecutor,
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  await validateBoundInputs(options);
  const plan = await loadPlan(options);
  if (Date.now() > Date.parse(plan.expiresAt)) {
    fail("STANDING_WAVE_EXPIRED", "wave plan has expired");
  }
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const allowExisting = options.command === "resume";
  if (options.command === "execute") {
    assertProductTruthStandingWaveProviderEnvironment(environment);
    await createNewDirectory(options.workDir);
  } else if (!(await isDirectory(options.workDir))) {
    fail("STANDING_WAVE_RESUME_ROOT_MISSING", "resume work directory is missing");
  }
  const completedReport = await validateOptionalArtifactSet({
    root: options.workDir,
    requiredFiles: [
      "wave-report.json",
      "wave-report.sha256",
      "artifact-index.json",
      "artifact-index.sha256",
    ],
    label: "wave completion",
  });
  if (completedReport === "COMPLETE") {
    if (!allowExisting) {
      fail("STANDING_WAVE_EXECUTE_REQUIRES_NEW_ROOT", "wave is already complete");
    }
    process.stdout.write(await readExactFile(
      join(options.workDir, "artifact-index.json"),
      "wave artifact index",
    ));
    return;
  }
  if (options.command === "resume") {
    assertProductTruthStandingWaveProviderEnvironment(environment);
  }
  const targetReports: TargetReport[] = [];
  for (const [ordinal, target] of plan.targets.entries()) {
    targetReports.push(
      await runTarget({
        options,
        plan,
        target,
        ordinal,
        cwd,
        executor,
        allowExisting,
      }),
    );
  }
  const readinessDir = join(options.workDir, "readiness");
  await runSealedStage({
    stagePath: readinessDir,
    requiredFiles: [
      "readiness-report.json",
      "readiness-report.sha256",
      "artifact-index.json",
      "artifact-index.sha256",
    ],
    label: "full-denominator readiness",
    argv: [
      "npm",
      "run",
      "product-truth",
      "--",
      "readiness",
      "--manifest",
      options.manifestPath,
      "--as-of",
      new Date().toISOString(),
      "--max-price-age-ms",
      String(plan.workflow.readinessMaxPriceAgeMs),
      "--url",
      options.url,
      ...authArgs(options),
      "--out",
      readinessDir,
    ],
    cwd,
    executor,
    allowExisting,
  });
  await writeWaveReport({
    options,
    plan,
    planSha256: options.planSha256,
    targetReports,
    readinessDir,
  });
}

async function runStatus(options: StatusOptions): Promise<void> {
  if (!(await isDirectory(options.workDir))) {
    fail("STANDING_WAVE_STATUS_ROOT_MISSING", "work directory is missing");
  }
  const complete = await validateOptionalArtifactSet({
    root: options.workDir,
    requiredFiles: [
      "wave-report.json",
      "wave-report.sha256",
      "artifact-index.json",
      "artifact-index.sha256",
    ],
    label: "wave completion",
  });
  if (complete === "COMPLETE") {
    process.stdout.write(await readExactFile(
      join(options.workDir, "wave-report.json"),
      "wave report",
    ));
    return;
  }
  process.stdout.write(renderProductTruthOperationalJson({
    schemaVersion: WAVE_REPORT_VERSION,
    status: "IN_PROGRESS_OR_AMBIGUOUS",
    workDir: options.workDir,
    nextCommand: "resume",
    claims: {
      noAutomaticRetry: true,
      noMarketplaceMutation: true,
    },
  }));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const options = parseOptions(argv);
  if (options.command === "plan") {
    await runPlan(options);
  } else if (options.command === "status") {
    await runStatus(options);
  } else {
    await runProductTruthStandingWave(options);
  }
}

const invokedAsMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedAsMain) {
  main().catch((error: unknown) => {
    const code =
      error instanceof ProductTruthStandingWaveCliError
        ? error.code
        : "STANDING_WAVE_UNEXPECTED";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${renderProductTruthOperationalJson({
        ok: false,
        error: { code, message },
      })}`,
    );
    process.exitCode = 1;
  });
}
