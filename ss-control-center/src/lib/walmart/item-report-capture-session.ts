/**
 * Default-deny, phase-driven capture adapter for the authoritative Walmart ITEM
 * v6 report source. It performs no network I/O itself: every request is routed
 * through a dependency-injected transport. The request reservation is atomic
 * and at-most-once inside one intact owner-permitted local session/custody root;
 * this module does not claim distributed exactly-once across copied permits,
 * deleted sessions, hosts, or independent filesystems.
 *
 * Trust boundary: immutable exchange seals retained under `trusted/` attest that
 * the adapter atomically paired request manifests, response bytes, and HTTP
 * metadata. They are capture-integrity evidence, not Walmart signatures and not
 * independent proof of TLS/server authenticity. The local capture directory is
 * therefore a custody boundary: a same-user actor who can rewrite the retained
 * raw bytes, seals, selections, and context can coherently reseal a false local
 * history. Operational trust requires exclusive custody and external retention;
 * a weak local HMAC would not change that boundary.
 *
 * Compile is intentionally offline: it authenticates itself from the retained
 * SessionAuthority and does not require active Walmart credentials. Every phase
 * that can contact Walmart (request, poll, download) instead requires the active
 * credential-derived account_scope to exactly match SessionAuthority before any
 * network call or phase artifact write.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  WALMART_ITEM_REPORT_LIMITS,
  WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
  buildWalmartItemReportDownloadLocatorRequestManifest,
  buildWalmartItemReportFileRequestManifest,
  buildWalmartItemReportReadyRequestManifest,
  canonicalWalmartItemReportJson,
  compileWalmartItemReportCatalogSource,
  compileWalmartItemReportPublishedSource,
  verifyWalmartItemReportCatalogSourceAgainstCapture,
  verifyWalmartItemReportPublishedSourceAgainstCapture,
  walmartItemReportTrustedExchangeSha256,
  walmartItemReportUtf8Sha256,
  type HttpResponseCaptureMetadata,
  type WalmartItemReportCompileContext,
  type WalmartItemReportFileRedirectInput,
  type WalmartItemReportRequestManifestBinding,
} from "./item-report-published-source.ts";
import {
  WALMART_ITEM_REPORT_REISSUE_CLOCK_SKEW_MS,
  WALMART_ITEM_REPORT_REISSUE_MAX_PERMIT_TTL_MS,
  WalmartItemReportReissuePermitError,
  assertWalmartItemReportReissueOwnerConfirmation,
  parseWalmartItemReportReissuePermitBytes,
  verifyWalmartItemReportReissuePermitBytes,
  type WalmartItemReportReissuePermit,
  type WalmartItemReportReissuePriorAbsenceOnly,
} from "./item-report-reissue-permit.ts";

export const WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA =
  "walmart-item-report-capture-session/v1" as const;
export const WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA =
  "walmart-item-report-capture-checkpoint/v1" as const;

export const WALMART_ITEM_REPORT_CAPTURE_PHASES = [
  "request",
  "poll",
  "download",
  "compile",
] as const;

export type WalmartItemReportCapturePhase = (typeof WALMART_ITEM_REPORT_CAPTURE_PHASES)[number];

export interface WalmartItemReportAtomicTransportRequest {
  kind: "walmart-api" | "presigned-file";
  method: "GET" | "POST";
  endpoint: string | null;
  query: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  body: Uint8Array | null;
  correlation_id: string | null;
  redirect: "manual";
  max_response_bytes: number;
  max_redirect_response_bytes: number;
  timeout_ms: number;
  signal: AbortSignal;
}

export interface WalmartItemReportAtomicTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface WalmartItemReportAtomicTransport {
  send(request: WalmartItemReportAtomicTransportRequest): Promise<WalmartItemReportAtomicTransportResponse>;
}

export interface WalmartItemReportCaptureDependencies {
  transport: WalmartItemReportAtomicTransport;
  now?: () => Date;
  random_uuid?: () => string;
  account_scope?: WalmartItemReportCompileContext["account_scope"];
  request_timeout_ms?: number;
  after_immutable_write?: (relativePath: string) => void | Promise<void>;
}

export interface WalmartItemReportHttpCallCounts {
  oauth_token_calls: number;
  walmart_api_calls: number;
  presigned_file_calls: number;
  total_http_calls: number;
}

export interface WalmartItemReportCaptureRunInput {
  execute: boolean;
  phase: WalmartItemReportCapturePhase;
  store_index: number;
  session_dir: string;
  allowed_capture_root: string;
  owner_reissue_permit?: WalmartItemReportReissueExecutionPermitInput;
}

export interface WalmartItemReportReissueExecutionPermitInput {
  artifact_bytes: Uint8Array;
  expected_artifact_sha256: string;
  expected_permit_sha256: string;
  expected_source_evidence_release_sha256: string;
  owner_confirmation: string;
  prior_absence_only: WalmartItemReportReissuePriorAbsenceOnly;
}

export interface WalmartItemReportCapturePlan {
  mode: "PLAN";
  network_calls: 0;
  filesystem_writes: 0;
  phase: WalmartItemReportCapturePhase;
  store_index: number;
  session_dir: string;
  live_requires: "--execute";
  http_calls: WalmartItemReportHttpCallCounts;
}

export interface WalmartItemReportCaptureRunResult {
  mode: "EXECUTED";
  phase: WalmartItemReportCapturePhase;
  state: string;
  network_calls: number;
  http_calls: WalmartItemReportHttpCallCounts;
  session_dir: string;
  sanitized_source_path: string | null;
  /** Present only for a completed compile receipt. */
  sanitized_source_sha256?: string;
  published_source_id?: string;
  published_source_body_sha256?: string;
  sanitized_catalog_source_path?: string;
  sanitized_catalog_source_sha256?: string;
  catalog_source_id?: string;
  catalog_source_body_sha256?: string;
  compile_checkpoint_path?: string;
  compile_checkpoint_sha256?: string;
}

interface SessionCorrelation {
  id: string;
  sha256: string;
}

interface SessionAuthority {
  schema_version: typeof WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA;
  session_id: string;
  created_at: string;
  account_scope: WalmartItemReportCompileContext["account_scope"];
  primary_correlations: {
    create: SessionCorrelation;
    ready_status: SessionCorrelation;
    download_locator: SessionCorrelation;
    report_file: SessionCorrelation;
  };
  trust_statement: {
    adapter_atomic_integrity: true;
    walmart_signature_claimed: false;
    tls_server_authenticity_claimed_by_artifact: false;
  };
}

interface StoredExchangeSeal {
  policy_id: typeof WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID;
  sha256: string;
}

interface StoredSelection {
  attempt: number;
  request_manifest_path: string;
  response_body_path: string;
  response_http_path: string;
  exchange_seal_path: string;
  observed_at: string;
  request_correlation_id: string;
  request_correlation_id_sha256: string;
  response_body_sha256: string;
  exchange_seal_sha256: string;
}

interface StoredLocatorSelection extends StoredSelection {
  selection_path: string;
  selection_sha256: string;
  request_id_sha256: string;
  download_url_sha256: string;
  download_url_expiration_at: string;
}

interface StoredFileSelection extends StoredSelection {
  locator_binding: {
    attempt: number;
    selection_path: string;
    selection_sha256: string;
    request_manifest_path: string;
    response_body_path: string;
    response_http_path: string;
    exchange_seal_path: string;
    request_correlation_id: string;
    request_correlation_id_sha256: string;
    response_body_sha256: string;
    exchange_seal_sha256: string;
    request_id_sha256: string;
    download_url_sha256: string;
    download_url_expiration_at: string;
  };
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CHANNEL = "WALMART_US" as const;
const CREATE_BODY = new TextEncoder().encode("{}");
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS = 60_000;
export const WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES = 64 * 1024;
export const WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_CHAIN_BYTES = 256 * 1024;

const SESSION_FILE = "trusted/00-session-authority.json";
const OWNER_REISSUE_PERMIT_FILE = "trusted/01-owner-reissue-permit.json";
const REQUEST_RESERVED = "checkpoints/10-request-reserved.json";
const REQUEST_COMPLETE = "checkpoints/19-request-complete.json";
const REQUEST_MANUAL_REVIEW = "checkpoints/19-request-manual-review.json";
const CREATE_MANIFEST = "capture/10-create-request-manifest.json";
const CREATE_RESPONSE = "capture/11-create-response.bin";
const CREATE_HTTP = "capture/12-create-response-http.json";
const CREATE_SEAL = "trusted/13-create-exchange-seal.json";
const READY_SELECTION = "trusted/29-ready-selection.json";
const FILE_SELECTION = "trusted/49-file-selection.json";
const COMPILE_CONTEXT = "trusted/90-compile-context.json";
const SANITIZED_SOURCE = "sanitized/90-item-report-published-source.json";
const SANITIZED_CATALOG_SOURCE = "sanitized/item-report-catalog-source.json";
const COMPILE_COMPLETE = "checkpoints/99-compile-complete.json";

export class WalmartItemReportCaptureError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemReportCaptureError";
    this.code = code;
  }
}

