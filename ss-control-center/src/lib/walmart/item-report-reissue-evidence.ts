/**
 * Read-only verifier for the retained evidence that may justify asking an owner
 * for one replacement Walmart ITEM v6 report-create request.
 *
 * This module does not create a permit, contact Walmart, read credentials, or
 * write any artifact. It treats the capture root as a private local custody
 * boundary, opens every relevant file with no-follow semantics, reconstructs
 * the original ambiguous POST and its bounded reconciliation, and returns only
 * the exact ABSENCE_ONLY shape accepted by the reissue-permit contract.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA,
  WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA,
} from "./item-report-capture-session.ts";
import {
  buildWalmartItemReportV6CreateRequestManifest,
  canonicalWalmartItemReportJson,
  walmartItemReportUtf8Sha256,
} from "./item-report-published-source.ts";
import {
  WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA,
  WALMART_ITEM_REPORT_RECONCILIATION_LIMITS,
  WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA,
  WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA,
  WALMART_ITEM_REPORT_RECONCILIATION_SEAL_POLICY,
} from "./item-report-request-reconciliation.ts";
import {
  parseWalmartItemReportReissueSessionAuthority,
  type WalmartItemReportReissueAccountScope,
  type WalmartItemReportReissuePriorAbsenceOnly,
  type WalmartItemReportReissueSessionAuthority,
} from "./item-report-reissue-permit.ts";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_artifact_bytes;
const REQUEST_COMPLETE = "checkpoints/19-request-complete.json";
const CREATE_RESPONSE = "capture/11-create-response.bin";
const CREATE_HTTP = "capture/12-create-response-http.json";
const CREATE_SEAL = "trusted/13-create-exchange-seal.json";

type JsonRecord = Record<string, unknown>;

interface ReadArtifact {
  bytes: Uint8Array;
  sha256: string;
}

interface ReconciliationInventory {
  ids: readonly string[];
  relative_paths: readonly string[];
  scope_ids: readonly string[];
}

export interface WalmartItemReportReissueEvidenceInput {
  allowed_capture_root: string;
  prior_session_name: string;
}

export class WalmartItemReportReissueEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemReportReissueEvidenceError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartItemReportReissueEvidenceError(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail("INVALID_EVIDENCE", `${label} must be an object`);
  return value;
}

function assertExactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_EVIDENCE", `${label} has missing or extra fields`);
  }
}

function exactString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_EVIDENCE", `${label} is invalid`);
  }
  return value;
}

function exactDigest(value: unknown, label: string): string {
  const digest = exactString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    fail("INVALID_EVIDENCE", `${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function literalZero(value: unknown, label: string): 0 {
  if (!Object.is(value, 0)) fail("NOT_ABSENCE_ONLY", `${label} must be literal zero`);
  return 0;
}

function strictInstant(value: unknown, label: string): string {
  const instant = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant)
    || !Number.isFinite(Date.parse(instant))
    || new Date(Date.parse(instant)).toISOString() !== instant) {
    fail("INVALID_EVIDENCE", `${label} must be a canonical UTC instant`);
  }
  return instant;
}

function strictQueryInstant(value: unknown, label: string): string {
  const instant = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(instant)
    || !Number.isFinite(Date.parse(instant))
    || new Date(Date.parse(instant)).toISOString() !== instant.replace(/Z$/u, ".000Z")) {
    fail("INVALID_EVIDENCE", `${label} must be exact second-resolution UTC`);
  }
  return instant;
}

function safeSessionName(value: unknown): string {
  const sessionName = exactString(value, "prior_session_name", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(sessionName)
    || sessionName === "." || sessionName === "..") {
    fail("UNSAFE_SESSION_NAME", "prior_session_name must be one direct-child name");
  }
  return sessionName;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalWalmartItemReportJson(value), "utf8")
    .digest("hex");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}

function assertCanonicalEqual(actual: unknown, expected: unknown, label: string): void {
  if (!sameCanonical(actual, expected)) {
    fail("EVIDENCE_BINDING_MISMATCH", `${label} differs from its exact binding`);
  }
}

function normalizeMacAlias(absolutePath: string): string {
  if (process.platform !== "darwin") return absolutePath;
  for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]] as const) {
    if (absolutePath === alias || absolutePath.startsWith(`${alias}/`)) {
      return `${canonical}${absolutePath.slice(alias.length)}`;
    }
  }
  return absolutePath;
}

async function assertNoSymlinkComponents(absolutePath: string): Promise<void> {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const component of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") fail("MISSING_CAPTURE_DIRECTORY", "capture path is missing");
      throw error;
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("UNSAFE_CAPTURE_DIRECTORY", "capture path components must be real directories");
    }
  }
}

async function assertPrivateRealDirectory(directory: string, label: string): Promise<void> {
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") fail("MISSING_CAPTURE_DIRECTORY", `${label} is missing`);
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || await realpath(directory) !== directory) {
    fail("UNSAFE_CAPTURE_DIRECTORY", `${label} must be a private real directory`);
  }
}

async function resolveSession(input: WalmartItemReportReissueEvidenceInput): Promise<{
  allowedRoot: string;
  sessionDir: string;
  sessionName: string;
}> {
  const allowedInput = exactString(input.allowed_capture_root, "allowed_capture_root", 4096);
  if (!path.isAbsolute(allowedInput)) {
    fail("UNSAFE_CAPTURE_ROOT", "allowed_capture_root must be absolute");
  }
  const allowedRoot = normalizeMacAlias(path.resolve(allowedInput));
  await assertNoSymlinkComponents(allowedRoot);
  await assertPrivateRealDirectory(allowedRoot, "allowed_capture_root");
  const sessionName = safeSessionName(input.prior_session_name);
  const sessionDir = path.join(allowedRoot, sessionName);
  if (path.dirname(sessionDir) !== allowedRoot) {
    fail("UNSAFE_SESSION_NAME", "prior session escaped the allowed capture root");
  }
  await assertPrivateRealDirectory(sessionDir, "prior capture session");
  for (const child of ["capture", "trusted", "checkpoints", "sanitized"] as const) {
    await assertPrivateRealDirectory(path.join(sessionDir, child), `${child} directory`);
  }
  return { allowedRoot, sessionDir, sessionName };
}

function safeRelativePath(relativePath: string): string {
  if (!/^(?:capture|trusted|checkpoints)\/[a-z0-9][a-z0-9.-]{0,220}$/u.test(relativePath)) {
    fail("UNSAFE_ARTIFACT_PATH", "evidence artifact path is unsafe");
  }
  return relativePath;
}

async function artifactPath(sessionDir: string, relativePathInput: string): Promise<string> {
  const relativePath = safeRelativePath(relativePathInput);
  const parent = path.join(sessionDir, path.dirname(relativePath));
  await assertPrivateRealDirectory(parent, "artifact parent");
  const absolute = path.join(sessionDir, relativePath);
  if (path.dirname(absolute) !== parent) {
    fail("UNSAFE_ARTIFACT_PATH", "evidence artifact escaped its private parent");
  }
  return absolute;
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Uint8Array> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(buffer, offset, size - offset, offset);
    if (result.bytesRead === 0) {
      fail("EVIDENCE_READ_RACE", "evidence artifact changed while it was read");
    }
    offset += result.bytesRead;
  }
  return new Uint8Array(buffer);
}

async function secureRead(
  sessionDir: string,
  relativePath: string,
  maximumBytes = MAX_CAPTURE_BYTES,
): Promise<ReadArtifact> {
  const absolute = await artifactPath(sessionDir, relativePath);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(absolute, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") fail("MISSING_EVIDENCE", `${relativePath} is missing`);
    if (error.code === "ELOOP") fail("UNSAFE_EVIDENCE", `${relativePath} must not be a symlink`);
    throw error;
  });
  try {
    const before = await handle.stat();
    const pathBefore = await lstat(absolute);
    if (!before.isFile() || pathBefore.isSymbolicLink() || !pathBefore.isFile()
      || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino
      || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > maximumBytes) {
      fail("UNSAFE_EVIDENCE", `${relativePath} must be a private bounded regular file`);
    }
    const first = await readAt(handle, before.size);
    const middle = await handle.stat();
    const second = await readAt(handle, before.size);
    const after = await handle.stat();
    const pathAfter = await lstat(absolute);
    if (middle.dev !== before.dev || middle.ino !== before.ino || middle.size !== before.size
      || middle.mtimeMs !== before.mtimeMs || middle.ctimeMs !== before.ctimeMs
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
      || !Buffer.from(first).equals(Buffer.from(second))) {
      fail("EVIDENCE_READ_RACE", `${relativePath} changed while it was verified`);
    }
    return { bytes: first, sha256: sha256Bytes(first) };
  } finally {
    await handle.close();
  }
}

async function secureReadOptional(
  sessionDir: string,
  relativePath: string,
  maximumBytes = MAX_CAPTURE_BYTES,
): Promise<ReadArtifact | null> {
  try {
    return await secureRead(sessionDir, relativePath, maximumBytes);
  } catch (error) {
    if (error instanceof WalmartItemReportReissueEvidenceError
      && error.code === "MISSING_EVIDENCE") return null;
    throw error;
  }
}

function parseJsonBytes(bytes: Uint8Array, label: string, requireCanonical = true): JsonRecord {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_EVIDENCE_JSON", `${label} is not UTF-8 JSON`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("INVALID_EVIDENCE_JSON", `${label} is not valid JSON`);
  }
  const record = asRecord(parsed, label);
  if (requireCanonical && text !== canonicalWalmartItemReportJson(record)) {
    fail("NON_CANONICAL_EVIDENCE", `${label} bytes are not canonical JSON`);
  }
  return record;
}

function parseAccountScope(value: unknown, label: string): WalmartItemReportReissueAccountScope {
  const raw = asRecord(value, label);
  assertExactKeys(raw, ["channel", "seller_account_fingerprint_sha256", "store_index"], label);
  if (raw.channel !== "WALMART_US" || !Number.isSafeInteger(raw.store_index)
    || Number(raw.store_index) < 1) {
    fail("INVALID_ACCOUNT_SCOPE", `${label} is invalid`);
  }
  return {
    channel: "WALMART_US",
    store_index: Number(raw.store_index),
    seller_account_fingerprint_sha256: exactDigest(
      raw.seller_account_fingerprint_sha256,
      `${label}.seller_account_fingerprint_sha256`,
    ),
  };
}

async function scanReconciliationInventory(sessionDir: string): Promise<ReconciliationInventory> {
  const ids = new Set<string>();
  const scopeIds = new Set<string>();
  const relativePaths: string[] = [];
  for (const directory of ["capture", "trusted", "checkpoints"] as const) {
    const directoryPath = path.join(sessionDir, directory);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail("UNSAFE_EVIDENCE_INVENTORY", `${directory}/${entry.name} is not a regular file`);
      }
      if (!entry.name.includes("item-request-reconcile-")) continue;
      const idMatch = /^\d{2}-item-request-reconcile-([a-f0-9]{24})(?:-|$)/u.exec(entry.name);
      if (idMatch === null) {
        fail("CONFLICTING_RECONCILIATION", "malformed reconciliation-family artifact exists");
      }
      const id = idMatch[1];
      ids.add(id);
      const relativePath = `${directory}/${entry.name}`;
      relativePaths.push(relativePath);
      if (/^capture\/60-item-request-reconcile-[a-f0-9]{24}-scope\.json$/u.test(relativePath)) {
        scopeIds.add(id);
      }
    }
  }
  return {
    ids: [...ids].sort(),
    relative_paths: relativePaths.sort(),
    scope_ids: [...scopeIds].sort(),
  };
}

function reconciliationNames(id: string) {
  const base = `item-request-reconcile-${id}`;
  const page = "0001";
  return {
    scope: `capture/60-${base}-scope.json`,
    pageRequest: `capture/61-${base}-page-${page}-request.json`,
    pageResponse: `capture/62-${base}-page-${page}-response.bin`,
    pageHttp: `capture/63-${base}-page-${page}-http.json`,
    pageReserved: `checkpoints/61-${base}-page-${page}-reserved.json`,
    pageFailed: `checkpoints/64-${base}-page-${page}-failed.json`,
    pageSeal: `trusted/64-${base}-page-${page}-seal.json`,
    pageComplete: `checkpoints/65-${base}-page-${page}-complete.json`,
    result: `trusted/68-${base}-result.json`,
    complete: `checkpoints/69-${base}-complete.json`,
  } as const;
}

function parseQueryScope(value: unknown): Record<string, string> & {
  reportType: "ITEM";
  reportVersion: "v6";
  src: "API";
  requestSubmissionStartDate: string;
  requestSubmissionEndDate: string;
} {
  const query = asRecord(value, "reconciliation query_scope");
  assertExactKeys(query, [
    "reportType", "reportVersion", "requestSubmissionEndDate",
    "requestSubmissionStartDate", "src",
  ], "reconciliation query_scope");
  if (query.reportType !== "ITEM" || query.reportVersion !== "v6" || query.src !== "API") {
    fail("INVALID_RECONCILIATION_SCOPE", "reconciliation query is not exact ITEM v6 API scope");
  }
  const start = strictQueryInstant(query.requestSubmissionStartDate, "query start");
  const end = strictQueryInstant(query.requestSubmissionEndDate, "query end");
  if (Date.parse(start) > Date.parse(end)
    || Date.parse(end) - Date.parse(start)
      > WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_window_ms) {
    fail("INVALID_RECONCILIATION_SCOPE", "reconciliation query window is unsafe");
  }
  return {
    reportType: "ITEM",
    reportVersion: "v6",
    src: "API",
    requestSubmissionStartDate: start,
    requestSubmissionEndDate: end,
  };
}

function expectedReconciliationId(
  authority: WalmartItemReportReissueSessionAuthority,
  query: ReturnType<typeof parseQueryScope>,
): string {
  return sha256Canonical({
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA,
    session_id: authority.session_id,
    account_scope: authority.account_scope,
    original_create_correlation_sha256: authority.primary_correlations.create.sha256,
    query,
  }).slice(0, 24);
}

function parsePageCorrelation(
  pageManifest: JsonRecord,
  id: string,
  query: ReturnType<typeof parseQueryScope>,
  authority: WalmartItemReportReissueSessionAuthority,
): { id: string; sha256: string } {
  const pageAuthority = asRecord(pageManifest.authority, "page request authority");
  assertExactKeys(pageAuthority, [
    "account_scope", "original_create_correlation_id_sha256",
    "request_correlation_id", "request_correlation_id_sha256",
  ], "page request authority");
  const correlationId = exactString(
    pageAuthority.request_correlation_id,
    "page request correlation ID",
    256,
  );
  const correlationSha = exactDigest(
    pageAuthority.request_correlation_id_sha256,
    "page request correlation SHA-256",
  );
  if (correlationSha !== walmartItemReportUtf8Sha256(correlationId)
    || correlationId === authority.primary_correlations.create.id
    || correlationSha === authority.primary_correlations.create.sha256) {
    fail("INVALID_PAGE_REQUEST", "page request correlation is invalid or reused");
  }
  const expected = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA,
    reconciliation_id: id,
    page_index: 1,
    method: "GET",
    endpoint: "/v3/reports/reportRequests",
    query,
    headers: { accept: "application/json", "accept-encoding": "identity" },
    body: null,
    authority: {
      account_scope: authority.account_scope,
      original_create_correlation_id_sha256: authority.primary_correlations.create.sha256,
      request_correlation_id: correlationId,
      request_correlation_id_sha256: correlationSha,
    },
    safety: { report_create_post: false, request_id_adoption: false },
  };
  assertCanonicalEqual(pageManifest, expected, "page request manifest");
  return { id: correlationId, sha256: correlationSha };
}

function parseExactEmptyResponse(bytes: Uint8Array): void {
  const response = parseJsonBytes(bytes, "reconciliation response", false);
  assertExactKeys(response, ["limit", "page", "requests", "totalCount"], "reconciliation response");
  if (!Object.is(response.page, 1) || !Object.is(response.totalCount, 0)
    || !Object.is(response.limit, 0)
    || !Array.isArray(response.requests) || response.requests.length !== 0) {
    fail("NOT_ABSENCE_ONLY", "response is not the exact observed empty pagination sentinel");
  }
}

function parseHttpMetadata(
  value: JsonRecord,
  response: ReadArtifact,
  correlationSha256: string,
): string {
  assertExactKeys(value, [
    "echoed_correlation_id_sha256", "headers", "observed_at",
    "request_correlation_id_sha256", "response_body_byte_length",
    "response_body_sha256", "schema_version", "status",
  ], "reconciliation HTTP metadata");
  const headers = asRecord(value.headers, "reconciliation HTTP headers");
  for (const [name, headerValue] of Object.entries(headers)) {
    if (name !== name.toLowerCase() || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)
      || typeof headerValue !== "string"
      || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(headerValue)) {
      fail("INVALID_HTTP_EVIDENCE", "reconciliation HTTP headers are invalid");
    }
  }
  const contentLength = headers["content-length"];
  if (contentLength !== undefined
    && (!/^(?:0|[1-9]\d*)$/u.test(String(contentLength))
      || Number(contentLength) !== response.bytes.byteLength)) {
    fail("INVALID_HTTP_EVIDENCE", "HTTP content-length does not bind response bytes");
  }
  const contentType = headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    fail("INVALID_HTTP_EVIDENCE", "HTTP content-type is not JSON");
  }
  const contentEncoding = headers["content-encoding"];
  if (contentEncoding !== undefined && String(contentEncoding).toLowerCase() !== "identity") {
    fail("INVALID_HTTP_EVIDENCE", "compressed reconciliation response is not accepted");
  }
  const underscoreEcho = headers["wm_qos.correlation_id"];
  const hyphenEcho = headers["wm-qos-correlation-id"];
  if (underscoreEcho !== undefined && hyphenEcho !== undefined
    && underscoreEcho !== hyphenEcho) {
    fail("INVALID_HTTP_EVIDENCE", "HTTP correlation echo headers conflict");
  }
  const echoedHeader = underscoreEcho ?? hyphenEcho;
  const expectedEcho = typeof echoedHeader === "string"
    ? walmartItemReportUtf8Sha256(echoedHeader)
    : null;
  if (value.schema_version !== WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA
    || value.status !== 200
    || value.response_body_byte_length !== response.bytes.byteLength
    || value.response_body_sha256 !== response.sha256
    || value.request_correlation_id_sha256 !== correlationSha256
    || value.echoed_correlation_id_sha256 !== expectedEcho) {
    fail("INVALID_HTTP_EVIDENCE", "HTTP metadata does not bind the exact successful GET");
  }
  return strictInstant(value.observed_at, "HTTP observed_at");
}

function expectedPageSeal(
  request: ReadArtifact,
  response: ReadArtifact,
  http: ReadArtifact,
  correlationSha256: string,
): JsonRecord {
  const body = {
    policy_id: WALMART_ITEM_REPORT_RECONCILIATION_SEAL_POLICY,
    request_manifest_sha256: request.sha256,
    request_manifest_byte_length: request.bytes.byteLength,
    request_correlation_id_sha256: correlationSha256,
    response_body_sha256: response.sha256,
    response_body_byte_length: response.bytes.byteLength,
    response_http_sha256: http.sha256,
    response_http_byte_length: http.bytes.byteLength,
  };
  return { ...body, seal_sha256: sha256Canonical(body) };
}

function expectedPageEvidence(
  names: ReturnType<typeof reconciliationNames>,
  request: ReadArtifact,
  response: ReadArtifact,
  http: ReadArtifact,
  seal: ReadArtifact,
) {
  return {
    page_index: 1,
    request_manifest_path: names.pageRequest,
    request_manifest_sha256: request.sha256,
    response_body_path: names.pageResponse,
    response_body_sha256: response.sha256,
    response_http_path: names.pageHttp,
    response_http_sha256: http.sha256,
    exchange_seal_path: names.pageSeal,
    exchange_seal_sha256: seal.sha256,
  } as const;
}

async function assertStillAbsent(sessionDir: string, relativePaths: readonly string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    if (await secureReadOptional(sessionDir, relativePath, MAX_JSON_BYTES) !== null) {
      fail("ORIGINAL_STATE_MUTATED", `${relativePath} must remain absent`);
    }
  }
}

/**
 * Loads and verifies one retained prior session without any write or network
 * capability. The returned object has no caller-supplied hashes: every field is
 * derived from bytes that were opened and checked under the allowed root.
 */
