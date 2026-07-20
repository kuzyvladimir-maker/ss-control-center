/**
 * Owner/Codex-only activation of one sealed all-status Walmart ITEM v6 source.
 *
 * This command never calls Walmart. PLAN only reads the selected DB and writes
 * immutable local artifacts. APPLY requires the exact sealed plan, canonical
 * externally signed owner approval plus independent SHA sidecars, current
 * target/account scope, and bound confirmation before one atomic DB transaction.
 * It is intentionally not part of the Claude Code operator command surface.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";

import { resolveProductTruthDatabaseTarget } from "../src/lib/sourcing/product-truth-database-target";
import { computeWalmartSellerAccountFingerprint } from "../src/lib/walmart/item-report-capture-session";
import { canonicalWalmartItemReportJson } from "../src/lib/walmart/item-report-published-source";
import {
  applyWalmartNewSkuCatalogActivation,
  assembleWalmartNewSkuCatalogActivationOwnerApproval,
  buildWalmartNewSkuCatalogActivationConfirmation,
  buildWalmartNewSkuCatalogActivationOwnerApprovalSigningRequest,
  planWalmartNewSkuCatalogActivation,
  verifyWalmartNewSkuCatalogActivationPlan,
  type SealedWalmartNewSkuCatalogActivationPlan,
} from "../src/lib/bundle-factory/walmart-new-sku-catalog-activation";
import { fingerprintWalmartSellerAccount } from "../src/lib/bundle-factory/walmart-new-sku-engine";

const MAX_PLAN_BYTES = 1024 * 1024;

type Command = "plan" | "approval-request" | "approval-assemble" | "apply" | "help";

export interface WalmartNewSkuCatalogActivationCliOptions {
  command: Command;
  databaseUrl: string | null;
  environment: string | null;
  storeIndex: number;
  sourcePath: string | null;
  sourceSha256: string | null;
  expiresAt: Date | null;
  outputDirectory: string | null;
  planPath: string | null;
  planShaPath: string | null;
  ownerApprovalPath: string | null;
  ownerApprovalShaPath: string | null;
  ownerApprovalRequestPath: string | null;
  detachedSignaturePath: string | null;
  keyId: string | null;
  approvalId: string | null;
  actor: string | null;
  decisionRef: string | null;
  issuedAt: Date | null;
  approvalExpiresAt: Date | null;
  confirmation: string | null;
  allowRemote: boolean;
  authTokenEnvName: string | null;
}

export class WalmartNewSkuCatalogActivationCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WalmartNewSkuCatalogActivationCliError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartNewSkuCatalogActivationCliError(code, message);
}

function exactIso(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("CLI_TIMESTAMP_INVALID", `${label} must be an exact canonical ISO UTC timestamp`);
  }
  return parsed;
}

function exactEnvironment(value: string | null): string {
  if (!value || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) {
    fail("CLI_ENVIRONMENT_INVALID", "--environment is required and must be a safe name");
  }
  return value;
}

function exactSha256(value: string | null, label: string): string {
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CLI_SHA256_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function exactAbsolutePath(value: string | null, label: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    fail("CLI_PATH_INVALID", `${label} must be a normalized absolute path`);
  }
  return value;
}

function exactStoreIndex(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  if (!Number.isSafeInteger(parsed) || parsed !== 1) {
    fail("CLI_STORE_INVALID", "--store-index must be exactly 1 for this pilot");
  }
  return parsed;
}

export function parseWalmartNewSkuCatalogActivationCli(
  argv: readonly string[],
): WalmartNewSkuCatalogActivationCliOptions {
  const rawCommand = argv[0] ?? "help";
  if (rawCommand === "--help" || rawCommand === "-h" || rawCommand === "help") {
    return {
      command: "help",
      databaseUrl: null,
      environment: null,
      storeIndex: 1,
      sourcePath: null,
      sourceSha256: null,
      expiresAt: null,
      outputDirectory: null,
      planPath: null,
      planShaPath: null,
      ownerApprovalPath: null,
      ownerApprovalShaPath: null,
      ownerApprovalRequestPath: null,
      detachedSignaturePath: null,
      keyId: null,
      approvalId: null,
      actor: null,
      decisionRef: null,
      issuedAt: null,
      approvalExpiresAt: null,
      confirmation: null,
      allowRemote: false,
      authTokenEnvName: null,
    };
  }
  if (rawCommand !== "plan" && rawCommand !== "approval-request"
    && rawCommand !== "approval-assemble" && rawCommand !== "apply") {
    fail(
      "CLI_COMMAND_INVALID",
      "first argument must be plan, approval-request, approval-assemble, or apply",
    );
  }
  const values = new Map<string, string>();
  let allowRemote = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--allow-remote") {
      if (allowRemote) fail("CLI_FLAG_DUPLICATE", "--allow-remote was repeated");
      allowRemote = true;
      continue;
    }
    if (!token.startsWith("--")) fail("CLI_ARGUMENT_INVALID", `unexpected ${token}`);
    const separator = token.indexOf("=");
    const flag = separator < 0 ? token : token.slice(0, separator);
    const inlineValue = separator < 0 ? null : token.slice(separator + 1);
    const supported = new Set([
      "--url",
      "--environment",
      "--store-index",
      "--source",
      "--source-sha256",
      "--expires-at",
      "--out",
      "--plan",
      "--plan-sha",
      "--owner-approval",
      "--owner-approval-sha",
      "--approval-request",
      "--detached-signature",
      "--key-id",
      "--approval-id",
      "--actor",
      "--decision-ref",
      "--issued-at",
      "--approval-expires-at",
      "--confirm",
      "--auth-token-env",
    ]);
    if (!supported.has(flag)) fail("CLI_FLAG_UNKNOWN", `unknown flag ${flag}`);
    if (values.has(flag)) fail("CLI_FLAG_DUPLICATE", `${flag} was repeated`);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === null) index += 1;
    if (!value || value.startsWith("--")) {
      fail("CLI_FLAG_VALUE_REQUIRED", `${flag} requires a value`);
    }
    values.set(flag, value);
  }
  const planFlags = new Set([
    "--url", "--environment", "--store-index", "--source", "--source-sha256",
    "--expires-at", "--out", "--auth-token-env",
  ]);
  const applyFlags = new Set([
    "--url", "--environment", "--store-index", "--plan", "--plan-sha",
    "--owner-approval", "--owner-approval-sha", "--confirm", "--out",
    "--auth-token-env",
  ]);
  const approvalRequestFlags = new Set([
    "--url", "--environment", "--store-index", "--plan", "--plan-sha",
    "--key-id", "--approval-id", "--actor", "--decision-ref", "--issued-at",
    "--approval-expires-at", "--out",
  ]);
  const approvalAssembleFlags = new Set([
    "--url", "--environment", "--store-index", "--plan", "--plan-sha",
    "--approval-request", "--detached-signature", "--out",
  ]);
  const allowed = rawCommand === "plan"
    ? planFlags
    : rawCommand === "approval-request"
      ? approvalRequestFlags
      : rawCommand === "approval-assemble"
        ? approvalAssembleFlags
        : applyFlags;
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) {
      fail("CLI_FLAG_MODE_FORBIDDEN", `${rawCommand} does not accept ${flag}`);
    }
  }
  return {
    command: rawCommand,
    databaseUrl: values.get("--url") ?? null,
    environment: values.get("--environment") ?? null,
    storeIndex: exactStoreIndex(values.get("--store-index")),
    sourcePath: values.get("--source") ?? null,
    sourceSha256: values.get("--source-sha256") ?? null,
    expiresAt: values.has("--expires-at")
      ? exactIso(values.get("--expires-at")!, "--expires-at")
      : null,
    outputDirectory: values.get("--out") ?? null,
    planPath: values.get("--plan") ?? null,
    planShaPath: values.get("--plan-sha") ?? null,
    ownerApprovalPath: values.get("--owner-approval") ?? null,
    ownerApprovalShaPath: values.get("--owner-approval-sha") ?? null,
    ownerApprovalRequestPath: values.get("--approval-request") ?? null,
    detachedSignaturePath: values.get("--detached-signature") ?? null,
    keyId: values.get("--key-id") ?? null,
    approvalId: values.get("--approval-id") ?? null,
    actor: values.get("--actor") ?? null,
    decisionRef: values.get("--decision-ref") ?? null,
    issuedAt: values.has("--issued-at")
      ? exactIso(values.get("--issued-at")!, "--issued-at")
      : null,
    approvalExpiresAt: values.has("--approval-expires-at")
      ? exactIso(values.get("--approval-expires-at")!, "--approval-expires-at")
      : null,
    confirmation: values.get("--confirm") ?? null,
    allowRemote,
    authTokenEnvName: values.get("--auth-token-env") ?? null,
  };
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveAuthorization(input: {
  target: ReturnType<typeof resolveProductTruthDatabaseTarget>;
  allowRemote: boolean;
  authTokenEnvName: string | null;
  env: NodeJS.ProcessEnv;
}): { authToken?: string } {
  if (input.target.kind === "local") {
    if (input.allowRemote || input.authTokenEnvName) {
      fail("CLI_REMOTE_FLAGS_FORBIDDEN", "local target must not use remote flags");
    }
    if (!input.target.localPath) {
      fail("CLI_MEMORY_DATABASE_FORBIDDEN", "owner activation requires a durable DB");
    }
    return {};
  }
  if (!input.allowRemote) {
    fail("CLI_REMOTE_FLAG_REQUIRED", "remote target requires --allow-remote");
  }
  const envName = input.authTokenEnvName ?? "";
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(envName)) {
    fail("CLI_AUTH_ENV_INVALID", "remote target requires --auth-token-env NAME");
  }
  const authToken = input.env[envName];
  if (!authToken?.trim()) {
    fail("CLI_AUTH_ENV_EMPTY", `named auth environment ${envName} is empty`);
  }
  return { authToken };
}

function currentWalmartAccountScope(
  env: NodeJS.ProcessEnv,
  storeIndex: number,
): {
  businessSellerAccountFingerprintSha256: string;
  activeCaptureCredentialScopeFingerprintSha256: string;
} {
  const clientId = env[`WALMART_CLIENT_ID_STORE${storeIndex}`];
  const clientSecret = env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`];
  const sellerId = env[`WALMART_STORE${storeIndex}_SELLER_ID`];
  if (!clientId?.trim() || !clientSecret?.trim() || !sellerId?.trim()) {
    fail(
      "CLI_WALMART_ACCOUNT_SCOPE_UNAVAILABLE",
      `active Walmart STORE${storeIndex} client ID, client secret, and seller ID are required`,
    );
  }
  return {
    businessSellerAccountFingerprintSha256: fingerprintWalmartSellerAccount({
      storeIndex,
      sellerId,
    }),
    activeCaptureCredentialScopeFingerprintSha256:
      computeWalmartSellerAccountFingerprint({
        store_index: storeIndex,
        client_id: clientId,
        seller_id: sellerId,
      }),
  };
}

async function assertDurableLocalTarget(
  target: ReturnType<typeof resolveProductTruthDatabaseTarget>,
): Promise<void> {
  if (target.kind !== "local" || !target.localPath) return;
  const info = await stat(target.localPath).catch(() => null);
  if (!info || !info.isFile()) {
    fail("CLI_DATABASE_NOT_FOUND", "refusing to create an absent local database target");
  }
}

async function createNewPrivateOutputDirectory(pathInput: string | null): Promise<string> {
  const output = exactAbsolutePath(pathInput, "--out");
  const parent = dirname(output);
  const parentInfo = await lstat(parent).catch(() => null);
  if (!parentInfo || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    fail("CLI_OUTPUT_PARENT_UNSAFE", "output parent must be a real directory");
  }
  try {
    await mkdir(output, { mode: 0o700 });
  } catch (error) {
    fail(
      "CLI_OUTPUT_DIRECTORY_NOT_NEW",
      error instanceof Error ? error.message : String(error),
    );
  }
  return output;
}

async function writeExclusive(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function sameStat(
  left: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readNoFollow(path: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(path).catch(() => null);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 2 || before.size > maximumBytes) {
    fail("CLI_ARTIFACT_UNSAFE", `unsafe artifact ${path}`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    .catch(() => null);
  if (!handle) fail("CLI_ARTIFACT_UNSAFE", `cannot safely open ${path}`);
  try {
    const opened = await handle.stat();
    if (!sameStat(before, opened)) fail("CLI_ARTIFACT_CHANGED", `${path} changed`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size || !sameStat(opened, after)) {
      fail("CLI_ARTIFACT_CHANGED", `${path} changed during read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readPlanPair(input: {
  planPath: string | null;
  planShaPath: string | null;
}): Promise<SealedWalmartNewSkuCatalogActivationPlan> {
  const planPath = exactAbsolutePath(input.planPath, "--plan");
  const planShaPath = exactAbsolutePath(input.planShaPath, "--plan-sha");
  if (dirname(planPath) !== dirname(planShaPath)
    || planPath !== resolve(dirname(planPath), "plan.json")
    || planShaPath !== resolve(dirname(planPath), "plan.sha256")) {
    fail("CLI_PLAN_PAIR_INVALID", "plan must be exact sibling plan.json/plan.sha256");
  }
  const [planBytes, sidecarBytes] = await Promise.all([
    readNoFollow(planPath, MAX_PLAN_BYTES),
    readNoFollow(planShaPath, 256),
  ]);
  const actualSha256 = sha256(planBytes);
  if (sidecarBytes.toString("utf8") !== `${actualSha256}\n`) {
    fail("CLI_PLAN_SHA_MISMATCH", "plan.sha256 does not match exact plan bytes");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(planBytes.toString("utf8")) as unknown;
  } catch {
    fail("CLI_PLAN_JSON_INVALID", "plan.json is not valid JSON");
  }
  const plan = verifyWalmartNewSkuCatalogActivationPlan(parsed);
  if (canonicalWalmartItemReportJson(plan) !== planBytes.toString("utf8")) {
    fail("CLI_PLAN_NOT_CANONICAL", "plan bytes are not the exact canonical sealed plan");
  }
  return plan;
}

async function readCanonicalJsonArtifact(input: {
  path: string | null;
  label: string;
  maximumBytes?: number;
}): Promise<{ bytes: Buffer; value: unknown; fileSha256: string }> {
  const artifactPath = exactAbsolutePath(input.path, input.label);
  const bytes = await readNoFollow(artifactPath, input.maximumBytes ?? MAX_PLAN_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    fail("CLI_ARTIFACT_JSON_INVALID", `${input.label} is not valid JSON`);
  }
  if (canonicalWalmartItemReportJson(value) !== bytes.toString("utf8")) {
    fail("CLI_ARTIFACT_NOT_CANONICAL", `${input.label} is not exact canonical JSON`);
  }
  return { bytes, value, fileSha256: sha256(bytes) };
}

async function readOwnerApprovalPair(input: {
  approvalPath: string | null;
  approvalShaPath: string | null;
}): Promise<{
  approval: unknown;
  artifactSha256: string;
  bytes: Buffer;
}> {
  const approvalPath = exactAbsolutePath(input.approvalPath, "--owner-approval");
  const approvalShaPath = exactAbsolutePath(
    input.approvalShaPath,
    "--owner-approval-sha",
  );
  if (dirname(approvalPath) !== dirname(approvalShaPath)
    || approvalPath !== resolve(dirname(approvalPath), "approval.json")
    || approvalShaPath !== resolve(dirname(approvalPath), "approval.sha256")) {
    fail(
      "CLI_OWNER_APPROVAL_PAIR_INVALID",
      "owner approval must be exact sibling approval.json/approval.sha256",
    );
  }
  const [artifact, sidecarBytes] = await Promise.all([
    readCanonicalJsonArtifact({ path: approvalPath, label: "--owner-approval" }),
    readNoFollow(approvalShaPath, 256),
  ]);
  if (sidecarBytes.toString("utf8") !== `${artifact.fileSha256}\n`) {
    fail(
      "CLI_OWNER_APPROVAL_SHA_MISMATCH",
      "approval.sha256 does not match exact canonical approval bytes",
    );
  }
  return {
    approval: artifact.value,
    artifactSha256: artifact.fileSha256,
    bytes: artifact.bytes,
  };
}

function assertPlanCliScope(input: {
  plan: SealedWalmartNewSkuCatalogActivationPlan;
  environment: string;
  targetFingerprint: string;
  storeIndex: number;
  accountScope: ReturnType<typeof currentWalmartAccountScope>;
}): void {
  if (input.plan.environment !== input.environment
    || input.plan.database_target_fingerprint_sha256 !== input.targetFingerprint
    || input.plan.store_index !== input.storeIndex
    || input.plan.account_scope.business_seller_account_fingerprint_sha256
      !== input.accountScope.businessSellerAccountFingerprintSha256
    || input.plan.account_scope.capture_credential_scope_fingerprint_sha256
      !== input.accountScope.activeCaptureCredentialScopeFingerprintSha256) {
    fail(
      "CLI_PLAN_SCOPE_MISMATCH",
      "plan environment, target, store, or active Walmart account scope differs",
    );
  }
}

function usage(): string {
  return [
    "Walmart new-SKU catalog activation (OWNER/CODEX ONLY; never Claude operator)",
    "",
    "Read-only database plan:",
    "  npm run walmart:new-sku:catalog -- plan --url file:/ABSOLUTE/db.sqlite",
    "    --environment production --store-index 1",
    "    --source /ABSOLUTE/sanitized/item-report-catalog-source.json",
    "    --source-sha256 LOWERCASE_SHA256 --expires-at EXACT_ISO_UTC",
    "    --out /ABSOLUTE/new-plan-directory",
    "",
    "External Ed25519 approval request (no private key access):",
    "  npm run walmart:new-sku:catalog -- approval-request --url file:/ABSOLUTE/db.sqlite",
    "    --environment production --store-index 1 --plan /ABSOLUTE/plan/plan.json",
    "    --plan-sha /ABSOLUTE/plan/plan.sha256 --key-id PINNED_KEY_ID",
    "    --approval-id UNIQUE_ID --actor REAL_OWNER --decision-ref ABSOLUTE_URL",
    "    --issued-at EXACT_ISO_UTC --approval-expires-at EXACT_ISO_UTC",
    "    --out /ABSOLUTE/new-approval-request-directory",
    "",
    "Assemble a verified approval from exactly 64 detached raw Ed25519 bytes:",
    "  npm run walmart:new-sku:catalog -- approval-assemble --url file:/ABSOLUTE/db.sqlite",
    "    --environment production --store-index 1 --plan /ABSOLUTE/plan/plan.json",
    "    --plan-sha /ABSOLUTE/plan/plan.sha256",
    "    --approval-request /ABSOLUTE/approval-request.json",
    "    --detached-signature /ABSOLUTE/owner-signature.bin",
    "    --out /ABSOLUTE/new-owner-approval-directory",
    "",
    "Atomic apply:",
    "  npm run walmart:new-sku:catalog -- apply --url file:/ABSOLUTE/db.sqlite",
    "    --environment production --store-index 1",
    "    --plan /ABSOLUTE/plan/plan.json --plan-sha /ABSOLUTE/plan/plan.sha256",
    "    --owner-approval /ABSOLUTE/approval/approval.json",
    "    --owner-approval-sha /ABSOLUTE/approval/approval.sha256",
    "    --confirm EXACT_CONFIRMATION_FROM_SIGNED_APPROVAL --out /ABSOLUTE/new-receipt-directory",
    "",
    "Remote plan/apply require --allow-remote --auth-token-env NAME.",
    "Remote approval-request/approval-assemble require --allow-remote but never read DB auth.",
    "No raw auth token or private signing key is accepted. This command makes no Walmart/provider API calls.",
    "Remote plan/apply access only the explicitly selected database over its client transport.",
  ].join("\n");
}

export async function runWalmartNewSkuCatalogActivationCli(
  argv: readonly string[],
  dependencies: {
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
  } = {},
): Promise<Record<string, unknown>> {
  const options = parseWalmartNewSkuCatalogActivationCli(argv);
  if (options.command === "help") return { help: usage() };
  const databaseUrl = options.databaseUrl?.trim();
  if (!databaseUrl) fail("CLI_DATABASE_REQUIRED", "--url is required");
  const environment = exactEnvironment(options.environment);
  const env = dependencies.env ?? process.env;
  const now = dependencies.now?.() ?? new Date();
  const target = resolveProductTruthDatabaseTarget(databaseUrl);
  await assertDurableLocalTarget(target);
  const accountScope = currentWalmartAccountScope(env, options.storeIndex);

  if (options.command === "approval-request" || options.command === "approval-assemble") {
    if (target.kind === "remote" && !options.allowRemote) {
      fail("CLI_REMOTE_FLAG_REQUIRED", "remote target requires --allow-remote");
    }
    const plan = await readPlanPair({
      planPath: options.planPath,
      planShaPath: options.planShaPath,
    });
    assertPlanCliScope({
      plan,
      environment,
      targetFingerprint: target.fingerprint,
      storeIndex: options.storeIndex,
      accountScope,
    });
    if (options.command === "approval-request") {
      if (!options.issuedAt || !options.approvalExpiresAt) {
        fail(
          "CLI_APPROVAL_TIMESTAMPS_REQUIRED",
          "approval-request requires --issued-at and --approval-expires-at",
        );
      }
      const request = buildWalmartNewSkuCatalogActivationOwnerApprovalSigningRequest({
        plan,
        keyId: options.keyId ?? "",
        approvalId: options.approvalId ?? "",
        issuedAt: options.issuedAt,
        expiresAt: options.approvalExpiresAt,
        approvedBy: options.actor ?? "",
        decisionRef: options.decisionRef ?? "",
        now,
        env,
      });
      const requestBytes = canonicalWalmartItemReportJson(request);
      const requestFileSha256 = sha256(requestBytes);
      const outputDirectory = await createNewPrivateOutputDirectory(
        options.outputDirectory,
      );
      await writeExclusive(
        resolve(outputDirectory, "approval-request.json"),
        requestBytes,
      );
      await writeExclusive(
        resolve(outputDirectory, "approval-request.sha256"),
        `${requestFileSha256}\n`,
      );
      return {
        status: "OWNER_SIGNATURE_REQUIRED",
        owner_codex_only: true,
        approval_request_file_sha256: requestFileSha256,
        signing_message_base64: request.signing_message_base64,
        private_key_accessed: false,
        database_mutated: false,
        walmart_api_calls: 0,
        paid_provider_calls: 0,
        next_command: null,
        output_directory: outputDirectory,
      };
    }

    const requestArtifact = await readCanonicalJsonArtifact({
      path: options.ownerApprovalRequestPath,
      label: "--approval-request",
    });
    const signaturePath = exactAbsolutePath(
      options.detachedSignaturePath,
      "--detached-signature",
    );
    const detachedSignature = await readNoFollow(signaturePath, 64);
    if (detachedSignature.byteLength !== 64) {
      fail(
        "CLI_SIGNATURE_SIZE_INVALID",
        "--detached-signature must contain exactly 64 raw Ed25519 bytes",
      );
    }
    const approval = assembleWalmartNewSkuCatalogActivationOwnerApproval({
      request: requestArtifact.value,
      plan,
      detachedSignature,
      now,
      env,
    });
    const approvalBytes = canonicalWalmartItemReportJson(approval);
    const approvalArtifactSha256 = sha256(approvalBytes);
    const confirmation = buildWalmartNewSkuCatalogActivationConfirmation({
      plan,
      ownerApproval: approval,
      ownerApprovalArtifactSha256: approvalArtifactSha256,
      now,
      env,
    });
    const outputDirectory = await createNewPrivateOutputDirectory(
      options.outputDirectory,
    );
    await writeExclusive(resolve(outputDirectory, "approval.json"), approvalBytes);
    await writeExclusive(
      resolve(outputDirectory, "approval.sha256"),
      `${approvalArtifactSha256}\n`,
    );
    await writeExclusive(
      resolve(outputDirectory, "confirmation.txt"),
      `${confirmation}\n`,
    );
    return {
      status: "OWNER_APPROVAL_ASSEMBLED",
      owner_codex_only: true,
      owner_approval_sha256: approval.approval_sha256,
      owner_approval_artifact_sha256: approvalArtifactSha256,
      confirmation,
      private_key_accessed: false,
      database_mutated: false,
      walmart_api_calls: 0,
      paid_provider_calls: 0,
      next_command: null,
      output_directory: outputDirectory,
    };
  }

  const authorization = resolveAuthorization({
    target,
    allowRemote: options.allowRemote,
    authTokenEnvName: options.authTokenEnvName,
    env,
  });
  const db = createClient({
    url: target.clientUrl,
    ...(authorization.authToken ? { authToken: authorization.authToken } : {}),
  });
  try {
    if (options.command === "plan") {
      const expiresAt = options.expiresAt;
      if (!expiresAt) fail("CLI_EXPIRES_REQUIRED", "plan requires --expires-at");
      const plan = await planWalmartNewSkuCatalogActivation({
        db,
        sourcePath: exactAbsolutePath(options.sourcePath, "--source"),
        expectedSourceFileSha256: exactSha256(
          options.sourceSha256,
          "--source-sha256",
        ),
        storeIndex: options.storeIndex,
        businessSellerAccountFingerprintSha256:
          accountScope.businessSellerAccountFingerprintSha256,
        activeCaptureCredentialScopeFingerprintSha256:
          accountScope.activeCaptureCredentialScopeFingerprintSha256,
        databaseTargetFingerprintSha256: target.fingerprint,
        environment,
        now,
        expiresAt,
      });
      const planBytes = canonicalWalmartItemReportJson(plan);
      const planFileSha256 = sha256(planBytes);
      const outputDirectory = await createNewPrivateOutputDirectory(
        options.outputDirectory,
      );
      await writeExclusive(resolve(outputDirectory, "plan.json"), planBytes);
      await writeExclusive(
        resolve(outputDirectory, "plan.sha256"),
        `${planFileSha256}\n`,
      );
      return {
        status: "PLANNED",
        owner_codex_only: true,
        eligible_for_apply: plan.eligible_for_apply,
        blockers: plan.blockers,
        action: plan.action,
        plan_sha256: plan.plan_sha256,
        plan_file_sha256: planFileSha256,
        owner_approval_required: true,
        confirmation: null,
        next_command: null,
        output_directory: outputDirectory,
        database_mutated: false,
        database_access_kind: target.kind,
        walmart_api_calls: 0,
        paid_provider_calls: 0,
      };
    }

    const plan = await readPlanPair({
      planPath: options.planPath,
      planShaPath: options.planShaPath,
    });
    assertPlanCliScope({
      plan,
      environment,
      targetFingerprint: target.fingerprint,
      storeIndex: options.storeIndex,
      accountScope,
    });
    const ownerApprovalPair = await readOwnerApprovalPair({
      approvalPath: options.ownerApprovalPath,
      approvalShaPath: options.ownerApprovalShaPath,
    });
    const confirmation = options.confirmation;
    if (!confirmation) fail("CLI_CONFIRMATION_REQUIRED", "apply requires --confirm");
    if (confirmation !== buildWalmartNewSkuCatalogActivationConfirmation({
      plan,
      ownerApproval: ownerApprovalPair.approval,
      ownerApprovalArtifactSha256: ownerApprovalPair.artifactSha256,
      now,
      env,
    })) {
      fail(
        "CLI_CONFIRMATION_MISMATCH",
        "--confirm does not bind the exact sealed plan/source/target/store",
      );
    }
    // Establish a writable, new receipt target before the database transaction.
    // If this fails, APPLY cannot mutate the database and strand its receipt.
    const outputDirectory = await createNewPrivateOutputDirectory(
      options.outputDirectory,
    );
    const result = await applyWalmartNewSkuCatalogActivation({
      db,
      plan,
      ownerApproval: ownerApprovalPair.approval,
      ownerApprovalArtifactSha256: ownerApprovalPair.artifactSha256,
      confirmation,
      businessSellerAccountFingerprintSha256:
        accountScope.businessSellerAccountFingerprintSha256,
      activeCaptureCredentialScopeFingerprintSha256:
        accountScope.activeCaptureCredentialScopeFingerprintSha256,
      databaseTargetFingerprintSha256: target.fingerprint,
      environment,
      now,
      ownerTrustEnvironment: env,
      recheckOwnerApproval: async () => {
        const recheckedPair = await readOwnerApprovalPair({
          approvalPath: options.ownerApprovalPath,
          approvalShaPath: options.ownerApprovalShaPath,
        });
        const recheckedScope = currentWalmartAccountScope(env, options.storeIndex);
        return {
          approval: recheckedPair.approval,
          artifactSha256: recheckedPair.artifactSha256,
          ...recheckedScope,
        };
      },
    });
    const receiptBytes = canonicalWalmartItemReportJson(result.receipt);
    const receiptFileSha256 = sha256(receiptBytes);
    await writeExclusive(resolve(outputDirectory, "receipt.json"), receiptBytes);
    await writeExclusive(
      resolve(outputDirectory, "receipt.sha256"),
      `${receiptFileSha256}\n`,
    );
    return {
      status: result.receipt.status,
      owner_codex_only: true,
      receipt_sha256: result.receipt.receipt_sha256,
      receipt_file_sha256: receiptFileSha256,
      database_changed: result.database_changed,
      idempotent_replay: result.idempotent_replay,
      database_access_kind: target.kind,
      walmart_api_calls: 0,
      paid_provider_calls: 0,
      output_directory: outputDirectory,
    };
  } finally {
    db.close();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  runWalmartNewSkuCatalogActivationCli(process.argv.slice(2))
    .then((result) => {
      if ("help" in result) process.stdout.write(`${result.help}\n`);
      else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = error instanceof WalmartNewSkuCatalogActivationCliError ? 64 : 1;
    });
}