export class WalmartItemReportManualReviewRequiredError extends WalmartItemReportCaptureError {
  constructor(message = "request outcome is ambiguous; manual review is required and POST retry is forbidden") {
    super("MANUAL_REVIEW_REQUIRED", message);
    this.name = "WalmartItemReportManualReviewRequiredError";
  }
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new WalmartItemReportCaptureError("INVALID_INPUT", `${label} must be a non-empty trimmed string`);
  }
  if (/[\x00-\x1f\x7f]/u.test(value)) {
    throw new WalmartItemReportCaptureError("INVALID_INPUT", `${label} contains control characters`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new WalmartItemReportCaptureError("INVALID_INPUT", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function requestTimeoutMs(dependencies: WalmartItemReportCaptureDependencies): number {
  const value = dependencies.request_timeout_ms
    ?? WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1
    || value > WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS) {
    throw new WalmartItemReportCaptureError(
      "INVALID_REQUEST_TIMEOUT",
      `request timeout must be an integer from 1 to ${WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS} ms`,
    );
  }
  return value;
}

function httpCallCounts(
  walmartApiCalls: number,
  presignedFileCalls: number,
  oauthTokenCalls = 0,
): WalmartItemReportHttpCallCounts {
  for (const [label, value] of Object.entries({ walmartApiCalls, presignedFileCalls, oauthTokenCalls })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WalmartItemReportCaptureError("INVALID_HTTP_ACCOUNTING", `${label} is invalid`);
    }
  }
  return {
    oauth_token_calls: oauthTokenCalls,
    walmart_api_calls: walmartApiCalls,
    presigned_file_calls: presignedFileCalls,
    total_http_calls: oauthTokenCalls + walmartApiCalls + presignedFileCalls,
  };
}

async function sendWithDeadline(
  dependencies: WalmartItemReportCaptureDependencies,
  request: Omit<WalmartItemReportAtomicTransportRequest, "signal" | "timeout_ms">,
): Promise<WalmartItemReportAtomicTransportResponse> {
  const timeoutMs = requestTimeoutMs(dependencies);
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new WalmartItemReportCaptureError("REQUEST_TIMEOUT", "capture HTTP attempt exceeded its deadline"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      dependencies.transport.send({
        ...request,
        signal: controller.signal,
        timeout_ms: timeoutMs,
      }),
      timeout,
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function isoNow(dependencies: WalmartItemReportCaptureDependencies): string {
  return captureNow(dependencies).toISOString();
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalWalmartItemReportJson(value));
}

function exactBytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJsonBytes(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WalmartItemReportCaptureError("INVALID_CAPTURE_JSON", `${label} is not valid UTF-8 JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalmartItemReportCaptureError("INVALID_CAPTURE_JSON", `${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function safeRelativePath(relativePath: string): string {
  const parts = relativePath.split("/");
  if (path.isAbsolute(relativePath) || relativePath.includes("\\") || parts.length !== 2
    || !["capture", "trusted", "checkpoints", "sanitized"].includes(parts[0])
    || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new WalmartItemReportCaptureError("UNSAFE_PATH", "capture artifact path is unsafe");
  }
  return relativePath;
}

async function assertPrivateRealDirectory(directory: string, code = "UNSAFE_SESSION_DIRECTORY"): Promise<void> {
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new WalmartItemReportCaptureError(code, "required private directory is missing");
    }
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new WalmartItemReportCaptureError(code, "capture directories must be private real directories");
  }
  const canonical = await realpath(directory);
  if (canonical !== directory) {
    throw new WalmartItemReportCaptureError(code, "capture directory canonical path is inconsistent");
  }
}

async function artifactAbsolutePath(sessionDir: string, relativePathInput: string): Promise<string> {
  const relativePath = safeRelativePath(relativePathInput);
  const parent = path.join(sessionDir, path.dirname(relativePath));
  await assertPrivateRealDirectory(parent, "UNSAFE_ARTIFACT_PARENT");
  const absolute = path.join(sessionDir, relativePath);
  if (path.dirname(absolute) !== parent) {
    throw new WalmartItemReportCaptureError("UNSAFE_PATH", "capture artifact escaped its private parent");
  }
  return absolute;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeImmutable(
  sessionDir: string,
  relativePathInput: string,
  bytes: Uint8Array,
  dependencies: WalmartItemReportCaptureDependencies,
): Promise<void> {
  const relativePath = safeRelativePath(relativePathInput);
  if (!(bytes instanceof Uint8Array)) {
    throw new WalmartItemReportCaptureError("INVALID_ARTIFACT", `${relativePath} must be bytes`);
  }
  const absolute = await artifactAbsolutePath(sessionDir, relativePath);
  const handle = await open(absolute, "wx", FILE_MODE).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || stat.size !== bytes.byteLength) {
        throw new WalmartItemReportCaptureError(
          "IMMUTABLE_ARTIFACT_CONFLICT",
          `${relativePath} exists but is not the exact retained artifact`,
        );
      }
      const existing = new Uint8Array(await readFile(absolute));
      if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
        throw new WalmartItemReportCaptureError(
          "IMMUTABLE_ARTIFACT_CONFLICT",
          `${relativePath} exists with different bytes`,
        );
      }
      return null;
    }
    throw error;
  });
  if (handle === null) return;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(path.dirname(absolute));
  await dependencies.after_immutable_write?.(relativePath);
}

async function writeImmutableJson(
  sessionDir: string,
  relativePath: string,
  value: unknown,
  dependencies: WalmartItemReportCaptureDependencies,
): Promise<void> {
  await writeImmutable(sessionDir, relativePath, jsonBytes(value), dependencies);
}

/**
 * Irreversibly consumes a one-shot action slot. Unlike writeImmutable(), an
 * existing byte-identical file is still a conflict: two concurrent callers must
 * never both interpret the same reservation as permission to send a POST.
 */
async function writeExclusiveReservationJson(
  sessionDir: string,
  relativePathInput: string,
  value: unknown,
  dependencies: WalmartItemReportCaptureDependencies,
): Promise<void> {
  const relativePath = safeRelativePath(relativePathInput);
  const bytes = jsonBytes(value);
  const absolute = await artifactAbsolutePath(sessionDir, relativePath);
  const handle = await open(absolute, "wx", FILE_MODE).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      throw new WalmartItemReportCaptureError(
        "REQUEST_ATTEMPT_ALREADY_RESERVED",
        "the one-shot report-create attempt was already reserved",
      );
    }
    throw error;
  });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(path.dirname(absolute));
  await dependencies.after_immutable_write?.(relativePath);
}

async function fileExists(sessionDir: string, relativePath: string): Promise<boolean> {
  try {
    const stat = await lstat(await artifactAbsolutePath(sessionDir, relativePath));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readImmutable(
  sessionDir: string,
  relativePath: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const absolute = await artifactAbsolutePath(sessionDir, relativePath);
  const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new WalmartItemReportCaptureError("MISSING_ARTIFACT", `${relativePath} is missing`);
    }
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WalmartItemReportCaptureError("UNSAFE_ARTIFACT", `${relativePath} must be a regular non-symlink file`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new WalmartItemReportCaptureError("UNSAFE_ARTIFACT_MODE", `${relativePath} must not be group/world accessible`);
  }
  if (stat.size < 1 || stat.size > maximumBytes) {
    throw new WalmartItemReportCaptureError("ARTIFACT_SIZE_CAP", `${relativePath} exceeds its safety cap`);
  }
  return new Uint8Array(await readFile(absolute));
}

async function readImmutableJson(
  sessionDir: string,
  relativePath: string,
  maximumBytes = 1024 * 1024,
): Promise<Record<string, unknown>> {
  return parseJsonBytes(await readImmutable(sessionDir, relativePath, maximumBytes), relativePath);
}

function normalizeDocumentedMacSystemAlias(absolutePath: string): string {
  if (process.platform !== "darwin") return absolutePath;
  for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]] as const) {
    if (absolutePath === alias || absolutePath.startsWith(`${alias}/`)) {
      return `${canonical}${absolutePath.slice(alias.length)}`;
    }
  }
  return absolutePath;
}

async function assertNoSymlinkDirectoryComponents(
  absolutePath: string,
  allowMissing: boolean,
): Promise<boolean> {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const component of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && allowMissing) return null;
      throw error;
    });
    if (stat === null) return false;
    if (stat.isSymbolicLink()) {
      throw new WalmartItemReportCaptureError(
        "UNSAFE_CAPTURE_ROOT",
        "configured capture root contains a symlink component",
      );
    }
    if (!stat.isDirectory()) {
      throw new WalmartItemReportCaptureError(
        "UNSAFE_CAPTURE_ROOT",
        "configured capture root components must be directories",
      );
    }
  }
  return true;
}

export async function assertWalmartItemReportCaptureSessionDir(
  allowedRootInput: string,
  sessionDirInput: string,
  create: boolean,
): Promise<{ allowedRoot: string; sessionDir: string; created: boolean }> {
  const allowedRoot = normalizeDocumentedMacSystemAlias(
    path.resolve(exactString(allowedRootInput, "allowed_capture_root")),
  );
  const rootExists = await assertNoSymlinkDirectoryComponents(allowedRoot, true);
  if (!rootExists) {
    if (!create) {
      throw new WalmartItemReportCaptureError("MISSING_SESSION", "configured capture root does not exist");
    }
    await mkdir(allowedRoot, { recursive: true, mode: DIRECTORY_MODE });
  }
  await assertNoSymlinkDirectoryComponents(allowedRoot, false);
  const allowedRootReal = await realpath(allowedRoot);
  if (allowedRootReal !== allowedRoot) {
    throw new WalmartItemReportCaptureError(
      "UNSAFE_CAPTURE_ROOT",
      "configured capture root canonical path differs from its approved lexical path",
    );
  }
  await assertPrivateRealDirectory(allowedRootReal, "UNSAFE_CAPTURE_ROOT");

  const requestedSessionDir = normalizeDocumentedMacSystemAlias(
    path.resolve(exactString(sessionDirInput, "session_dir")),
  );
  const sessionName = path.basename(requestedSessionDir);
  if (path.dirname(requestedSessionDir) !== allowedRootReal
    || sessionName.length === 0 || sessionName === ".") {
    throw new WalmartItemReportCaptureError(
      "SESSION_DIR_OUTSIDE_GITIGNORED_ROOT",
      "session_dir must be a direct child of the configured gitignored capture root",
    );
  }
  // Use the canonical parent so platform aliases such as /var -> /private/var do
  // not create two spellings for the same trusted session authority.
  const sessionDir = path.join(allowedRootReal, sessionName);
  let sessionCreated = false;
  let sessionStat = await lstat(sessionDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (sessionStat?.isSymbolicLink()) {
    throw new WalmartItemReportCaptureError("UNSAFE_SESSION_DIRECTORY", "session_dir must not be a symlink");
  }
  if (sessionStat === null) {
    if (!create) {
      throw new WalmartItemReportCaptureError("MISSING_SESSION", "capture session does not exist");
    }
    await mkdir(sessionDir, { mode: DIRECTORY_MODE });
    sessionCreated = true;
    sessionStat = await lstat(sessionDir);
  }
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink() || (sessionStat.mode & 0o077) !== 0) {
    throw new WalmartItemReportCaptureError(
      "UNSAFE_SESSION_DIRECTORY",
      "session_dir must be a private real directory",
    );
  }
  if (await realpath(sessionDir) !== sessionDir) {
    throw new WalmartItemReportCaptureError(
      "UNSAFE_SESSION_DIRECTORY",
      "session_dir canonical path escaped its configured capture root",
    );
  }
  for (const child of ["capture", "trusted", "checkpoints", "sanitized"]) {
    const childPath = path.join(sessionDir, child);
    if (sessionCreated) {
      await mkdir(childPath, { mode: DIRECTORY_MODE });
    }
    await assertPrivateRealDirectory(childPath);
  }
  return { allowedRoot: allowedRootReal, sessionDir, created: sessionCreated };
}

export function computeWalmartSellerAccountFingerprint(input: {
  store_index: number;
  client_id: string;
  seller_id: string;
}): string {
  return walmartItemReportUtf8Sha256(canonicalWalmartItemReportJson({
    channel: CHANNEL,
    store_index: positiveInteger(input.store_index, "store_index"),
    client_id: exactString(input.client_id, "client_id"),
    seller_id: exactString(input.seller_id, "seller_id"),
  }));
}

export function planWalmartItemReportCapturePhase(
  input: WalmartItemReportCaptureRunInput,
): WalmartItemReportCapturePlan {
  if (!(WALMART_ITEM_REPORT_CAPTURE_PHASES as readonly string[]).includes(input.phase)) {
    throw new WalmartItemReportCaptureError("INVALID_PHASE", "phase is invalid");
  }
  return {
    mode: "PLAN",
    network_calls: 0,
    filesystem_writes: 0,
    phase: input.phase,
    store_index: positiveInteger(input.store_index, "store_index"),
    session_dir: path.resolve(exactString(input.session_dir, "session_dir")),
    live_requires: "--execute",
    http_calls: httpCallCounts(0, 0),
  };
}