export async function loadWalmartItemReportReissuePriorAbsenceOnly(
  input: WalmartItemReportReissueEvidenceInput,
): Promise<WalmartItemReportReissuePriorAbsenceOnly> {
  const { sessionDir, sessionName } = await resolveSession(input);
  const retained = new Map<string, Uint8Array>();
  const read = async (relativePath: string, maximumBytes = MAX_CAPTURE_BYTES) => {
    const artifact = await secureRead(sessionDir, relativePath, maximumBytes);
    retained.set(relativePath, artifact.bytes);
    return artifact;
  };

  const initialInventory = await scanReconciliationInventory(sessionDir);
  if (initialInventory.relative_paths.some((relativePath) => (
    /^checkpoints\/\d{2}-item-request-reconcile-[a-f0-9]{24}-page-\d{4}-failed\.json$/u
      .test(relativePath)
  ))) {
    fail(
      "RETAINED_TERMINAL_PAGE_FAILURE",
      "a retained terminal page failure cannot be superseded by later recovery artifacts",
    );
  }
  if (initialInventory.ids.length !== 1 || initialInventory.scope_ids.length !== 1
    || initialInventory.ids[0] !== initialInventory.scope_ids[0]) {
    fail(
      "CONFLICTING_RECONCILIATION",
      "prior session must contain exactly one complete reconciliation family",
    );
  }
  const reconciliationId = initialInventory.ids[0];
  const names = reconciliationNames(reconciliationId);

  const authorityArtifact = await read("trusted/00-session-authority.json", MAX_JSON_BYTES);
  const authorityRaw = parseJsonBytes(authorityArtifact.bytes, "SessionAuthority");
  let authority: WalmartItemReportReissueSessionAuthority;
  try {
    authority = parseWalmartItemReportReissueSessionAuthority(authorityRaw);
  } catch {
    fail("INVALID_ORIGINAL_SESSION", "SessionAuthority failed its exact schema validation");
  }
  if (authority.schema_version !== WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA) {
    fail("INVALID_ORIGINAL_SESSION", "SessionAuthority schema is invalid");
  }

  const createArtifact = await read("capture/10-create-request-manifest.json", MAX_JSON_BYTES);
  const createRaw = parseJsonBytes(createArtifact.bytes, "create request manifest");
  const expectedCreate = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: authority.account_scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  });
  assertCanonicalEqual(createRaw, expectedCreate, "create request manifest");

  const reservedArtifact = await read("checkpoints/10-request-reserved.json", MAX_JSON_BYTES);
  const reserved = parseJsonBytes(reservedArtifact.bytes, "request reservation");
  assertExactKeys(reserved, [
    "attempt", "observed_at", "phase", "post_attempt_limit",
    "request_correlation_id_sha256", "request_manifest_sha256", "schema_version", "state",
  ], "request reservation");
  const reservedAt = strictInstant(reserved.observed_at, "request reservation observed_at");
  if (reserved.schema_version !== WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA
    || reserved.phase !== "request" || reserved.state !== "RESERVED"
    || reserved.attempt !== 1 || reserved.post_attempt_limit !== 1
    || reserved.request_correlation_id_sha256 !== authority.primary_correlations.create.sha256
    || reserved.request_manifest_sha256 !== createArtifact.sha256
    || Date.parse(reservedAt) < Date.parse(authority.created_at)) {
    fail("INVALID_ORIGINAL_CHECKPOINT", "reservation does not bind one exact create POST");
  }

  const manualArtifact = await read("checkpoints/19-request-manual-review.json", MAX_JSON_BYTES);
  const manual = parseJsonBytes(manualArtifact.bytes, "request manual review");
  assertExactKeys(manual, [
    "observed_at", "phase", "reason_code", "retry_forbidden", "schema_version", "state",
  ], "request manual review");
  const manualAt = strictInstant(manual.observed_at, "manual review observed_at");
  if (manual.schema_version !== WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA
    || manual.phase !== "request" || manual.state !== "MANUAL_REVIEW"
    || manual.reason_code !== "AMBIGUOUS_POST_NETWORK_OUTCOME"
    || manual.retry_forbidden !== true || Date.parse(manualAt) < Date.parse(reservedAt)) {
    fail("INVALID_ORIGINAL_CHECKPOINT", "original POST is not retry-forbidden ambiguous state");
  }
  await assertStillAbsent(sessionDir, [REQUEST_COMPLETE, CREATE_RESPONSE, CREATE_HTTP, CREATE_SEAL]);

  const scopeArtifact = await read(names.scope, MAX_JSON_BYTES);
  const scope = parseJsonBytes(scopeArtifact.bytes, "reconciliation scope");
  assertExactKeys(scope, [
    "account_scope", "created_at", "limits", "original_ambiguous_post", "query_scope",
    "reconciliation_id", "safety", "schema_version",
  ], "reconciliation scope");
  const scopeAccount = parseAccountScope(scope.account_scope, "scope account_scope");
  const query = parseQueryScope(scope.query_scope);
  const scopeCreatedAt = strictInstant(scope.created_at, "scope created_at");
  if (scope.schema_version !== WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA
    || scope.reconciliation_id !== reconciliationId
    || reconciliationId !== expectedReconciliationId(authority, query)
    || !sameCanonical(scopeAccount, authority.account_scope)
    || Date.parse(scopeCreatedAt) < Date.parse(manualAt)
    || Date.parse(query.requestSubmissionStartDate) > Date.parse(reservedAt)
    || Date.parse(query.requestSubmissionEndDate) < Date.parse(manualAt)) {
    fail("INVALID_RECONCILIATION_SCOPE", "reconciliation scope does not bind the ambiguous POST");
  }
  assertCanonicalEqual(scope.limits, WALMART_ITEM_REPORT_RECONCILIATION_LIMITS, "scope limits");
  assertCanonicalEqual(scope.safety, {
    report_create_post_allowed: false,
    walmart_mutation_allowed: false,
    database_allowed: false,
    model_allowed: false,
    request_id_adoption_allowed: false,
    only_list_report_requests_get: true,
  }, "scope safety");
  assertCanonicalEqual(scope.original_ambiguous_post, {
    session_authority_sha256: authorityArtifact.sha256,
    create_manifest_sha256: createArtifact.sha256,
    request_reserved_sha256: reservedArtifact.sha256,
    manual_review_sha256: manualArtifact.sha256,
    create_correlation_id_sha256: authority.primary_correlations.create.sha256,
    retry_forbidden: true,
  }, "scope original POST binding");

  const pageRequestArtifact = await read(names.pageRequest, MAX_JSON_BYTES);
  const pageRequest = parseJsonBytes(pageRequestArtifact.bytes, "page request manifest");
  const pageCorrelation = parsePageCorrelation(pageRequest, reconciliationId, query, authority);
  const pageReservedArtifact = await read(names.pageReserved, MAX_JSON_BYTES);
  const pageReserved = parseJsonBytes(pageReservedArtifact.bytes, "page reservation checkpoint");
  assertExactKeys(pageReserved, [
    "get_attempt_limit", "observed_at", "page_index", "reconciliation_id",
    "request_correlation_id_sha256", "request_manifest_sha256", "retry_forbidden",
    "schema_version", "state",
  ], "page reservation checkpoint");
  const pageReservedAt = strictInstant(pageReserved.observed_at, "page reservation observed_at");
  if (pageReserved.schema_version !== WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA
    || pageReserved.reconciliation_id !== reconciliationId || pageReserved.page_index !== 1
    || pageReserved.state !== "RESERVED" || pageReserved.get_attempt_limit !== 1
    || pageReserved.retry_forbidden !== true
    || pageReserved.request_manifest_sha256 !== pageRequestArtifact.sha256
    || pageReserved.request_correlation_id_sha256 !== pageCorrelation.sha256
    || Date.parse(pageReservedAt) < Date.parse(scopeCreatedAt)) {
    fail("INVALID_PAGE_CHECKPOINT", "page reservation is not the exact one-shot GET fence");
  }

  const pageResponseArtifact = await read(
    names.pageResponse,
    WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_page_response_bytes,
  );
  parseExactEmptyResponse(pageResponseArtifact.bytes);
  const pageHttpArtifact = await read(names.pageHttp, MAX_JSON_BYTES);
  const pageHttp = parseJsonBytes(pageHttpArtifact.bytes, "page HTTP metadata");
  const pageObservedAt = parseHttpMetadata(
    pageHttp,
    pageResponseArtifact,
    pageCorrelation.sha256,
  );
  if (Date.parse(pageObservedAt) < Date.parse(pageReservedAt)) {
    fail("INVALID_PAGE_CHECKPOINT", "page response predates its GET reservation");
  }

  const pageSealArtifact = await read(names.pageSeal, MAX_JSON_BYTES);
  const pageSeal = parseJsonBytes(pageSealArtifact.bytes, "page exchange seal");
  assertCanonicalEqual(pageSeal, expectedPageSeal(
    pageRequestArtifact,
    pageResponseArtifact,
    pageHttpArtifact,
    pageCorrelation.sha256,
  ), "page exchange seal");

  const pageEvidence = expectedPageEvidence(
    names,
    pageRequestArtifact,
    pageResponseArtifact,
    pageHttpArtifact,
    pageSealArtifact,
  );
  const pageCompleteArtifact = await read(names.pageComplete, MAX_JSON_BYTES);
  const pageComplete = parseJsonBytes(pageCompleteArtifact.bytes, "page completion checkpoint");
  const expectedPageComplete = {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA,
    reconciliation_id: reconciliationId,
    page_index: 1,
    state: "CAPTURED",
    observed_at: pageObservedAt,
    request_manifest_sha256: pageEvidence.request_manifest_sha256,
    response_body_sha256: pageEvidence.response_body_sha256,
    response_http_sha256: pageEvidence.response_http_sha256,
    exchange_seal_sha256: pageEvidence.exchange_seal_sha256,
    recovered_without_network: false,
  };
  assertCanonicalEqual(pageComplete, expectedPageComplete, "page completion checkpoint");

  const resultArtifact = await read(names.result, MAX_JSON_BYTES);
  const result = parseJsonBytes(resultArtifact.bytes, "reconciliation result");
  assertExactKeys(result, [
    "account_scope", "candidate_set", "completed_at", "disposition", "evidence",
    "original_ambiguous_post", "outcome", "query_scope", "reconciliation_id",
    "safety", "schema_version",
  ], "reconciliation result");
  const completedAt = strictInstant(result.completed_at, "reconciliation completed_at");
  if (Date.parse(completedAt) < Date.parse(pageObservedAt)
    || result.schema_version !== WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA
    || result.reconciliation_id !== reconciliationId || result.outcome !== "ABSENCE_ONLY") {
    fail("NOT_ABSENCE_ONLY", "final reconciliation is not a completed ABSENCE_ONLY result");
  }
  assertCanonicalEqual(result.account_scope, authority.account_scope, "result account_scope");
  assertCanonicalEqual(result.query_scope, query, "result query_scope");
  assertCanonicalEqual(result.original_ambiguous_post, {
    session_authority_sha256: authorityArtifact.sha256,
    create_manifest_sha256: createArtifact.sha256,
    request_reserved_sha256: reservedArtifact.sha256,
    manual_review_sha256: manualArtifact.sha256,
    create_correlation_id_sha256: authority.primary_correlations.create.sha256,
    retry_forbidden: true,
    manual_review_preserved: true,
  }, "result original POST binding");
  const evidence = asRecord(result.evidence, "result evidence");
  assertExactKeys(evidence, [
    "observed_row_count", "page_count", "pages", "response_set_sha256",
  ], "result evidence");
  if (evidence.page_count !== 1 || evidence.observed_row_count !== 0
    || !Array.isArray(evidence.pages) || evidence.pages.length !== 1) {
    fail("NOT_ABSENCE_ONLY", "result evidence is not the one-page zero-row proof");
  }
  assertCanonicalEqual(evidence.pages[0], pageEvidence, "result page evidence");
  const responseSetSha256 = exactDigest(evidence.response_set_sha256, "response_set_sha256");
  if (responseSetSha256 !== sha256Canonical([pageEvidence])) {
    fail("EVIDENCE_BINDING_MISMATCH", "response_set_sha256 does not bind exact page evidence");
  }
  const candidateSet = asRecord(result.candidate_set, "result candidate_set");
  assertExactKeys(candidateSet, [
    "candidate_count", "candidates", "duplicate_request_id_count",
    "exact_correlation_match_count", "excluded_different_correlation_count",
  ], "result candidate_set");
  if (candidateSet.candidate_count !== 0 || candidateSet.duplicate_request_id_count !== 0
    || candidateSet.exact_correlation_match_count !== 0
    || candidateSet.excluded_different_correlation_count !== 0
    || !Array.isArray(candidateSet.candidates) || candidateSet.candidates.length !== 0) {
    fail("NOT_ABSENCE_ONLY", "candidate set is not literally empty");
  }
  assertCanonicalEqual(result.disposition, {
    request_id_adopted: false,
    request_complete_written: false,
    owner_disposition_generated: false,
    manual_disposition_generated: false,
  }, "result disposition");
  assertCanonicalEqual(result.safety, {
    report_create_post_calls: 0,
    marketplace_mutations: 0,
    database_calls: 0,
    model_calls: 0,
  }, "result safety accounting");

  const completeArtifact = await read(names.complete, MAX_JSON_BYTES);
  const complete = parseJsonBytes(completeArtifact.bytes, "final reconciliation checkpoint");
  assertExactKeys(complete, [
    "observed_at", "reconciliation_id", "recovered_without_network", "result_path",
    "result_sha256", "schema_version", "state",
  ], "final reconciliation checkpoint");
  if (complete.schema_version !== WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA
    || complete.reconciliation_id !== reconciliationId || complete.state !== "COMPLETE"
    || complete.observed_at !== completedAt || complete.result_path !== names.result
    || complete.result_sha256 !== resultArtifact.sha256
    || complete.recovered_without_network !== false) {
    fail("INVALID_FINAL_CHECKPOINT", "final checkpoint does not bind the exact result");
  }

  const expectedInventoryPaths = [
    names.scope,
    names.pageRequest,
    names.pageResponse,
    names.pageHttp,
    names.pageReserved,
    names.pageSeal,
    names.pageComplete,
    names.result,
    names.complete,
  ].sort();
  if (!sameCanonical(initialInventory.relative_paths, expectedInventoryPaths)) {
    fail("CONFLICTING_RECONCILIATION", "unexpected or incomplete reconciliation artifacts exist");
  }

  for (const [relativePath, originalBytes] of [...retained.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const reread = await secureRead(sessionDir, relativePath, Math.max(1, originalBytes.byteLength));
    if (!Buffer.from(reread.bytes).equals(Buffer.from(originalBytes))) {
      fail("EVIDENCE_READ_RACE", `${relativePath} changed before verification completed`);
    }
  }
  await assertStillAbsent(sessionDir, [REQUEST_COMPLETE, CREATE_RESPONSE, CREATE_HTTP, CREATE_SEAL]);
  const finalInventory = await scanReconciliationInventory(sessionDir);
  if (!sameCanonical(finalInventory, initialInventory)) {
    fail("CONFLICTING_RECONCILIATION", "reconciliation inventory changed during verification");
  }

  return {
    session_name: sessionName,
    session_id: authority.session_id,
    session_authority_sha256: authorityArtifact.sha256,
    create_manifest_sha256: createArtifact.sha256,
    request_reserved_sha256: reservedArtifact.sha256,
    manual_review_sha256: manualArtifact.sha256,
    manual_review_reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME",
    manual_review_retry_forbidden: true,
    reconciliation_id: reconciliationId,
    reconciliation_scope_sha256: scopeArtifact.sha256,
    reconciliation_result_sha256: resultArtifact.sha256,
    reconciliation_complete_sha256: completeArtifact.sha256,
    response_set_sha256: responseSetSha256,
    reconciliation_completed_at: completedAt,
    outcome: "ABSENCE_ONLY",
    observed_row_count: literalZero(evidence.observed_row_count, "observed row count"),
    candidate_count: literalZero(candidateSet.candidate_count, "candidate count"),
    exact_correlation_match_count: literalZero(
      candidateSet.exact_correlation_match_count,
      "exact correlation match count",
    ),
    duplicate_request_id_count: literalZero(
      candidateSet.duplicate_request_id_count,
      "duplicate request ID count",
    ),
    request_id_adopted: false,
    original_request_complete_written: false,
  };
}