function binding(
  authority: SessionAuthority,
  correlation: SessionCorrelation,
): WalmartItemReportRequestManifestBinding {
  return {
    account_scope: { ...authority.account_scope },
    request_correlation_id_sha256: correlation.sha256,
  };
}

interface VerifiedRequestPermit {
  permit: WalmartItemReportReissuePermit;
  artifact_bytes: Uint8Array;
  authority: SessionAuthority;
  create_manifest_bytes: Uint8Array;
}

function assertRequestPermitHasPostWindow(
  verifiedPermit: VerifiedRequestPermit,
  dependencies: WalmartItemReportCaptureDependencies,
): void {
  const now = captureNow(dependencies).getTime();
  const freshness = verifiedPermit.permit.body.freshness;
  const issuedAt = Date.parse(freshness.issued_at);
  const freshnessEnd = Math.min(
    Date.parse(freshness.expires_at),
    Date.parse(freshness.prior_evidence_fresh_until),
  );
  const requiredHeadroomMs = requestTimeoutMs(dependencies) + 5_000;
  if (issuedAt > now + WALMART_ITEM_REPORT_REISSUE_CLOCK_SKEW_MS
    || freshnessEnd - now < requiredHeadroomMs
    || requiredHeadroomMs > WALMART_ITEM_REPORT_REISSUE_MAX_PERMIT_TTL_MS) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_PERMIT_INSUFFICIENT_HEADROOM",
      "owner reissue permit is not current or lacks POST timeout headroom",
    );
  }
}

function captureNow(dependencies: WalmartItemReportCaptureDependencies): Date {
  const date = (dependencies.now ?? (() => new Date()))();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new WalmartItemReportCaptureError("INVALID_CLOCK", "capture clock returned an invalid Date");
  }
  return date;
}

function verifyRequestPermitBeforeWrite(
  input: WalmartItemReportCaptureRunInput,
  activeScope: WalmartItemReportCompileContext["account_scope"],
  dependencies: WalmartItemReportCaptureDependencies,
): VerifiedRequestPermit {
  const supplied = input.owner_reissue_permit;
  if (!supplied) {
    throw new WalmartItemReportCaptureError(
      "MISSING_OWNER_REISSUE_PERMIT",
      "live request phase requires one exact externally owner-custodied reissue permit",
    );
  }
  if (!(supplied.artifact_bytes instanceof Uint8Array)) {
    throw new WalmartItemReportCaptureError(
      "INVALID_OWNER_REISSUE_PERMIT",
      "owner reissue permit artifact must be exact bytes",
    );
  }
  const now = captureNow(dependencies);
  let parsed: WalmartItemReportReissuePermit;
  try {
    const embedded = parseWalmartItemReportReissuePermitBytes(supplied.artifact_bytes);
    const preliminary = verifyWalmartItemReportReissuePermitBytes(
      supplied.artifact_bytes,
      {
        expected_artifact_sha256: supplied.expected_artifact_sha256,
        expected_permit_sha256: supplied.expected_permit_sha256,
        expected_source_evidence_release_sha256:
          supplied.expected_source_evidence_release_sha256,
        now,
        account_scope: activeScope,
        prior_absence_only: supplied.prior_absence_only,
        replacement_session_name: path.basename(path.resolve(input.session_dir)),
        replacement_session_authority: embedded.body.replacement.session_authority,
        replacement_create_request_manifest: embedded.body.replacement.create_request_manifest,
      },
    );
    assertWalmartItemReportReissueOwnerConfirmation(
      preliminary,
      supplied.owner_confirmation,
    );
    parsed = preliminary;
  } catch (error) {
    const code = error instanceof WalmartItemReportReissuePermitError
      ? error.code
      : "INVALID_OWNER_REISSUE_PERMIT";
    throw new WalmartItemReportCaptureError(
      code,
      error instanceof Error ? error.message : "owner reissue permit is invalid",
    );
  }
  const replacement = parsed.body.replacement;
  const verified = {
    permit: parsed,
    artifact_bytes: Uint8Array.from(supplied.artifact_bytes),
    authority: replacement.session_authority as SessionAuthority,
    create_manifest_bytes: jsonBytes(replacement.create_request_manifest),
  };
  assertRequestPermitHasPostWindow(verified, dependencies);
  return verified;
}

function newCorrelation(randomUuid: () => string): SessionCorrelation {
  const id = exactString(randomUuid(), "request correlation ID");
  return { id, sha256: walmartItemReportUtf8Sha256(id) };
}

function activeAccountScope(
  storeIndex: number,
  dependencies: WalmartItemReportCaptureDependencies,
): WalmartItemReportCompileContext["account_scope"] {
  if (!dependencies.account_scope || typeof dependencies.account_scope !== "object") {
    throw new WalmartItemReportCaptureError(
      "MISSING_CREDENTIAL_SCOPE",
      "network-capable capture phases require account_scope derived from active credentials",
    );
  }
  const raw = dependencies.account_scope as unknown as Record<string, unknown>;
  const expectedKeys = ["channel", "seller_account_fingerprint_sha256", "store_index"];
  if (Object.keys(raw).sort().join("\u0000") !== expectedKeys.join("\u0000")
    || raw.channel !== CHANNEL || raw.store_index !== storeIndex
    || typeof raw.seller_account_fingerprint_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(raw.seller_account_fingerprint_sha256)) {
    throw new WalmartItemReportCaptureError("INVALID_CREDENTIAL_SCOPE", "active account_scope is invalid");
  }
  return {
    channel: CHANNEL,
    store_index: storeIndex,
    seller_account_fingerprint_sha256: raw.seller_account_fingerprint_sha256,
  };
}

function assertActiveAuthorityMatch(
  authority: SessionAuthority,
  active: WalmartItemReportCompileContext["account_scope"],
): void {
  if (canonicalWalmartItemReportJson(authority.account_scope)
    !== canonicalWalmartItemReportJson(active)) {
    throw new WalmartItemReportCaptureError(
      "ACTIVE_ACCOUNT_SCOPE_MISMATCH",
      "active credential scope does not match the retained SessionAuthority",
    );
  }
}

async function initializeSessionFromPermit(
  sessionDir: string,
  verifiedPermit: VerifiedRequestPermit,
  dependencies: WalmartItemReportCaptureDependencies,
): Promise<SessionAuthority> {
  const authority = verifiedPermit.authority;
  await writeImmutableJson(sessionDir, SESSION_FILE, authority, dependencies);
  return authority;
}

function parseStoredCorrelation(value: unknown, label: string): SessionCorrelation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", `${label} is invalid`);
  }
  const raw = value as Record<string, unknown>;
  const id = exactString(raw.id, `${label}.id`);
  const sha256 = exactString(raw.sha256, `${label}.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(sha256) || sha256 !== walmartItemReportUtf8Sha256(id)) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", `${label} digest is invalid`);
  }
  return { id, sha256 };
}

async function loadSession(sessionDir: string, storeIndex: number): Promise<SessionAuthority> {
  const raw = await readImmutableJson(sessionDir, SESSION_FILE);
  if (raw.schema_version !== WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", "session schema is invalid");
  }
  const account = raw.account_scope as Record<string, unknown>;
  if (!account || account.channel !== CHANNEL || account.store_index !== storeIndex
    || typeof account.seller_account_fingerprint_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(account.seller_account_fingerprint_sha256)) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", "session account scope is invalid or mismatched");
  }
  const correlations = raw.primary_correlations as Record<string, unknown>;
  if (!correlations) throw new WalmartItemReportCaptureError("INVALID_SESSION", "session correlations are missing");
  const authority: SessionAuthority = {
    schema_version: WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA,
    session_id: exactString(raw.session_id, "session_id"),
    created_at: exactString(raw.created_at, "created_at"),
    account_scope: {
      channel: CHANNEL,
      store_index: storeIndex,
      seller_account_fingerprint_sha256: account.seller_account_fingerprint_sha256,
    },
    primary_correlations: {
      create: parseStoredCorrelation(correlations.create, "create correlation"),
      ready_status: parseStoredCorrelation(correlations.ready_status, "ready correlation"),
      download_locator: parseStoredCorrelation(correlations.download_locator, "locator correlation"),
      report_file: parseStoredCorrelation(correlations.report_file, "file correlation"),
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false,
    },
  };
  if (new Set(Object.values(authority.primary_correlations).map((item) => item.sha256)).size !== 4) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", "session correlations are not distinct");
  }
  return authority;
}

function headerValues(headers: Record<string, string>, names: readonly string[]): string[] {
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  return Object.entries(headers)
    .filter(([name]) => accepted.has(name.toLowerCase()))
    .map(([, value]) => exactString(value, "HTTP response header"));
}

function optionalUnambiguousHeader(
  headers: Record<string, string>,
  names: readonly string[],
  label: string,
): string | null {
  const values = headerValues(headers, names);
  if (new Set(values).size > 1) {
    throw new WalmartItemReportCaptureError("CONFLICTING_HTTP_HEADER", `${label} response headers conflict`);
  }
  return values[0] ?? null;
}

function validateAtomicResponse(
  response: WalmartItemReportAtomicTransportResponse,
  maximumBytes: number,
  expectedCorrelation: SessionCorrelation | null,
): { body: Uint8Array; http: HttpResponseCaptureMetadata; location: string | null } {
  if (!response || !Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new WalmartItemReportCaptureError("INVALID_HTTP_RESPONSE", "transport returned an invalid HTTP status");
  }
  if (!(response.body instanceof Uint8Array) || response.body.byteLength > maximumBytes) {
    throw new WalmartItemReportCaptureError("RESPONSE_SIZE_CAP", "HTTP response body exceeds its phase safety cap");
  }
  if (!response.headers || typeof response.headers !== "object" || Array.isArray(response.headers)) {
    throw new WalmartItemReportCaptureError("INVALID_HTTP_RESPONSE", "transport returned invalid HTTP headers");
  }
  const contentEncoding = optionalUnambiguousHeader(
    response.headers,
    ["content-encoding"],
    "Content-Encoding",
  );
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    throw new WalmartItemReportCaptureError(
      "UNSUPPORTED_CONTENT_ENCODING",
      "non-identity HTTP Content-Encoding is forbidden because exact wire bytes cannot be proven",
    );
  }
  const rawLength = optionalUnambiguousHeader(response.headers, ["content-length"], "Content-Length");
  let contentLength: number | null = null;
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) {
      throw new WalmartItemReportCaptureError("INVALID_CONTENT_LENGTH", "HTTP Content-Length is invalid");
    }
    contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength !== response.body.byteLength) {
      throw new WalmartItemReportCaptureError(
        "CONTENT_LENGTH_MISMATCH",
        "HTTP Content-Length does not match exact captured response bytes",
      );
    }
  }
  const contentType = optionalUnambiguousHeader(response.headers, ["content-type"], "Content-Type");
  const echoedCorrelation = optionalUnambiguousHeader(
    response.headers,
    ["wm_qos.correlation_id", "wm-qos-correlation-id"],
    "correlation ID",
  );
  if (expectedCorrelation !== null && echoedCorrelation !== null
    && walmartItemReportUtf8Sha256(echoedCorrelation) !== expectedCorrelation.sha256) {
    throw new WalmartItemReportCaptureError(
      "ECHOED_CORRELATION_MISMATCH",
      "echoed correlation ID conflicts with the exact request correlation",
    );
  }
  const echoedReportRequest = optionalUnambiguousHeader(
    response.headers,
    ["wm_qos.report_request_id", "wm-report-request-id"],
    "report request ID",
  );
  const location = optionalUnambiguousHeader(response.headers, ["location"], "Location");
  return {
    body: new Uint8Array(response.body),
    http: {
      status: response.status,
      content_type: contentType,
      content_length: contentLength,
      echoed_correlation_id_sha256: echoedCorrelation === null
        ? null
        : walmartItemReportUtf8Sha256(echoedCorrelation),
      echoed_report_request_id_sha256: echoedReportRequest === null
        ? null
        : walmartItemReportUtf8Sha256(echoedReportRequest),
    },
    location,
  };
}

function exchangeSeal(
  requestManifestBytes: Uint8Array,
  correlation: SessionCorrelation,
  responseBody: Uint8Array,
  http: HttpResponseCaptureMetadata,
): StoredExchangeSeal {
  return {
    policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
    sha256: walmartItemReportTrustedExchangeSha256({
      request_manifest_bytes: requestManifestBytes,
      request_correlation_id_sha256: correlation.sha256,
      response_payload_bytes: responseBody,
      http,
    }),
  };
}

function checkpoint(phase: string, state: string, observedAt: string, extra: Record<string, unknown> = {}) {
  return {
    schema_version: WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA,
    phase,
    state,
    observed_at: observedAt,
    ...extra,
  };
}

async function listAttemptNumbers(sessionDir: string, prefix: string): Promise<number[]> {
  const names = await readdir(path.join(sessionDir, "checkpoints"));
  const expression = new RegExp(`^${prefix}-(\\d{4})-reserved\\.json$`, "u");
  return names
    .map((name) => expression.exec(name)?.[1] ?? null)
    .filter((value): value is string => value !== null)
    .map(Number)
    .sort((left, right) => left - right);
}

function padAttempt(attempt: number): string {
  return String(attempt).padStart(4, "0");
}

function requestIdFromPayload(bytes: Uint8Array, label: string): string {
  const payload = parseJsonBytes(bytes, label);
  const nested = payload.reportRequest && typeof payload.reportRequest === "object"
    && !Array.isArray(payload.reportRequest)
    ? payload.reportRequest as Record<string, unknown>
    : null;
  const values = [payload.requestId, payload.requestID, nested?.requestId, nested?.requestID]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => exactString(value, `${label} requestId`));
  if (values.length === 0 || new Set(values).size !== 1) {
    throw new WalmartItemReportCaptureError("AMBIGUOUS_REQUEST_ID", `${label} has no single requestId`);
  }
  return values[0];
}

function statusFromPayload(bytes: Uint8Array): string {
  const payload = parseJsonBytes(bytes, "READY status response");
  const nested = payload.reportRequest && typeof payload.reportRequest === "object"
    && !Array.isArray(payload.reportRequest)
    ? payload.reportRequest as Record<string, unknown>
    : null;
  const values = [payload.requestStatus, payload.status, nested?.requestStatus, nested?.status]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => exactString(value, "request status").toUpperCase());
  if (values.length === 0 || new Set(values).size !== 1) {
    throw new WalmartItemReportCaptureError("AMBIGUOUS_REQUEST_STATUS", "status response has no single status");
  }
  return values[0];
}

function locatorFromPayload(bytes: Uint8Array): { url: string; expirationAt: string } {
  const payload = parseJsonBytes(bytes, "download locator response");
  const nested = payload.reportRequest && typeof payload.reportRequest === "object"
    && !Array.isArray(payload.reportRequest)
    ? payload.reportRequest as Record<string, unknown>
    : null;
  const urls = [payload.downloadURL, payload.downloadUrl, nested?.downloadURL, nested?.downloadUrl]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => exactString(value, "downloadURL"));
  if (urls.length === 0 || new Set(urls).size !== 1) {
    throw new WalmartItemReportCaptureError("AMBIGUOUS_DOWNLOAD_URL", "locator has no single downloadURL");
  }
  const expirations = [
    payload.downloadURLExpirationTime,
    payload.downloadUrlExpirationTime,
    nested?.downloadURLExpirationTime,
    nested?.downloadUrlExpirationTime,
  ].filter((value) => value !== undefined && value !== null)
    .map((value) => exactString(value, "downloadURLExpirationTime"));
  const instants = expirations.map((value) => Date.parse(value));
  if (expirations.length === 0 || instants.some((value) => !Number.isFinite(value))
    || new Set(instants).size !== 1) {
    throw new WalmartItemReportCaptureError(
      "AMBIGUOUS_DOWNLOAD_EXPIRATION",
      "locator has no single valid downloadURLExpirationTime",
    );
  }
  return { url: urls[0], expirationAt: new Date(instants[0]).toISOString() };
}

function parseStoredSelection(raw: Record<string, unknown>, relativePath: string): StoredSelection {
  const selection: StoredSelection = {
    attempt: positiveInteger(raw.attempt, `${relativePath}.attempt`),
    request_manifest_path: exactString(raw.request_manifest_path, `${relativePath}.request_manifest_path`),
    response_body_path: exactString(raw.response_body_path, `${relativePath}.response_body_path`),
    response_http_path: exactString(raw.response_http_path, `${relativePath}.response_http_path`),
    exchange_seal_path: exactString(raw.exchange_seal_path, `${relativePath}.exchange_seal_path`),
    observed_at: exactString(raw.observed_at, `${relativePath}.observed_at`),
    request_correlation_id: exactString(raw.request_correlation_id, `${relativePath}.request_correlation_id`),
    request_correlation_id_sha256: exactString(
      raw.request_correlation_id_sha256,
      `${relativePath}.request_correlation_id_sha256`,
    ),
    response_body_sha256: exactString(raw.response_body_sha256, `${relativePath}.response_body_sha256`),
    exchange_seal_sha256: exactString(raw.exchange_seal_sha256, `${relativePath}.exchange_seal_sha256`),
  };
  if (selection.request_correlation_id_sha256
    !== walmartItemReportUtf8Sha256(selection.request_correlation_id)
    || !/^[a-f0-9]{64}$/u.test(selection.response_body_sha256)
    || !/^[a-f0-9]{64}$/u.test(selection.exchange_seal_sha256)) {
    throw new WalmartItemReportCaptureError("INVALID_SELECTION", `${relativePath} correlation digest is invalid`);
  }
  return selection;
}

async function storedSelection(sessionDir: string, relativePath: string): Promise<StoredSelection> {
  return parseStoredSelection(await readImmutableJson(sessionDir, relativePath), relativePath);
}

function locatorSelectionPath(attempt: number): string {
  return `trusted/39-locator-selection-${padAttempt(attempt)}.json`;
}

async function storedLocatorSelection(
  sessionDir: string,
  relativePath: string,
): Promise<StoredLocatorSelection> {
  const bytes = await readImmutable(sessionDir, relativePath, 1024 * 1024);
  const raw = parseJsonBytes(bytes, relativePath);
  const base = parseStoredSelection(raw, relativePath);
  const requestIdSha256 = exactString(raw.request_id_sha256, `${relativePath}.request_id_sha256`);
  const downloadUrlSha256 = exactString(raw.download_url_sha256, `${relativePath}.download_url_sha256`);
  const expirationAt = exactString(
    raw.download_url_expiration_at,
    `${relativePath}.download_url_expiration_at`,
  );
  if (![requestIdSha256, downloadUrlSha256].every((value) => /^[a-f0-9]{64}$/u.test(value))
    || !Number.isFinite(Date.parse(expirationAt))) {
    throw new WalmartItemReportCaptureError("INVALID_LOCATOR_SELECTION", "locator selection binding is invalid");
  }
  return {
    ...base,
    selection_path: relativePath,
    selection_sha256: exactBytesSha256(bytes),
    request_id_sha256: requestIdSha256,
    download_url_sha256: downloadUrlSha256,
    download_url_expiration_at: new Date(Date.parse(expirationAt)).toISOString(),
  };
}

async function latestLocatorSelection(sessionDir: string): Promise<StoredLocatorSelection | null> {
  const names = await readdir(path.join(sessionDir, "trusted"));
  const attempts = names
    .map((name) => /^39-locator-selection-(\d{4})\.json$/u.exec(name)?.[1] ?? null)
    .filter((value): value is string => value !== null)
    .map(Number)
    .sort((left, right) => left - right);
  const attempt = attempts.at(-1);
  return attempt === undefined ? null : storedLocatorSelection(sessionDir, locatorSelectionPath(attempt));
}

async function storedFileSelection(sessionDir: string): Promise<StoredFileSelection> {
  const raw = await readImmutableJson(sessionDir, FILE_SELECTION);
  const base = parseStoredSelection(raw, FILE_SELECTION);
  if (!raw.locator_binding || typeof raw.locator_binding !== "object"
    || Array.isArray(raw.locator_binding)) {
    throw new WalmartItemReportCaptureError("INVALID_FILE_SELECTION", "file locator binding is missing");
  }
  const bindingRaw = raw.locator_binding as Record<string, unknown>;
  const attempt = positiveInteger(bindingRaw.attempt, "file locator binding.attempt");
  const digest = (field: string): string => {
    const value = exactString(bindingRaw[field], `file locator binding.${field}`);
    if (!/^[a-f0-9]{64}$/u.test(value)) {
      throw new WalmartItemReportCaptureError("INVALID_FILE_SELECTION", `file locator ${field} is invalid`);
    }
    return value;
  };
  const artifactPath = (field: string): string => safeRelativePath(
    exactString(bindingRaw[field], `file locator binding.${field}`),
  );
  const selectionPath = artifactPath("selection_path");
  if (selectionPath !== locatorSelectionPath(attempt)) {
    throw new WalmartItemReportCaptureError(
      "INVALID_FILE_SELECTION",
      "file locator selection path does not match its exact attempt",
    );
  }
  const expiration = exactString(
    bindingRaw.download_url_expiration_at,
    "file locator binding.download_url_expiration_at",
  );
  if (!Number.isFinite(Date.parse(expiration))) {
    throw new WalmartItemReportCaptureError("INVALID_FILE_SELECTION", "file locator expiration is invalid");
  }
  return {
    ...base,
    locator_binding: {
      attempt,
      selection_path: selectionPath,
      selection_sha256: digest("selection_sha256"),
      request_manifest_path: artifactPath("request_manifest_path"),
      response_body_path: artifactPath("response_body_path"),
      response_http_path: artifactPath("response_http_path"),
      exchange_seal_path: artifactPath("exchange_seal_path"),
      request_correlation_id: exactString(
        bindingRaw.request_correlation_id,
        "file locator binding.request_correlation_id",
      ),
      request_correlation_id_sha256: digest("request_correlation_id_sha256"),
      response_body_sha256: digest("response_body_sha256"),
      exchange_seal_sha256: digest("exchange_seal_sha256"),
      request_id_sha256: digest("request_id_sha256"),
      download_url_sha256: digest("download_url_sha256"),
      download_url_expiration_at: new Date(Date.parse(expiration)).toISOString(),
    },
  };
}

function fileLocatorBinding(
  locator: StoredLocatorSelection,
): StoredFileSelection["locator_binding"] {
  return {
    attempt: locator.attempt,
    selection_path: locator.selection_path,
    selection_sha256: locator.selection_sha256,
    request_manifest_path: locator.request_manifest_path,
    response_body_path: locator.response_body_path,
    response_http_path: locator.response_http_path,
    exchange_seal_path: locator.exchange_seal_path,
    request_correlation_id: locator.request_correlation_id,
    request_correlation_id_sha256: locator.request_correlation_id_sha256,
    response_body_sha256: locator.response_body_sha256,
    exchange_seal_sha256: locator.exchange_seal_sha256,
    request_id_sha256: locator.request_id_sha256,
    download_url_sha256: locator.download_url_sha256,
    download_url_expiration_at: locator.download_url_expiration_at,
  };
}

async function storedSeal(sessionDir: string, relativePath: string): Promise<StoredExchangeSeal> {
  const raw = await readImmutableJson(sessionDir, relativePath);
  if (raw.policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID
    || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256)) {
    throw new WalmartItemReportCaptureError("INVALID_TRUSTED_SEAL", `${relativePath} is invalid`);
  }
  return { policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID, sha256: raw.sha256 };
}

async function persistResponseAndSeal(input: {
  sessionDir: string;
  requestManifestBytes: Uint8Array;
  responsePath: string;
  httpPath: string;
  sealPath: string;
  response: { body: Uint8Array; http: HttpResponseCaptureMetadata };
  correlation: SessionCorrelation;
  dependencies: WalmartItemReportCaptureDependencies;
}): Promise<StoredExchangeSeal> {
  const seal = exchangeSeal(
    input.requestManifestBytes,
    input.correlation,
    input.response.body,
    input.response.http,
  );
  await writeImmutable(input.sessionDir, input.responsePath, input.response.body, input.dependencies);
  await writeImmutableJson(input.sessionDir, input.httpPath, input.response.http, input.dependencies);
  await writeImmutableJson(input.sessionDir, input.sealPath, seal, input.dependencies);
  return seal;
}

async function assertRequestPreparationInventory(sessionDir: string): Promise<void> {
  const allowed = new Map<string, ReadonlySet<string>>([
    ["capture", new Set([path.basename(CREATE_MANIFEST)])],
    ["trusted", new Set([path.basename(SESSION_FILE), path.basename(OWNER_REISSUE_PERMIT_FILE)])],
    ["checkpoints", new Set()],
    ["sanitized", new Set()],
  ]);
  for (const [directory, allowedNames] of allowed) {
    const names = await readdir(path.join(sessionDir, directory));
    if (names.some((name) => !allowedNames.has(name))) {
      throw new WalmartItemReportCaptureError(
        "TARGET_SESSION_NOT_PRISTINE",
        "replacement request session contains an unexpected pre-reservation artifact",
      );
    }
  }
}

async function executeRequestPhase(
  sessionDir: string,
  dependencies: WalmartItemReportCaptureDependencies,
  retainedAuthority: SessionAuthority | null,
  verifiedPermit: VerifiedRequestPermit,
): Promise<WalmartItemReportCaptureRunResult> {
  if (await fileExists(sessionDir, REQUEST_COMPLETE)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "request phase is already complete");
  }
  if (await fileExists(sessionDir, REQUEST_MANUAL_REVIEW)) {
    throw new WalmartItemReportManualReviewRequiredError();
  }
  if (await fileExists(sessionDir, REQUEST_RESERVED)) {
    await writeImmutableJson(
      sessionDir,
      REQUEST_MANUAL_REVIEW,
      checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
        reason_code: "PREVIOUS_POST_RESERVED_WITHOUT_COMPLETION",
        retry_forbidden: true,
      }),
      dependencies,
    );
    throw new WalmartItemReportManualReviewRequiredError();
  }
  await assertRequestPreparationInventory(sessionDir);
  const authority = retainedAuthority
    ?? await initializeSessionFromPermit(sessionDir, verifiedPermit, dependencies);
  if (canonicalWalmartItemReportJson(authority)
    !== canonicalWalmartItemReportJson(verifiedPermit.authority)) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_SESSION_AUTHORITY_MISMATCH",
      "retained SessionAuthority differs from the exact owner-permitted authority",
    );
  }
  await writeImmutable(
    sessionDir,
    OWNER_REISSUE_PERMIT_FILE,
    verifiedPermit.artifact_bytes,
    dependencies,
  );
  const correlation = authority.primary_correlations.create;
  const manifestBytes = verifiedPermit.create_manifest_bytes;
  await writeImmutable(sessionDir, CREATE_MANIFEST, manifestBytes, dependencies);
  const retainedPermitBytes = await readImmutable(
    sessionDir,
    OWNER_REISSUE_PERMIT_FILE,
    256 * 1024,
  );
  if (!Buffer.from(retainedPermitBytes).equals(Buffer.from(verifiedPermit.artifact_bytes))) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_PERMIT_DRIFT",
      "retained owner reissue permit changed before reservation",
    );
  }
  assertRequestPermitHasPostWindow(verifiedPermit, dependencies);
  await writeExclusiveReservationJson(
    sessionDir,
    REQUEST_RESERVED,
    checkpoint("request", "RESERVED", isoNow(dependencies), {
      attempt: 1,
      post_attempt_limit: 1,
      request_manifest_sha256: walmartItemReportUtf8Sha256(new TextDecoder().decode(manifestBytes)),
      request_correlation_id_sha256: correlation.sha256,
    }),
    dependencies,
  );

  try {
    assertRequestPermitHasPostWindow(verifiedPermit, dependencies);
  } catch (error) {
    await writeImmutableJson(
      sessionDir,
      REQUEST_MANUAL_REVIEW,
      checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
        reason_code: "OWNER_REISSUE_PERMIT_EXPIRED_AFTER_RESERVATION",
        retry_forbidden: true,
        freshness_error_code: error instanceof WalmartItemReportCaptureError
          ? error.code
          : "INVALID_CLOCK",
      }),
      dependencies,
    );
    throw new WalmartItemReportManualReviewRequiredError(
      "owner reissue permit lost POST headroom after reservation; retry is forbidden",
    );
  }

  let rawResponse: WalmartItemReportAtomicTransportResponse;
  try {
    rawResponse = await sendWithDeadline(dependencies, {
      kind: "walmart-api",
      method: "POST",
      endpoint: "/v3/reports/reportRequests",
      query: { reportType: "ITEM", reportVersion: "v6" },
      url: null,
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "content-type": "application/json",
      },
      body: CREATE_BODY,
      correlation_id: correlation.id,
      redirect: "manual",
      max_response_bytes: WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes,
      max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
    });
  } catch {
    await writeImmutableJson(
      sessionDir,
      REQUEST_MANUAL_REVIEW,
      checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
        reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME",
        retry_forbidden: true,
      }),
      dependencies,
    );
    throw new WalmartItemReportManualReviewRequiredError();
  }

  try {
    const response = validateAtomicResponse(
      rawResponse,
      WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes,
      correlation,
    );
    await persistResponseAndSeal({
      sessionDir,
      requestManifestBytes: manifestBytes,
      responsePath: CREATE_RESPONSE,
      httpPath: CREATE_HTTP,
      sealPath: CREATE_SEAL,
      response,
      correlation,
      dependencies,
    });
    if (response.http.status !== 200 && response.http.status !== 201) {
      await writeImmutableJson(
        sessionDir,
        REQUEST_MANUAL_REVIEW,
        checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
          reason_code: "POST_HTTP_FAILURE",
          http_status: response.http.status,
          retry_forbidden: true,
        }),
        dependencies,
      );
      throw new WalmartItemReportManualReviewRequiredError("POST returned a non-success response; retry is forbidden");
    }
    const requestId = requestIdFromPayload(response.body, "create response");
    await writeImmutableJson(
      sessionDir,
      REQUEST_COMPLETE,
      checkpoint("request", "COMPLETE", isoNow(dependencies), {
        request_id: requestId,
        request_manifest_path: CREATE_MANIFEST,
        response_body_path: CREATE_RESPONSE,
        response_http_path: CREATE_HTTP,
        exchange_seal_path: CREATE_SEAL,
      }),
      dependencies,
    );
    return {
      mode: "EXECUTED",
      phase: "request",
      state: "REQUESTED",
      network_calls: 1,
      http_calls: httpCallCounts(1, 0),
      session_dir: sessionDir,
      sanitized_source_path: null,
    };
  } catch (error) {
    if (error instanceof WalmartItemReportManualReviewRequiredError) throw error;
    if (!(await fileExists(sessionDir, REQUEST_MANUAL_REVIEW))) {
      await writeImmutableJson(
        sessionDir,
        REQUEST_MANUAL_REVIEW,
        checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
          reason_code: "POST_RESPONSE_CAPTURE_INVALID",
          retry_forbidden: true,
        }),
        dependencies,
      );
    }
    throw new WalmartItemReportManualReviewRequiredError("POST response capture is invalid; retry is forbidden");
  }
}

function requestIdFromCheckpoint(raw: Record<string, unknown>): string {
  return exactString(raw.request_id, "request checkpoint request_id");
}

async function executePollPhase(
  sessionDir: string,
  authority: SessionAuthority,
  dependencies: WalmartItemReportCaptureDependencies,
): Promise<WalmartItemReportCaptureRunResult> {
  if (!(await fileExists(sessionDir, REQUEST_COMPLETE))) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "poll requires a completed request phase");
  }
  if (await fileExists(sessionDir, READY_SELECTION)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "READY status is already captured");
  }
  const requestId = requestIdFromCheckpoint(await readImmutableJson(sessionDir, REQUEST_COMPLETE));
  const attempts = await listAttemptNumbers(sessionDir, "20-poll");
  const attempt = (attempts.at(-1) ?? 0) + 1;
  const correlation = attempt === 1
    ? authority.primary_correlations.ready_status
    : newCorrelation(dependencies.random_uuid ?? randomUUID);
  const stem = `20-poll-${padAttempt(attempt)}`;
  const reservedPath = `checkpoints/${stem}-reserved.json`;
  const manifestPath = `capture/${stem}-request-manifest.json`;
  const responsePath = `capture/${stem}-response.bin`;
  const httpPath = `capture/${stem}-response-http.json`;
  const sealPath = `trusted/${stem}-exchange-seal.json`;
  const completePath = `checkpoints/${stem}-complete.json`;
  const failedPath = `checkpoints/${stem}-failed.json`;
  const manifestBytes = jsonBytes(buildWalmartItemReportReadyRequestManifest(
    requestId,
    binding(authority, correlation),
  ));
  // The append-only reservation is the authority for a dynamic GET attempt's
  // correlation. Persist it before the manifest so a crash can advance to a
  // fresh retry rather than regenerate different bytes at the same path.
  await writeImmutableJson(
    sessionDir,
    reservedPath,
    checkpoint("poll", "RESERVED", isoNow(dependencies), {
      attempt,
      get_attempt_limit: 1,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256,
    }),
    dependencies,
  );
  await writeImmutable(sessionDir, manifestPath, manifestBytes, dependencies);
  let rawResponse: WalmartItemReportAtomicTransportResponse;
  try {
    rawResponse = await sendWithDeadline(dependencies, {
      kind: "walmart-api",
      method: "GET",
      endpoint: `/v3/reports/reportRequests/${encodeURIComponent(requestId)}`,
      query: {},
      url: null,
      headers: { accept: "application/json", "accept-encoding": "identity" },
      body: null,
      correlation_id: correlation.id,
      redirect: "manual",
      max_response_bytes: WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes,
      max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
    });
  } catch {
    await writeImmutableJson(
      sessionDir,
      failedPath,
      checkpoint("poll", "FAILED", isoNow(dependencies), {
        attempt,
        reason_code: "GET_NETWORK_FAILURE",
        safe_to_retry_next_invocation: true,
      }),
      dependencies,
    );
    throw new WalmartItemReportCaptureError("GET_ATTEMPT_FAILED", "poll GET failed; retry requires a new invocation");
  }
  const response = validateAtomicResponse(rawResponse, WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes, correlation);
  const seal = await persistResponseAndSeal({
    sessionDir,
    requestManifestBytes: manifestBytes,
    responsePath,
    httpPath,
    sealPath,
    response,
    correlation,
    dependencies,
  });
  if (response.http.status !== 200) {
    await writeImmutableJson(
      sessionDir,
      failedPath,
      checkpoint("poll", "FAILED", isoNow(dependencies), {
        attempt,
        reason_code: "GET_HTTP_FAILURE",
        http_status: response.http.status,
        safe_to_retry_next_invocation: true,
      }),
      dependencies,
    );
    throw new WalmartItemReportCaptureError("GET_ATTEMPT_FAILED", "poll GET returned non-200; retry needs a new invocation");
  }
  const status = statusFromPayload(response.body);
  const observedAt = isoNow(dependencies);
  await writeImmutableJson(
    sessionDir,
    completePath,
    checkpoint("poll", "COMPLETE", observedAt, { attempt, request_status: status }),
    dependencies,
  );
  if (status === "READY") {
    const selection: StoredSelection = {
      attempt,
      request_manifest_path: manifestPath,
      response_body_path: responsePath,
      response_http_path: httpPath,
      exchange_seal_path: sealPath,
      observed_at: observedAt,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256,
      response_body_sha256: exactBytesSha256(response.body),
      exchange_seal_sha256: seal.sha256,
    };
    await writeImmutableJson(sessionDir, READY_SELECTION, selection, dependencies);
  }
  return {
    mode: "EXECUTED",
    phase: "poll",
    state: status === "READY" ? "READY" : "NOT_READY",
    network_calls: 1,
    http_calls: httpCallCounts(1, 0),
    session_dir: sessionDir,
    sanitized_source_path: null,
  };
}

async function captureLocator(
  sessionDir: string,
  authority: SessionAuthority,
  requestId: string,
  dependencies: WalmartItemReportCaptureDependencies,
  forceRefresh: boolean,
): Promise<{ selection: StoredLocatorSelection; networkCalls: number }> {
  const retained = await latestLocatorSelection(sessionDir);
  if (retained !== null && !forceRefresh
    && retained.request_id_sha256 === walmartItemReportUtf8Sha256(requestId)
    && Date.parse(retained.download_url_expiration_at) > Date.parse(isoNow(dependencies))) {
    return { selection: retained, networkCalls: 0 };
  }
  const attempts = await listAttemptNumbers(sessionDir, "30-locator");
  const attempt = (attempts.at(-1) ?? 0) + 1;
  const correlation = attempt === 1
    ? authority.primary_correlations.download_locator
    : newCorrelation(dependencies.random_uuid ?? randomUUID);
  const stem = `30-locator-${padAttempt(attempt)}`;
  const reservedPath = `checkpoints/${stem}-reserved.json`;
  const manifestPath = `capture/${stem}-request-manifest.json`;
  const responsePath = `capture/${stem}-response-private.bin`;
  const httpPath = `capture/${stem}-response-http.json`;
  const sealPath = `trusted/${stem}-exchange-seal.json`;
  const failedPath = `checkpoints/${stem}-failed.json`;
  const manifestBytes = jsonBytes(buildWalmartItemReportDownloadLocatorRequestManifest(
    requestId,
    binding(authority, correlation),
  ));
  await writeImmutableJson(
    sessionDir,
    reservedPath,
    checkpoint("download_locator", "RESERVED", isoNow(dependencies), {
      attempt,
      get_attempt_limit: 1,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256,
    }),
    dependencies,
  );
  await writeImmutable(sessionDir, manifestPath, manifestBytes, dependencies);
  let rawResponse: WalmartItemReportAtomicTransportResponse;
  try {
    rawResponse = await sendWithDeadline(dependencies, {
      kind: "walmart-api",
      method: "GET",
      endpoint: "/v3/reports/downloadReport",
      query: { requestId },
      url: null,
      headers: { accept: "application/json", "accept-encoding": "identity" },
      body: null,
      correlation_id: correlation.id,
      redirect: "manual",
      max_response_bytes: WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes,
      max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
    });
  } catch {
    await writeImmutableJson(
      sessionDir,
      failedPath,
      checkpoint("download_locator", "FAILED", isoNow(dependencies), {
        attempt,
        reason_code: "GET_NETWORK_FAILURE",
        safe_to_retry_next_invocation: true,
      }),
      dependencies,
    );
    throw new WalmartItemReportCaptureError(
      "GET_ATTEMPT_FAILED",
      "download locator GET failed; retry requires a new invocation",
    );
  }
  const response = validateAtomicResponse(
    rawResponse,
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes,
    correlation,
  );
  const seal = await persistResponseAndSeal({
    sessionDir,
    requestManifestBytes: manifestBytes,
    responsePath,
    httpPath,
    sealPath,
    response,
    correlation,
    dependencies,
  });
  if (response.http.status !== 200) {
    await writeImmutableJson(
      sessionDir,
      failedPath,
      checkpoint("download_locator", "FAILED", isoNow(dependencies), {
        attempt,
        reason_code: "GET_HTTP_FAILURE",
        http_status: response.http.status,
        safe_to_retry_next_invocation: true,
      }),
      dependencies,
    );
    throw new WalmartItemReportCaptureError("GET_ATTEMPT_FAILED", "download locator returned non-200");
  }
  const locator = locatorFromPayload(response.body);
  if (requestIdFromPayload(response.body, "download locator response") !== requestId) {
    throw new WalmartItemReportCaptureError(
      "LOCATOR_REQUEST_ID_MISMATCH",
      "download locator response does not match the retained READY requestId",
    );
  }
  buildWalmartItemReportFileRequestManifest({
    ...binding(authority, authority.primary_correlations.report_file),
    locator_url: locator.url,
  });
  const observedAt = isoNow(dependencies);
  const selectionRecord = {
    attempt,
    request_manifest_path: manifestPath,
    response_body_path: responsePath,
    response_http_path: httpPath,
    exchange_seal_path: sealPath,
    observed_at: observedAt,
    request_correlation_id: correlation.id,
    request_correlation_id_sha256: correlation.sha256,
    response_body_sha256: exactBytesSha256(response.body),
    exchange_seal_sha256: seal.sha256,
    request_id_sha256: walmartItemReportUtf8Sha256(requestId),
    download_url_sha256: walmartItemReportUtf8Sha256(locator.url),
    download_url_expiration_at: locator.expirationAt,
  };
  const selectionPath = locatorSelectionPath(attempt);
  const selectionBytes = jsonBytes(selectionRecord);
  await writeImmutable(sessionDir, selectionPath, selectionBytes, dependencies);
  return {
    selection: {
      ...selectionRecord,
      selection_path: selectionPath,
      selection_sha256: exactBytesSha256(selectionBytes),
    },
    networkCalls: 1,
  };
}

async function captureReportFile(
  sessionDir: string,
  authority: SessionAuthority,
  locatorSelection: StoredLocatorSelection,
  dependencies: WalmartItemReportCaptureDependencies,
): Promise<{ selection: StoredFileSelection; networkCalls: number }> {
  if (await fileExists(sessionDir, FILE_SELECTION)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "report file is already captured");
  }
  const locatorBody = await readImmutable(
    sessionDir,
    locatorSelection.response_body_path,
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes,
  );
  if (exactBytesSha256(locatorBody) !== locatorSelection.response_body_sha256) {
    throw new WalmartItemReportCaptureError(
      "LOCATOR_SELECTION_BODY_MISMATCH",
      "selected locator response bytes do not match the exact retained locator binding",
    );
  }
  const retainedLocatorSeal = await storedSeal(sessionDir, locatorSelection.exchange_seal_path);
  if (retainedLocatorSeal.sha256 !== locatorSelection.exchange_seal_sha256) {
    throw new WalmartItemReportCaptureError(
      "LOCATOR_SELECTION_SEAL_MISMATCH",
      "selected locator exchange seal does not match the exact retained locator binding",
    );
  }
  const locator = locatorFromPayload(locatorBody);
  if (walmartItemReportUtf8Sha256(locator.url) !== locatorSelection.download_url_sha256
    || locator.expirationAt !== locatorSelection.download_url_expiration_at) {
    throw new WalmartItemReportCaptureError(
      "LOCATOR_SELECTION_URL_MISMATCH",
      "selected locator URL metadata does not match its exact retained response",
    );
  }
  const beforeRequestAt = isoNow(dependencies);
  if (Date.parse(locator.expirationAt) <= Date.parse(beforeRequestAt)) {
    throw new WalmartItemReportCaptureError(
      "DOWNLOAD_URL_EXPIRED",
      "retained download URL expired; retry download to acquire a new append-only locator",
    );
  }
  const attempts = await listAttemptNumbers(sessionDir, "40-file");
  const attempt = (attempts.at(-1) ?? 0) + 1;
  const correlation = attempt === 1
    ? authority.primary_correlations.report_file
    : newCorrelation(dependencies.random_uuid ?? randomUUID);
  const stem = `40-file-${padAttempt(attempt)}`;
  const reservedPath = `checkpoints/${stem}-reserved.json`;
  const manifestPath = `capture/${stem}-request-manifest.json`;
  const sealPath = `trusted/${stem}-exchange-seal.json`;
  const failedPath = `checkpoints/${stem}-failed.json`;
  await writeImmutableJson(
    sessionDir,
    reservedPath,
    checkpoint("download_file", "RESERVED", beforeRequestAt, {
      attempt,
      request_chain_attempt_limit_per_url: 1,
      initial_url_sha256: walmartItemReportUtf8Sha256(locator.url),
      locator_selection_path: locatorSelection.selection_path,
      locator_selection_sha256: locatorSelection.selection_sha256,
      locator_attempt: locatorSelection.attempt,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256,
    }),
    dependencies,
  );

  const redirects: WalmartItemReportFileRedirectInput[] = [];
  let currentUrl = locator.url;
  let networkCalls = 0;
  let aggregateRedirectBytes = 0;
  for (let hop = 0; hop <= WALMART_ITEM_REPORT_LIMITS.max_redirects; hop += 1) {
    buildWalmartItemReportFileRequestManifest({
      ...binding(authority, correlation),
      locator_url: locator.url,
      redirects,
    });
    let rawResponse: WalmartItemReportAtomicTransportResponse;
    try {
      networkCalls += 1;
      rawResponse = await sendWithDeadline(dependencies, {
        kind: "presigned-file",
        method: "GET",
        endpoint: null,
        query: {},
        url: currentUrl,
        headers: {
          accept: "application/octet-stream,text/csv,text/tab-separated-values",
          "accept-encoding": "identity",
        },
        body: null,
        correlation_id: null,
        redirect: "manual",
        max_response_bytes: WALMART_ITEM_REPORT_LIMITS.max_transport_bytes,
        max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
      });
    } catch {
      await writeImmutableJson(
        sessionDir,
        failedPath,
        checkpoint("download_file", "FAILED", isoNow(dependencies), {
          attempt,
          reason_code: "GET_NETWORK_FAILURE",
          safe_to_retry_next_invocation: true,
        }),
        dependencies,
      );
      throw new WalmartItemReportCaptureError(
        "GET_ATTEMPT_FAILED",
        "presigned file GET failed; retry requires a new invocation",
      );
    }
    const response = validateAtomicResponse(
      rawResponse,
      WALMART_ITEM_REPORT_LIMITS.max_transport_bytes,
      null,
    );
    const isRedirect = REDIRECT_STATUSES.has(response.http.status);
    if (isRedirect) {
      if (response.body.byteLength > WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES) {
        throw new WalmartItemReportCaptureError(
          "REDIRECT_BODY_CAP",
          "presigned redirect response exceeded its small-body safety cap",
        );
      }
      aggregateRedirectBytes += response.body.byteLength;
      if (aggregateRedirectBytes > WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_CHAIN_BYTES) {
        throw new WalmartItemReportCaptureError(
          "REDIRECT_CHAIN_BYTE_CAP",
          "presigned redirect chain exceeded its aggregate byte safety cap",
        );
      }
    }
    const hopName = `${stem}-hop-${String(hop).padStart(2, "0")}`;
    const hopBodyPath = `capture/${hopName}-response-private.bin`;
    const hopHttpPath = `capture/${hopName}-response-http.json`;
    const hopPrivatePath = `capture/${hopName}-url-private.json`;
    await writeImmutable(sessionDir, hopBodyPath, response.body, dependencies);
    await writeImmutableJson(sessionDir, hopHttpPath, response.http, dependencies);
    await writeImmutableJson(sessionDir, hopPrivatePath, {
      request_url: currentUrl,
      response_location: response.location,
    }, dependencies);

    if (isRedirect) {
      if (response.location === null) {
        throw new WalmartItemReportCaptureError("REDIRECT_WITHOUT_LOCATION", "redirect response has no Location header");
      }
      if (hop >= WALMART_ITEM_REPORT_LIMITS.max_redirects) {
        throw new WalmartItemReportCaptureError("REDIRECT_CAP", "presigned download exceeded redirect safety cap");
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(response.location, currentUrl).toString();
      } catch {
        throw new WalmartItemReportCaptureError("INVALID_REDIRECT", "redirect Location is invalid");
      }
      const redirect = {
        status: response.http.status as WalmartItemReportFileRedirectInput["status"],
        from_url: currentUrl,
        to_url: nextUrl,
      };
      buildWalmartItemReportFileRequestManifest({
        ...binding(authority, correlation),
        locator_url: locator.url,
        redirects: [...redirects, redirect],
      });
      redirects.push(redirect);
      currentUrl = nextUrl;
      continue;
    }
    if (response.http.status !== 200) {
      await writeImmutableJson(
        sessionDir,
        failedPath,
        checkpoint("download_file", "FAILED", isoNow(dependencies), {
          attempt,
          reason_code: "GET_HTTP_FAILURE",
          http_status: response.http.status,
          safe_to_retry_next_invocation: true,
        }),
        dependencies,
      );
      throw new WalmartItemReportCaptureError("GET_ATTEMPT_FAILED", "presigned file GET returned non-200");
    }
    if (response.body.byteLength === 0) {
      throw new WalmartItemReportCaptureError("EMPTY_REPORT_FILE", "downloaded report file is empty");
    }
    const manifestBytes = jsonBytes(buildWalmartItemReportFileRequestManifest({
      ...binding(authority, correlation),
      locator_url: locator.url,
      redirects,
    }));
    const seal = exchangeSeal(manifestBytes, correlation, response.body, response.http);
    await writeImmutable(sessionDir, manifestPath, manifestBytes, dependencies);
    await writeImmutableJson(sessionDir, sealPath, seal, dependencies);
    const observedAt = isoNow(dependencies);
    if (Date.parse(locator.expirationAt) < Date.parse(observedAt)) {
      throw new WalmartItemReportCaptureError(
        "DOWNLOAD_URL_EXPIRED_DURING_TRANSFER",
        "download completed after the retained URL expiration",
      );
    }
    const selection: StoredFileSelection = {
      attempt,
      request_manifest_path: manifestPath,
      response_body_path: hopBodyPath,
      response_http_path: hopHttpPath,
      exchange_seal_path: sealPath,
      observed_at: observedAt,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256,
      response_body_sha256: exactBytesSha256(response.body),
      exchange_seal_sha256: seal.sha256,
      locator_binding: fileLocatorBinding(locatorSelection),
    };
    await writeImmutableJson(sessionDir, FILE_SELECTION, selection, dependencies);
    return { selection, networkCalls };
  }
  throw new WalmartItemReportCaptureError("REDIRECT_CAP", "presigned download exceeded redirect safety cap");
}

async function executeDownloadPhase(
  sessionDir: string,
  authority: SessionAuthority,
  dependencies: WalmartItemReportCaptureDependencies,
): Promise<WalmartItemReportCaptureRunResult> {
  if (!(await fileExists(sessionDir, READY_SELECTION))) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "download requires a captured READY response");
  }
  if (await fileExists(sessionDir, FILE_SELECTION)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "download phase is already complete");
  }
  const requestId = requestIdFromCheckpoint(await readImmutableJson(sessionDir, REQUEST_COMPLETE));
  const priorFileAttempts = await listAttemptNumbers(sessionDir, "40-file");
  const locator = await captureLocator(
    sessionDir,
    authority,
    requestId,
    dependencies,
    priorFileAttempts.length > 0,
  );
  const reportFile = await captureReportFile(sessionDir, authority, locator.selection, dependencies);
  const calls = httpCallCounts(locator.networkCalls, reportFile.networkCalls);
  return {
    mode: "EXECUTED",
    phase: "download",
    state: "DOWNLOADED",
    network_calls: calls.total_http_calls,
    http_calls: calls,
    session_dir: sessionDir,
    sanitized_source_path: null,
  };
}

function parseStoredHttp(raw: Record<string, unknown>, label: string): HttpResponseCaptureMetadata {
  const status = positiveInteger(raw.status, `${label}.status`);
  const contentType = raw.content_type === null ? null : exactString(raw.content_type, `${label}.content_type`);
  let contentLength: number | null;
  if (raw.content_length === null) contentLength = null;
  else if (Number.isSafeInteger(raw.content_length) && Number(raw.content_length) >= 0) {
    contentLength = Number(raw.content_length);
  } else throw new WalmartItemReportCaptureError("INVALID_HTTP_METADATA", `${label}.content_length is invalid`);
  const parseDigest = (value: unknown, field: string): string | null => {
    if (value === null) return null;
    const digest = exactString(value, `${label}.${field}`);
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      throw new WalmartItemReportCaptureError("INVALID_HTTP_METADATA", `${label}.${field} is invalid`);
    }
    return digest;
  };
  return {
    status,
    content_type: contentType,
    content_length: contentLength,
    echoed_correlation_id_sha256: parseDigest(
      raw.echoed_correlation_id_sha256,
      "echoed_correlation_id_sha256",
    ),
    echoed_report_request_id_sha256: parseDigest(
      raw.echoed_report_request_id_sha256,
      "echoed_report_request_id_sha256",
    ),
  };
}

async function executeCompilePhase(
  sessionDir: string,
  storeIndex: number,
  dependencies: WalmartItemReportCaptureDependencies,
): Promise<WalmartItemReportCaptureRunResult> {
  if (!(await fileExists(sessionDir, FILE_SELECTION))) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "compile requires a completed download phase");
  }
  const authority = await loadSession(sessionDir, storeIndex);
  const ready = await storedSelection(sessionDir, READY_SELECTION);
  const file = await storedFileSelection(sessionDir);
  const locator = await storedLocatorSelection(sessionDir, file.locator_binding.selection_path);
  if (canonicalWalmartItemReportJson(file.locator_binding)
    !== canonicalWalmartItemReportJson(fileLocatorBinding(locator))) {
    throw new WalmartItemReportCaptureError(
      "FILE_LOCATOR_BACK_REFERENCE_MISMATCH",
      "FILE_SELECTION does not bind the exact retained locator attempt",
    );
  }
  const fileReserved = await readImmutableJson(
    sessionDir,
    `checkpoints/40-file-${padAttempt(file.attempt)}-reserved.json`,
  );
  if (fileReserved.locator_selection_path !== locator.selection_path
    || fileReserved.locator_selection_sha256 !== locator.selection_sha256
    || fileReserved.locator_attempt !== locator.attempt) {
    throw new WalmartItemReportCaptureError(
      "FILE_LOCATOR_RESERVATION_MISMATCH",
      "file reservation does not bind the exact retained locator selection",
    );
  }
  const createSeal = await storedSeal(sessionDir, CREATE_SEAL);
  const readySeal = await storedSeal(sessionDir, ready.exchange_seal_path);
  const locatorSeal = await storedSeal(sessionDir, locator.exchange_seal_path);
  const fileSeal = await storedSeal(sessionDir, file.exchange_seal_path);
  const readyBody = await readImmutable(
    sessionDir,
    ready.response_body_path,
    WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes,
  );
  const locatorBody = await readImmutable(
    sessionDir,
    locator.response_body_path,
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes,
  );
  const fileBody = await readImmutable(
    sessionDir,
    file.response_body_path,
    WALMART_ITEM_REPORT_LIMITS.max_transport_bytes,
  );
  if (exactBytesSha256(readyBody) !== ready.response_body_sha256
    || readySeal.sha256 !== ready.exchange_seal_sha256
    || exactBytesSha256(locatorBody) !== locator.response_body_sha256
    || locatorSeal.sha256 !== locator.exchange_seal_sha256
    || exactBytesSha256(fileBody) !== file.response_body_sha256
    || fileSeal.sha256 !== file.exchange_seal_sha256) {
    throw new WalmartItemReportCaptureError(
      "SELECTION_ARTIFACT_BINDING_MISMATCH",
      "retained selection does not match its exact response bytes and trusted seal",
    );
  }
  const context: WalmartItemReportCompileContext = {
    account_scope: { ...authority.account_scope },
    request_correlations: {
      create_sha256: authority.primary_correlations.create.sha256,
      ready_status_sha256: ready.request_correlation_id_sha256,
      download_locator_sha256: locator.request_correlation_id_sha256,
      report_file_sha256: file.request_correlation_id_sha256,
    },
    trusted_exchange_seals: {
      create_response_sha256: createSeal.sha256,
      ready_status_response_sha256: readySeal.sha256,
      download_locator_response_sha256: locatorSeal.sha256,
      download_response_sha256: fileSeal.sha256,
    },
    ready_at: ready.observed_at,
    download_locator_at: locator.observed_at,
    report_file_requested_at: exactString(fileReserved.observed_at, "file reservation observed_at"),
    downloaded_at: file.observed_at,
  };
  await writeImmutableJson(sessionDir, COMPILE_CONTEXT, context, dependencies);

  const capture = {
    create_request_manifest_bytes: await readImmutable(
      sessionDir,
      CREATE_MANIFEST,
      WALMART_ITEM_REPORT_LIMITS.max_create_request_bytes,
    ),
    create_response_payload_bytes: await readImmutable(
      sessionDir,
      CREATE_RESPONSE,
      WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes,
    ),
    ready_status_request_manifest_bytes: await readImmutable(
      sessionDir,
      ready.request_manifest_path,
      WALMART_ITEM_REPORT_LIMITS.max_ready_request_bytes,
    ),
    ready_status_payload_bytes: readyBody,
    download_locator_request_manifest_bytes: await readImmutable(
      sessionDir,
      locator.request_manifest_path,
      WALMART_ITEM_REPORT_LIMITS.max_download_locator_request_bytes,
    ),
    download_locator_response_payload_bytes: locatorBody,
    report_file_request_manifest_bytes: await readImmutable(
      sessionDir,
      file.request_manifest_path,
      WALMART_ITEM_REPORT_LIMITS.max_report_file_request_bytes,
    ),
    downloaded_body_bytes: fileBody,
    http: {
      create_response: parseStoredHttp(await readImmutableJson(sessionDir, CREATE_HTTP), "create HTTP"),
      ready_status_response: parseStoredHttp(
        await readImmutableJson(sessionDir, ready.response_http_path),
        "READY HTTP",
      ),
      download_locator_response: parseStoredHttp(
        await readImmutableJson(sessionDir, locator.response_http_path),
        "locator HTTP",
      ),
      download_response: parseStoredHttp(
        await readImmutableJson(sessionDir, file.response_http_path),
        "download HTTP",
      ),
    },
  };
  const source = compileWalmartItemReportPublishedSource(capture, context);
  verifyWalmartItemReportPublishedSourceAgainstCapture(source, capture, context);
  const catalogSource = compileWalmartItemReportCatalogSource(capture, context);
  verifyWalmartItemReportCatalogSourceAgainstCapture(
    catalogSource,
    capture,
    context,
  );
  if (
    catalogSource.published_source.source_id !== source.source_id ||
    catalogSource.published_source.body_sha256 !== source.body_sha256
  ) {
    throw new WalmartItemReportCaptureError(
      "CATALOG_PUBLISHED_SOURCE_BINDING_MISMATCH",
      "all-status catalog source does not bind the exact verified PUBLISHED source",
    );
  }
  const sanitizedBytes = jsonBytes(source);
  const sanitizedCatalogBytes = jsonBytes(catalogSource);
  const sanitizedSourceSha256 = exactBytesSha256(sanitizedBytes);
  const sanitizedCatalogSourceSha256 = exactBytesSha256(sanitizedCatalogBytes);
  const locatorPrivate = locatorFromPayload(capture.download_locator_response_payload_bytes);
  const sanitizedText = new TextDecoder().decode(sanitizedBytes);
  const sanitizedCatalogText = new TextDecoder().decode(sanitizedCatalogBytes);
  if (
    [sanitizedText, sanitizedCatalogText].some(
      (value) => value.includes(locatorPrivate.url) ||
        /(?:X-Amz-|X-Goog-|[?&](?:sig|signature|token)=)/iu.test(value),
    )
  ) {
    throw new WalmartItemReportCaptureError(
      "SANITIZATION_FAILURE",
      "sanitized source artifacts contain presigned URL material",
    );
  }
  await writeImmutable(sessionDir, SANITIZED_SOURCE, sanitizedBytes, dependencies);
  await writeImmutable(
    sessionDir,
    SANITIZED_CATALOG_SOURCE,
    sanitizedCatalogBytes,
    dependencies,
  );
  if (await fileExists(sessionDir, COMPILE_COMPLETE)) {
    const retainedComplete = await readImmutableJson(sessionDir, COMPILE_COMPLETE);
    if (retainedComplete.phase !== "compile" || retainedComplete.state !== "COMPLETE"
      || retainedComplete.source_id !== source.source_id
      || retainedComplete.body_sha256 !== source.body_sha256
      || retainedComplete.strongest_capture_aware_verifier !== true
      || retainedComplete.sanitized_source_path !== SANITIZED_SOURCE
      || retainedComplete.sanitized_source_sha256 !== sanitizedSourceSha256
      || retainedComplete.catalog_source_id !== catalogSource.source_id
      || retainedComplete.catalog_body_sha256 !== catalogSource.body_sha256
      || retainedComplete.catalog_strongest_capture_aware_verifier !== true
      || retainedComplete.sanitized_catalog_source_path !== SANITIZED_CATALOG_SOURCE
      || retainedComplete.sanitized_catalog_source_sha256 !== sanitizedCatalogSourceSha256
      || retainedComplete.network_calls !== 0) {
      throw new WalmartItemReportCaptureError(
        "COMPILE_CHECKPOINT_MISMATCH",
        "retained compile checkpoint does not match the strongest verified source",
      );
    }
  } else {
    await writeImmutableJson(
      sessionDir,
      COMPILE_COMPLETE,
      checkpoint("compile", "COMPLETE", isoNow(dependencies), {
        source_id: source.source_id,
        body_sha256: source.body_sha256,
        strongest_capture_aware_verifier: true,
        sanitized_source_path: SANITIZED_SOURCE,
        sanitized_source_sha256: sanitizedSourceSha256,
        catalog_source_id: catalogSource.source_id,
        catalog_body_sha256: catalogSource.body_sha256,
        catalog_strongest_capture_aware_verifier: true,
        sanitized_catalog_source_path: SANITIZED_CATALOG_SOURCE,
        sanitized_catalog_source_sha256: sanitizedCatalogSourceSha256,
        network_calls: 0,
      }),
      dependencies,
    );
  }
  const compileCheckpointBytes = await readImmutable(
    sessionDir,
    COMPILE_COMPLETE,
    1024 * 1024,
  );
  const calls = httpCallCounts(0, 0);
  return {
    mode: "EXECUTED",
    phase: "compile",
    state: "COMPILED",
    network_calls: calls.total_http_calls,
    http_calls: calls,
    session_dir: sessionDir,
    sanitized_source_path: path.join(sessionDir, SANITIZED_SOURCE),
    sanitized_source_sha256: sanitizedSourceSha256,
    published_source_id: source.source_id,
    published_source_body_sha256: source.body_sha256,
    sanitized_catalog_source_path: path.join(
      sessionDir,
      SANITIZED_CATALOG_SOURCE,
    ),
    sanitized_catalog_source_sha256: sanitizedCatalogSourceSha256,
    catalog_source_id: catalogSource.source_id,
    catalog_source_body_sha256: catalogSource.body_sha256,
    compile_checkpoint_path: path.join(sessionDir, COMPILE_COMPLETE),
    compile_checkpoint_sha256: exactBytesSha256(compileCheckpointBytes),
  };
}

export async function runWalmartItemReportCapturePhase(
  input: WalmartItemReportCaptureRunInput,
  dependencies: WalmartItemReportCaptureDependencies,
): Promise<WalmartItemReportCapturePlan | WalmartItemReportCaptureRunResult> {
  const plan = planWalmartItemReportCapturePhase(input);
  if (!input.execute) return plan;
  const phase = input.phase;
  const storeIndex = positiveInteger(input.store_index, "store_index");
  if (phase !== "request" && input.owner_reissue_permit !== undefined) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_PERMIT_PHASE_MISMATCH",
      "owner reissue permit is valid only for the request phase",
    );
  }
  // Validate active credential scope before a network-capable phase can create
  // even its local session directory. Compile is the documented offline exception.
  const activeScope = phase === "compile" ? null : activeAccountScope(storeIndex, dependencies);
  let verifiedPermit: VerifiedRequestPermit | null = null;
  if (phase === "request") {
    if (activeScope === null) {
      throw new WalmartItemReportCaptureError(
        "MISSING_CREDENTIAL_SCOPE",
        "request phase requires active Walmart credential scope",
      );
    }
    verifiedPermit = verifyRequestPermitBeforeWrite(input, activeScope, dependencies);
  }
  const { sessionDir, created } = await assertWalmartItemReportCaptureSessionDir(
    input.allowed_capture_root,
    input.session_dir,
    phase === "request",
  );
  const retainedAuthority = created ? null : await loadSession(sessionDir, storeIndex);
  if (activeScope !== null && retainedAuthority !== null) {
    assertActiveAuthorityMatch(retainedAuthority, activeScope);
  }
  if (phase === "request") {
    if (verifiedPermit === null) {
      throw new WalmartItemReportCaptureError(
        "MISSING_OWNER_REISSUE_PERMIT",
        "request phase permit verification did not complete",
      );
    }
    return executeRequestPhase(sessionDir, dependencies, retainedAuthority, verifiedPermit);
  }
  if (retainedAuthority === null) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", "existing session authority is required");
  }
  if (phase === "poll") return executePollPhase(sessionDir, retainedAuthority, dependencies);
  if (phase === "download") return executeDownloadPhase(sessionDir, retainedAuthority, dependencies);
  return executeCompilePhase(sessionDir, storeIndex, dependencies);
}
