/**
 * Strict, read-only reconciliation for an ambiguous Walmart ITEM v6 create
 * request. This adapter never creates a report, never adopts a requestId, and
 * never changes the original capture-session state. Its only Walmart operation
 * is a bounded GET /v3/reports/reportRequests query (plus OAuth in the CLI
 * transport).
 *
 * Every GET is reserved before transport. A reservation without a complete,
 * sealed response is terminal and is never replayed automatically. Completed
 * page captures can be resumed offline after a crash.
 *
 * Primary API contract reviewed 2026-07-19:
 * https://developer.walmart.com/us-marketplace/reference/getrequestsstatus
 * https://developer.walmart.com/us-marketplace/docs/on-request-reports-api-overview
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA,
  WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA,
  WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS,
  assertWalmartItemReportCaptureSessionDir,
  type WalmartItemReportAtomicTransport,
  type WalmartItemReportAtomicTransportRequest,
  type WalmartItemReportAtomicTransportResponse,
} from "./item-report-capture-session.ts";
import {
  buildWalmartItemReportV6CreateRequestManifest,
  canonicalWalmartItemReportJson,
} from "./item-report-published-source.ts";

export const WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA =
  "walmart-item-report-request-reconciliation/v1" as const;
export const WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA =
  "walmart-item-report-request-reconciliation-page/v1" as const;
export const WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA =
  "walmart-item-report-request-reconciliation-checkpoint/v1" as const;
export const WALMART_ITEM_REPORT_RECONCILIATION_SEAL_POLICY =
  "walmart-item-report-request-reconciliation-seal/1.0.0" as const;

export const WALMART_ITEM_REPORT_RECONCILIATION_LIMITS = Object.freeze({
  max_window_ms: 15 * 60 * 1000,
  report_history_ms: 30 * 24 * 60 * 60 * 1000,
  future_clock_skew_ms: 5 * 60 * 1000,
  max_pages: 32,
  max_rows: 10_000,
  max_page_response_bytes: 2 * 1024 * 1024,
  max_total_response_bytes: 16 * 1024 * 1024,
  max_cursor_characters: 4_096,
  max_advertised_page_limit: 1_000,
  max_artifact_bytes: 4 * 1024 * 1024,
  request_timeout_ms: 60_000,
});

export const WALMART_ITEM_REPORT_RECONCILIATION_OUTCOMES = [
  "EXACT_MATCH",
  "CANDIDATE_ONLY",
  "ABSENCE_ONLY",
  "AMBIGUOUS",
] as const;

export type WalmartItemReportReconciliationOutcome =
  (typeof WALMART_ITEM_REPORT_RECONCILIATION_OUTCOMES)[number];

export interface WalmartItemReportRequestReconciliationInput {
  execute: boolean;
  store_index: number;
  session_dir: string;
  allowed_capture_root: string;
  request_submission_start_date: string | null;
  request_submission_end_date: string | null;
}

export interface WalmartItemReportRequestReconciliationDependencies {
  transport: WalmartItemReportAtomicTransport;
  account_scope?: {
    channel: "WALMART_US";
    store_index: number;
    seller_account_fingerprint_sha256: string;
  };
  now?: () => Date;
  random_uuid?: () => string;
  request_timeout_ms?: number;
  after_immutable_write?: (relativePath: string) => void | Promise<void>;
}

export interface WalmartItemReportRequestReconciliationPlan {
  mode: "PLAN";
  network_calls: 0;
  filesystem_writes: 0;
  store_index: number;
  session_dir: string;
  request_submission_start_date: string | null;
  request_submission_end_date: string | null;
  live_requires: "--execute";
  allowed_network_operations: readonly [
    "POST https://marketplace.walmartapis.com/v3/token",
    "GET https://marketplace.walmartapis.com/v3/reports/reportRequests",
  ];
  marketplace_mutations: 0;
}

export interface WalmartItemReportRequestReconciliationResult {
  mode: "EXECUTED";
  state: "RECONCILED";
  outcome: WalmartItemReportReconciliationOutcome;
  reconciliation_id: string;
  network_calls: number;
  http_calls: {
    oauth_token_calls: number;
    walmart_api_calls: number;
    presigned_file_calls: number;
    total_http_calls: number;
  };
  page_count: number;
  observed_row_count: number;
  candidate_count: number;
  exact_correlation_match_count: number;
  duplicate_request_id_count: number;
  session_dir: string;
  result_artifact_path: string;
  original_request_complete_written: false;
  request_id_adopted: false;
}

interface AccountScope {
  channel: "WALMART_US";
  store_index: number;
  seller_account_fingerprint_sha256: string;
}

interface SessionCorrelation {
  id: string;
  sha256: string;
}

interface SessionAuthority {
  schema_version: typeof WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA;
  session_id: string;
  created_at: string;
  account_scope: AccountScope;
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

interface OriginalAmbiguousRequest {
  authority: SessionAuthority;
  authority_sha256: string;
  create_manifest_sha256: string;
  reserved_sha256: string;
  manual_review_sha256: string;
  reserved_at: string;
  manual_review_at: string;
}

type QueryScope = Record<string, string> & {
  reportType: "ITEM";
  reportVersion: "v6";
  src: "API";
  requestSubmissionStartDate: string;
  requestSubmissionEndDate: string;
};

interface NormalizedRequestRow {
  page_index: number;
  row_index: number;
  request_id_sha256: string;
  request_submission_date: string;
  request_status: string | null;
  correlation_evidence: "EXACT" | "ABSENT" | "DIFFERENT";
}

interface ParsedPage {
  page_index: number;
  rows: NormalizedRequestRow[];
  advertised_page: number | null;
  advertised_limit: number | null;
  advertised_total_count: number | null;
  next_cursor: string | null;
}

interface PageEvidence {
  page_index: number;
  request_manifest_path: string;
  request_manifest_sha256: string;
  response_body_path: string;
  response_body_sha256: string;
  response_http_path: string;
  response_http_sha256: string;
  exchange_seal_path: string;
  exchange_seal_sha256: string;
}

interface RetainedFinalResult {
  bytes: Uint8Array;
  value: Record<string, unknown>;
  completed_at: string;
}

interface RetainedPageFailure {
  state: "AMBIGUOUS_GET" | "HTTP_REVIEW_REQUIRED" | "PARSE_REVIEW_REQUIRED";
  reason_code: string;
  observed_at: string;
}

const FILE_MODE = 0o600;
const SESSION_AUTHORITY = "trusted/00-session-authority.json";
const CREATE_MANIFEST = "capture/10-create-request-manifest.json";
const REQUEST_RESERVED = "checkpoints/10-request-reserved.json";
const REQUEST_MANUAL_REVIEW = "checkpoints/19-request-manual-review.json";
const REQUEST_COMPLETE = "checkpoints/19-request-complete.json";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class WalmartItemReportRequestReconciliationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemReportRequestReconciliationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartItemReportRequestReconciliationError(code, message);
}

function exactString(value: unknown, label: string, maximum = 16_384): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("INVALID_INPUT", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("MALFORMED_RESPONSE", `${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARTIFACT", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  code = "INVALID_ARTIFACT",
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} has an unexpected shape`);
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256String(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalWalmartItemReportJson(value));
}

function parseJsonBytes(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(bytes));
  } catch {
    fail("INVALID_JSON", `${label} is not valid UTF-8 JSON`);
  }
  return asRecord(value, label);
}

function strictCanonicalInstant(value: unknown, label: string): string {
  const raw = exactString(value, label, 64);
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== raw) {
    fail("INVALID_ARTIFACT", `${label} must be a canonical ISO-8601 instant`);
  }
  return raw;
}

function strictQueryInstant(value: unknown, label: string): string {
  const raw = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(raw)) {
    fail("INVALID_TIME_BOUND", `${label} must use YYYY-MM-DDTHH:mm:ssZ`);
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== raw.replace(/Z$/u, ".000Z")) {
    fail("INVALID_TIME_BOUND", `${label} is not a real UTC instant`);
  }
  return raw;
}

function clockNow(dependencies: WalmartItemReportRequestReconciliationDependencies): Date {
  const value = (dependencies.now ?? (() => new Date()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("INVALID_CLOCK", "reconciliation clock is invalid");
  }
  return value;
}

function validateWindow(
  startInput: string | null,
  endInput: string | null,
  original: OriginalAmbiguousRequest | null,
  now: Date | null,
): { start: string; end: string } {
  if (startInput === null || endInput === null) {
    fail("LIVE_FLAGS_REQUIRED", "live execution requires exact request-submission start and end dates");
  }
  const start = strictQueryInstant(startInput, "request submission start date");
  const end = strictQueryInstant(endInput, "request submission end date");
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (startMs > endMs || endMs - startMs > WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_window_ms) {
    fail("UNSAFE_TIME_WINDOW", "request-submission window is reversed or exceeds 15 minutes");
  }
  if (original !== null) {
    const reservedMs = Date.parse(original.reserved_at);
    const manualMs = Date.parse(original.manual_review_at);
    if (startMs > reservedMs || endMs < manualMs) {
      fail("SCOPE_MISMATCH", "request-submission window does not contain the exact ambiguous POST interval");
    }
  }
  if (now !== null) {
    const nowMs = now.getTime();
    if (startMs < nowMs - WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.report_history_ms
      || endMs > nowMs + WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.future_clock_skew_ms) {
      fail("UNSAFE_TIME_WINDOW", "request-submission window is outside the retrievable 30-day history");
    }
  }
  return { start, end };
}

function validateAccountScope(value: unknown, storeIndex: number, label: string): AccountScope {
  const raw = asRecord(value, label);
  assertExactKeys(raw, ["channel", "seller_account_fingerprint_sha256", "store_index"], label);
  if (raw.channel !== "WALMART_US" || raw.store_index !== storeIndex
    || typeof raw.seller_account_fingerprint_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(raw.seller_account_fingerprint_sha256)) {
    fail("INVALID_ACCOUNT_SCOPE", `${label} is invalid`);
  }
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    seller_account_fingerprint_sha256: raw.seller_account_fingerprint_sha256,
  };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}

function safeArtifactPath(relativePath: string): string {
  if (!/^(?:capture|trusted|checkpoints)\/[a-z0-9][a-z0-9.-]{0,220}$/u.test(relativePath)) {
    fail("UNSAFE_PATH", "reconciliation artifact path is unsafe");
  }
  return relativePath;
}

async function assertPrivateParent(sessionDir: string, relativePath: string): Promise<string> {
  const safe = safeArtifactPath(relativePath);
  const parent = path.join(sessionDir, path.dirname(safe));
  const stat = await lstat(parent).catch(() => fail("UNSAFE_ARTIFACT_PARENT", "artifact parent is missing"));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || await realpath(parent) !== parent) {
    fail("UNSAFE_ARTIFACT_PARENT", "artifact parent must be a private real directory");
  }
  const absolute = path.join(sessionDir, safe);
  if (path.dirname(absolute) !== parent) fail("UNSAFE_PATH", "artifact escaped its private parent");
  return absolute;
}

async function secureRead(
  sessionDir: string,
  relativePath: string,
  maximumBytes = WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_artifact_bytes,
): Promise<Uint8Array> {
  const absolute = await assertPrivateParent(sessionDir, relativePath);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(absolute, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") fail("MISSING_ARTIFACT", "required reconciliation artifact is missing");
    if (error.code === "ELOOP") fail("UNSAFE_ARTIFACT", "artifact must not be a symlink");
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > maximumBytes) {
      fail("UNSAFE_ARTIFACT", "artifact is not a private bounded regular file");
    }
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function secureReadOptional(
  sessionDir: string,
  relativePath: string,
  maximumBytes = WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_artifact_bytes,
): Promise<Uint8Array | null> {
  try {
    return await secureRead(sessionDir, relativePath, maximumBytes);
  } catch (error) {
    if (error instanceof WalmartItemReportRequestReconciliationError
      && error.code === "MISSING_ARTIFACT") return null;
    throw error;
  }
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
  relativePath: string,
  bytes: Uint8Array,
  dependencies: WalmartItemReportRequestReconciliationDependencies,
): Promise<void> {
  const absolute = await assertPrivateParent(sessionDir, relativePath);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
    | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(absolute, flags, FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await secureRead(sessionDir, relativePath, Math.max(1, bytes.byteLength));
    if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
      fail("IMMUTABLE_ARTIFACT_CONFLICT", "existing reconciliation artifact has different bytes");
    }
    return;
  }
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
  dependencies: WalmartItemReportRequestReconciliationDependencies,
): Promise<void> {
  await writeImmutable(sessionDir, relativePath, canonicalBytes(value), dependencies);
}

function parseCorrelation(value: unknown, label: string): SessionCorrelation {
  const raw = asRecord(value, label);
  assertExactKeys(raw, ["id", "sha256"], label);
  const id = exactString(raw.id, `${label}.id`, 256);
  const sha256 = exactString(raw.sha256, `${label}.sha256`, 64);
  if (!/^[a-f0-9]{64}$/u.test(sha256) || sha256 !== sha256String(id)) {
    fail("INVALID_SESSION", `${label} digest is invalid`);
  }
  return { id, sha256 };
}

async function loadSessionAuthority(sessionDir: string, storeIndex: number): Promise<{
  authority: SessionAuthority;
  bytes: Uint8Array;
}> {
  const bytes = await secureRead(sessionDir, SESSION_AUTHORITY, 1024 * 1024);
  const raw = parseJsonBytes(bytes, "SessionAuthority");
  assertExactKeys(raw, [
    "schema_version", "session_id", "created_at", "account_scope",
    "primary_correlations", "trust_statement",
  ], "SessionAuthority");
  if (raw.schema_version !== WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA) {
    fail("INVALID_SESSION", "SessionAuthority schema is invalid");
  }
  const correlations = asRecord(raw.primary_correlations, "SessionAuthority correlations");
  assertExactKeys(correlations, ["create", "download_locator", "ready_status", "report_file"],
    "SessionAuthority correlations");
  const trust = asRecord(raw.trust_statement, "SessionAuthority trust statement");
  assertExactKeys(trust, [
    "adapter_atomic_integrity", "tls_server_authenticity_claimed_by_artifact",
    "walmart_signature_claimed",
  ], "SessionAuthority trust statement");
  if (trust.adapter_atomic_integrity !== true
    || trust.walmart_signature_claimed !== false
    || trust.tls_server_authenticity_claimed_by_artifact !== false) {
    fail("INVALID_SESSION", "SessionAuthority trust statement is invalid");
  }
  const authority: SessionAuthority = {
    schema_version: WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA,
    session_id: exactString(raw.session_id, "SessionAuthority session_id", 256),
    created_at: strictCanonicalInstant(raw.created_at, "SessionAuthority created_at"),
    account_scope: validateAccountScope(raw.account_scope, storeIndex, "SessionAuthority account_scope"),
    primary_correlations: {
      create: parseCorrelation(correlations.create, "create correlation"),
      ready_status: parseCorrelation(correlations.ready_status, "ready correlation"),
      download_locator: parseCorrelation(correlations.download_locator, "locator correlation"),
      report_file: parseCorrelation(correlations.report_file, "file correlation"),
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false,
    },
  };
  if (new Set(Object.values(authority.primary_correlations).map((item) => item.sha256)).size !== 4) {
    fail("INVALID_SESSION", "SessionAuthority correlations are not distinct");
  }
  return { authority, bytes };
}

function checkpointInstant(raw: Record<string, unknown>, label: string): string {
  if (raw.schema_version !== WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA
    || raw.phase !== "request") {
    fail("INVALID_ORIGINAL_CHECKPOINT", `${label} is not a request checkpoint`);
  }
  return strictCanonicalInstant(raw.observed_at, `${label}.observed_at`);
}

async function loadOriginalAmbiguousRequest(
  sessionDir: string,
  storeIndex: number,
): Promise<OriginalAmbiguousRequest> {
  const { authority, bytes: authorityBytes } = await loadSessionAuthority(sessionDir, storeIndex);
  const createBytes = await secureRead(sessionDir, CREATE_MANIFEST, 1024 * 1024);
  const expectedCreate = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: authority.account_scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256,
  });
  const actualCreate = parseJsonBytes(createBytes, "create request manifest");
  if (!sameCanonical(actualCreate, expectedCreate)
    || !Buffer.from(createBytes).equals(Buffer.from(canonicalBytes(expectedCreate)))) {
    fail("INVALID_ORIGINAL_MANIFEST", "retained create request manifest is not the exact ITEM v6 manifest");
  }

  const reservedBytes = await secureRead(sessionDir, REQUEST_RESERVED, 1024 * 1024);
  const reserved = parseJsonBytes(reservedBytes, "request reservation");
  assertExactKeys(reserved, [
    "attempt", "observed_at", "phase", "post_attempt_limit",
    "request_correlation_id_sha256", "request_manifest_sha256", "schema_version", "state",
  ], "request reservation");
  const reservedAt = checkpointInstant(reserved, "request reservation");
  if (reserved.state !== "RESERVED" || reserved.attempt !== 1 || reserved.post_attempt_limit !== 1
    || reserved.request_correlation_id_sha256 !== authority.primary_correlations.create.sha256
    || reserved.request_manifest_sha256 !== sha256Bytes(createBytes)) {
    fail("INVALID_ORIGINAL_CHECKPOINT", "request reservation does not bind the exact one-shot POST");
  }

  const manualBytes = await secureRead(sessionDir, REQUEST_MANUAL_REVIEW, 1024 * 1024);
  const manual = parseJsonBytes(manualBytes, "request manual-review checkpoint");
  assertExactKeys(manual, [
    "observed_at", "phase", "reason_code", "retry_forbidden", "schema_version", "state",
  ], "request manual-review checkpoint");
  const manualAt = checkpointInstant(manual, "request manual-review checkpoint");
  if (manual.state !== "MANUAL_REVIEW"
    || manual.reason_code !== "AMBIGUOUS_POST_NETWORK_OUTCOME"
    || manual.retry_forbidden !== true
    || Date.parse(manualAt) < Date.parse(reservedAt)) {
    fail("NOT_RECONCILABLE", "session is not an ambiguous-network POST with retry forbidden");
  }
  if (await secureReadOptional(sessionDir, REQUEST_COMPLETE, 1024 * 1024) !== null) {
    fail("ILLEGAL_TRANSITION", "original request phase is already complete");
  }
  return {
    authority,
    authority_sha256: sha256Bytes(authorityBytes),
    create_manifest_sha256: sha256Bytes(createBytes),
    reserved_sha256: sha256Bytes(reservedBytes),
    manual_review_sha256: sha256Bytes(manualBytes),
    reserved_at: reservedAt,
    manual_review_at: manualAt,
  };
}

async function revalidateOriginalArtifacts(
  sessionDir: string,
  original: OriginalAmbiguousRequest,
): Promise<void> {
  const [authority, createManifest, reserved, manualReview, requestComplete] = await Promise.all([
    secureRead(sessionDir, SESSION_AUTHORITY, 1024 * 1024),
    secureRead(sessionDir, CREATE_MANIFEST, 1024 * 1024),
    secureRead(sessionDir, REQUEST_RESERVED, 1024 * 1024),
    secureRead(sessionDir, REQUEST_MANUAL_REVIEW, 1024 * 1024),
    secureReadOptional(sessionDir, REQUEST_COMPLETE, 1024 * 1024),
  ]);
  if (sha256Bytes(authority) !== original.authority_sha256
    || sha256Bytes(createManifest) !== original.create_manifest_sha256
    || sha256Bytes(reserved) !== original.reserved_sha256
    || sha256Bytes(manualReview) !== original.manual_review_sha256
    || requestComplete !== null) {
    fail(
      "ORIGINAL_STATE_MUTATED",
      "original authority/manifest/reservation/manual-review bytes changed or REQUEST_COMPLETE appeared",
    );
  }
}

function fixedQuery(start: string, end: string): QueryScope {
  return {
    reportType: "ITEM",
    reportVersion: "v6",
    src: "API",
    requestSubmissionStartDate: start,
    requestSubmissionEndDate: end,
  };
}

function reconciliationId(original: OriginalAmbiguousRequest, query: QueryScope): string {
  return sha256String(canonicalWalmartItemReportJson({
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA,
    session_id: original.authority.session_id,
    account_scope: original.authority.account_scope,
    original_create_correlation_sha256: original.authority.primary_correlations.create.sha256,
    query,
  })).slice(0, 24);
}

function artifactNames(id: string, pageIndex?: number) {
  const base = `item-request-reconcile-${id}`;
  if (pageIndex === undefined) {
    return {
      scope: `capture/60-${base}-scope.json`,
      result: `trusted/68-${base}-result.json`,
      complete: `checkpoints/69-${base}-complete.json`,
    };
  }
  const page = String(pageIndex).padStart(4, "0");
  return {
    request: `capture/61-${base}-page-${page}-request.json`,
    reserved: `checkpoints/61-${base}-page-${page}-reserved.json`,
    response: `capture/62-${base}-page-${page}-response.bin`,
    http: `capture/63-${base}-page-${page}-http.json`,
    seal: `trusted/64-${base}-page-${page}-seal.json`,
    failed: `checkpoints/64-${base}-page-${page}-failed.json`,
    complete: `checkpoints/65-${base}-page-${page}-complete.json`,
  };
}

function buildScopeManifest(
  id: string,
  createdAt: string,
  original: OriginalAmbiguousRequest,
  query: QueryScope,
) {
  return {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA,
    reconciliation_id: id,
    created_at: createdAt,
    account_scope: original.authority.account_scope,
    query_scope: query,
    original_ambiguous_post: {
      session_authority_sha256: original.authority_sha256,
      create_manifest_sha256: original.create_manifest_sha256,
      request_reserved_sha256: original.reserved_sha256,
      manual_review_sha256: original.manual_review_sha256,
      create_correlation_id_sha256: original.authority.primary_correlations.create.sha256,
      retry_forbidden: true,
    },
    limits: WALMART_ITEM_REPORT_RECONCILIATION_LIMITS,
    safety: {
      report_create_post_allowed: false,
      walmart_mutation_allowed: false,
      database_allowed: false,
      model_allowed: false,
      request_id_adoption_allowed: false,
      only_list_report_requests_get: true,
    },
  } as const;
}

async function loadOrCreateScopeManifest(
  sessionDir: string,
  names: ReturnType<typeof artifactNames>,
  id: string,
  original: OriginalAmbiguousRequest,
  query: QueryScope,
  now: Date,
  dependencies: WalmartItemReportRequestReconciliationDependencies,
): Promise<void> {
  const retained = await secureReadOptional(sessionDir, names.scope);
  if (retained === null) {
    await writeImmutableJson(
      sessionDir,
      names.scope,
      buildScopeManifest(id, now.toISOString(), original, query),
      dependencies,
    );
    return;
  }
  const raw = parseJsonBytes(retained, "reconciliation scope manifest");
  const createdAt = strictCanonicalInstant(raw.created_at, "reconciliation created_at");
  if (!sameCanonical(raw, buildScopeManifest(id, createdAt, original, query))) {
    fail("SCOPE_MISMATCH", "retained reconciliation scope does not match this execution");
  }
}

function validateResponseHeaders(headersInput: unknown): Record<string, string> {
  const raw = asRecord(headersInput, "HTTP response headers");
  const headers: Record<string, string> = {};
  for (const [nameInput, valueInput] of Object.entries(raw)) {
    const name = exactString(nameInput.toLowerCase(), "HTTP response header name", 256);
    if (typeof valueInput !== "string" || valueInput.length > 32_768
      || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(valueInput)) {
      fail("INVALID_HTTP_RESPONSE", "HTTP response header value is invalid");
    }
    const value = valueInput;
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) || Object.hasOwn(headers, name)) {
      fail("INVALID_HTTP_RESPONSE", "HTTP response headers are invalid or duplicated");
    }
    headers[name] = value;
  }
  return Object.fromEntries(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)));
}

function optionalSingleHeader(headers: Record<string, string>, names: readonly string[]): string | null {
  const values = names.map((name) => headers[name.toLowerCase()]).filter((value) => value !== undefined);
  if (new Set(values).size > 1) fail("CONFLICTING_HTTP_HEADER", "HTTP response echo headers conflict");
  return values[0] ?? null;
}

function validateHttpProtocol(
  statusInput: unknown,
  headersInput: unknown,
  body: Uint8Array,
  correlation: SessionCorrelation,
): {
  status: number;
  headers: Record<string, string>;
  echoed_correlation_id_sha256: string | null;
  protocol_error: string | null;
} {
  if (!Number.isSafeInteger(statusInput)
    || Number(statusInput) < 100 || Number(statusInput) > 599
    || !(body instanceof Uint8Array)
    || body.byteLength > WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_page_response_bytes) {
    fail("INVALID_HTTP_RESPONSE", "transport returned an invalid or oversized HTTP response");
  }
  const status = Number(statusInput);
  const headers = validateResponseHeaders(headersInput);
  const encoding = headers["content-encoding"];
  let protocolError: string | null = null;
  if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
    protocolError = "UNSUPPORTED_CONTENT_ENCODING";
  }
  const contentLength = headers["content-length"];
  if (contentLength !== undefined
    && (!/^(?:0|[1-9]\d*)$/u.test(contentLength)
      || Number(contentLength) !== body.byteLength)) {
    protocolError = protocolError ?? "CONTENT_LENGTH_MISMATCH";
  }
  const echoed = optionalSingleHeader(headers, ["wm_qos.correlation_id", "wm-qos-correlation-id"]);
  if (echoed !== null && echoed !== correlation.id) {
    protocolError = protocolError ?? "CORRELATION_ECHO_MISMATCH";
  }
  if (REDIRECT_STATUSES.has(status)) protocolError = protocolError ?? "REDIRECT_FORBIDDEN";
  if (status !== 200) protocolError = protocolError ?? "HTTP_STATUS_FAILURE";
  const contentType = headers["content-type"] ?? null;
  if (contentType !== null && !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    protocolError = protocolError ?? "UNSUPPORTED_CONTENT_TYPE";
  }
  return {
    status,
    headers,
    echoed_correlation_id_sha256: echoed === null ? null : sha256String(echoed),
    protocol_error: protocolError,
  };
}

function canonicalHttpMetadata(
  validation: ReturnType<typeof validateHttpProtocol>,
  body: Uint8Array,
  correlation: SessionCorrelation,
  observedAt: string,
): Record<string, unknown> {
  return {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA,
    observed_at: observedAt,
    status: validation.status,
    headers: validation.headers,
    response_body_byte_length: body.byteLength,
    response_body_sha256: sha256Bytes(body),
    request_correlation_id_sha256: correlation.sha256,
    echoed_correlation_id_sha256: validation.echoed_correlation_id_sha256,
  };
}

function capturedHttp(
  response: WalmartItemReportAtomicTransportResponse,
  correlation: SessionCorrelation,
  observedAt: string,
): { body: Uint8Array; http: Record<string, unknown>; protocol_error: string | null } {
  if (!response || !(response.body instanceof Uint8Array)) {
    fail("INVALID_HTTP_RESPONSE", "transport returned an invalid HTTP response");
  }
  const body = new Uint8Array(response.body);
  const validation = validateHttpProtocol(response.status, response.headers, body, correlation);
  return {
    body,
    http: canonicalHttpMetadata(validation, body, correlation, observedAt),
    protocol_error: validation.protocol_error,
  };
}

function buildPageRequestManifest(
  id: string,
  pageIndex: number,
  query: QueryScope,
  original: OriginalAmbiguousRequest,
  correlation: SessionCorrelation,
) {
  return {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA,
    reconciliation_id: id,
    page_index: pageIndex,
    method: "GET",
    endpoint: "/v3/reports/reportRequests",
    query,
    headers: { accept: "application/json", "accept-encoding": "identity" },
    body: null,
    authority: {
      account_scope: original.authority.account_scope,
      original_create_correlation_id_sha256: original.authority.primary_correlations.create.sha256,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256,
    },
    safety: {
      report_create_post: false,
      request_id_adoption: false,
    },
  } as const;
}

function pageCorrelationFromManifest(
  manifest: Record<string, unknown>,
  id: string,
  pageIndex: number,
  query: QueryScope,
  original: OriginalAmbiguousRequest,
): SessionCorrelation {
  const authority = asRecord(manifest.authority, "page request authority");
  const idValue = exactString(authority.request_correlation_id, "page request correlation ID", 256);
  const sha = exactString(authority.request_correlation_id_sha256, "page request correlation digest", 64);
  if (!/^[a-f0-9]{64}$/u.test(sha) || sha !== sha256String(idValue)) {
    fail("INVALID_PAGE_MANIFEST", "page request correlation binding is invalid");
  }
  const correlation = { id: idValue, sha256: sha };
  if (!sameCanonical(manifest, buildPageRequestManifest(
    id, pageIndex, query, original, correlation,
  ))) {
    fail("INVALID_PAGE_MANIFEST", "page request manifest is outside the sealed reconciliation scope");
  }
  return correlation;
}

function newCorrelation(dependencies: WalmartItemReportRequestReconciliationDependencies): SessionCorrelation {
  const id = exactString((dependencies.random_uuid ?? randomUUID)(), "GET correlation ID", 256);
  return { id, sha256: sha256String(id) };
}

function requestTimeout(dependencies: WalmartItemReportRequestReconciliationDependencies): number {
  const value = dependencies.request_timeout_ms
    ?? WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.request_timeout_ms;
  if (!Number.isSafeInteger(value) || value < 1
    || value > WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS) {
    fail("INVALID_REQUEST_TIMEOUT", "request timeout is outside 1..60000 ms");
  }
  return value;
}

async function sendOnce(
  dependencies: WalmartItemReportRequestReconciliationDependencies,
  request: Omit<WalmartItemReportAtomicTransportRequest, "signal" | "timeout_ms">,
): Promise<WalmartItemReportAtomicTransportResponse> {
  const timeoutMs = requestTimeout(dependencies);
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new WalmartItemReportRequestReconciliationError(
        "REQUEST_TIMEOUT",
        "read-only reconciliation GET exceeded its deadline",
      ));
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
  } catch (error) {
    if (error instanceof WalmartItemReportRequestReconciliationError) throw error;
    throw new WalmartItemReportRequestReconciliationError(
      "NETWORK_FAILURE",
      "read-only reconciliation GET failed; automatic retry is forbidden",
    );
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function pageSeal(
  requestBytes: Uint8Array,
  responseBytes: Uint8Array,
  httpBytes: Uint8Array,
  correlation: SessionCorrelation,
) {
  const body = {
    policy_id: WALMART_ITEM_REPORT_RECONCILIATION_SEAL_POLICY,
    request_manifest_sha256: sha256Bytes(requestBytes),
    request_manifest_byte_length: requestBytes.byteLength,
    request_correlation_id_sha256: correlation.sha256,
    response_body_sha256: sha256Bytes(responseBytes),
    response_body_byte_length: responseBytes.byteLength,
    response_http_sha256: sha256Bytes(httpBytes),
    response_http_byte_length: httpBytes.byteLength,
  };
  return { ...body, seal_sha256: sha256String(canonicalWalmartItemReportJson(body)) } as const;
}

function advertisedExactString(
  row: Record<string, unknown>,
  names: readonly string[],
  label: string,
): string | null {
  const values = names
    .filter((name) => row[name] !== undefined && row[name] !== null)
    .map((name) => exactString(row[name], `${label}.${name}`, 512));
  if (new Set(values).size > 1) fail("MALFORMED_RESPONSE", `${label} has conflicting ${names[0]} fields`);
  return values[0] ?? null;
}

function normalizeRequestRow(
  value: unknown,
  pageIndex: number,
  rowIndex: number,
  query: QueryScope,
  originalCorrelation: SessionCorrelation,
): NormalizedRequestRow {
  const row = asRecord(value, "report request row");
  const requestId = advertisedExactString(row, ["requestId", "requestID"], "report request row");
  if (requestId === null) fail("MALFORMED_RESPONSE", "report request row has no requestId");
  const reportType = advertisedExactString(row, ["reportType"], "report request row");
  const reportVersion = advertisedExactString(row, ["reportVersion"], "report request row");
  if (reportType !== "ITEM" || reportVersion !== "v6") {
    fail("SCOPE_MISMATCH", "Walmart response contains a row outside ITEM v6 scope");
  }
  const source = advertisedExactString(row, ["src", "source", "requestSource"], "report request row");
  if (source !== null && source !== "API") {
    fail("SCOPE_MISMATCH", "Walmart response contains a non-API report request row");
  }
  const submittedRaw = advertisedExactString(
    row,
    ["requestSubmissionDate"],
    "report request row",
  );
  if (submittedRaw === null) {
    fail("MALFORMED_RESPONSE", "report request row has no requestSubmissionDate");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(submittedRaw)) {
    fail("MALFORMED_RESPONSE", "report request row submission date is not strict UTC ISO-8601");
  }
  const submittedMs = Date.parse(submittedRaw);
  const fractional = /\.(\d{1,3})Z$/u.exec(submittedRaw)?.[1] ?? "";
  const normalizedSubmitted = fractional.length === 0
    ? submittedRaw.replace(/Z$/u, ".000Z")
    : submittedRaw.replace(/\.\d{1,3}Z$/u, `.${fractional.padEnd(3, "0")}Z`);
  if (!Number.isFinite(submittedMs)
    || new Date(submittedMs).toISOString() !== normalizedSubmitted
    || submittedMs < Date.parse(query.requestSubmissionStartDate)
    || submittedMs > Date.parse(query.requestSubmissionEndDate)) {
    fail("SCOPE_MISMATCH", "Walmart response contains a row outside the exact time bounds");
  }
  const status = advertisedExactString(row, ["requestStatus", "status"], "report request row");
  if (status !== null && !["RECEIVED", "INPROGRESS", "READY", "ERROR"].includes(status)) {
    fail("MALFORMED_RESPONSE", "report request row has an unsupported status");
  }
  const correlation = advertisedExactString(row, [
    "correlationId", "correlationID", "requestCorrelationId", "requestCorrelationID",
    "wm_qos.correlation_id", "WM_QOS.CORRELATION_ID",
  ], "report request row");
  return {
    page_index: pageIndex,
    row_index: rowIndex,
    request_id_sha256: sha256String(requestId),
    request_submission_date: new Date(submittedMs).toISOString(),
    request_status: status,
    correlation_evidence: correlation === null
      ? "ABSENT"
      : correlation === originalCorrelation.id ? "EXACT" : "DIFFERENT",
  };
}

function parsePageResponse(
  bytes: Uint8Array,
  pageIndex: number,
  query: QueryScope,
  originalCorrelation: SessionCorrelation,
): ParsedPage {
  const raw = parseJsonBytes(bytes, "report requests response");
  if (!Array.isArray(raw.requests)) {
    fail("MALFORMED_RESPONSE", "report requests response has no requests array");
  }
  if (!Object.hasOwn(raw, "page") || !Object.hasOwn(raw, "limit")
    || !Object.hasOwn(raw, "totalCount")
    || raw.page === null || raw.limit === null || raw.totalCount === null) {
    fail(
      "PAGINATION_INCOMPLETE",
      "report requests response lacks the complete page/limit/totalCount proof",
    );
  }
  const page = nonNegativeInteger(raw.page, "response.page");
  if (page < 1) fail("PAGINATION_INVALID", "response page must start at one");
  const totalCount = nonNegativeInteger(raw.totalCount, "response.totalCount");
  const limit = nonNegativeInteger(raw.limit, "response.limit");
  const observedEmptySentinel = page === 1
    && totalCount === 0
    && limit === 0
    && raw.requests.length === 0
    && !Object.hasOwn(raw, "nextCursor");
  if (limit === 0 && !observedEmptySentinel) {
    fail("PAGINATION_INVALID", "response limit zero is allowed only for the observed empty sentinel");
  }
  if (!Object.hasOwn(raw, "nextCursor") && !observedEmptySentinel) {
    fail(
      "PAGINATION_INCOMPLETE",
      "report requests response has no nextCursor field or observed empty sentinel",
    );
  }
  if (limit > WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_advertised_page_limit) {
    fail("PAGINATION_INVALID", "response limit exceeds the fixed pagination safety cap");
  }
  let nextCursor: string | null = null;
  if (raw.nextCursor !== undefined && raw.nextCursor !== null) {
    nextCursor = exactString(
      raw.nextCursor,
      "response.nextCursor",
      WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_cursor_characters,
    );
  }
  if (raw.requests.length > WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_rows) {
    fail("ROW_CAP", "one response page exceeds the reconciliation row cap");
  }
  if (raw.requests.length > limit) {
    fail("PAGINATION_INVALID", "response row count exceeds its advertised page limit");
  }
  const rows = raw.requests.map((row, index) => normalizeRequestRow(
    row,
    pageIndex,
    index,
    query,
    originalCorrelation,
  ));
  if (nextCursor !== null && rows.length === 0) {
    fail("PAGINATION_INVALID", "empty response page advertises a continuation cursor");
  }
  if (page !== pageIndex) {
    fail("PAGINATION_DRIFT", "response page does not match the exact requested page sequence");
  }
  return {
    page_index: pageIndex,
    rows,
    advertised_page: page,
    advertised_limit: limit,
    advertised_total_count: totalCount,
    next_cursor: nextCursor,
  };
}

function nextQuery(
  parsed: ParsedPage,
  fixed: QueryScope,
  cumulativeRows: number,
): QueryScope | null {
  if (parsed.advertised_total_count !== null
    && parsed.advertised_total_count < cumulativeRows) {
    fail("PAGINATION_INVALID", "response totalCount is smaller than captured rows");
  }
  if (parsed.next_cursor !== null) {
    // The current US Marketplace reference documents nextCursor in examples but
    // does not pin a continuation query parameter/URL contract for this endpoint.
    // Supplier/scheduler semantics are not imported into seller ITEM custody.
    fail(
      "UNSUPPORTED_US_CURSOR",
      "US report-request response exposes nextCursor without a pinned continuation contract",
    );
  }
  if (parsed.advertised_total_count !== null
    && cumulativeRows < parsed.advertised_total_count) {
    if (parsed.advertised_page === null || parsed.advertised_limit === null
      || parsed.advertised_limit < 1
      || parsed.rows.length !== parsed.advertised_limit) {
      fail(
        "PAGINATION_INCOMPLETE",
        "non-terminal numeric page is not a complete advertised-limit page",
      );
    }
    return {
      ...fixed,
      page: String(parsed.advertised_page + 1),
      limit: String(parsed.advertised_limit),
    };
  }
  return null;
}

function pageCheckpoint(
  id: string,
  pageIndex: number,
  state: string,
  observedAt: string,
  extra: Record<string, unknown>,
) {
  return {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA,
    reconciliation_id: id,
    page_index: pageIndex,
    state,
    observed_at: observedAt,
    ...extra,
  };
}

const PAGE_RESERVATION_CHECKPOINT_KEYS = [
  "get_attempt_limit", "observed_at", "page_index", "reconciliation_id",
  "request_correlation_id_sha256", "request_manifest_sha256", "retry_forbidden",
  "schema_version", "state",
] as const;

const PAGE_COMPLETION_CHECKPOINT_KEYS = [
  "exchange_seal_sha256", "observed_at", "page_index", "reconciliation_id",
  "recovered_without_network", "request_manifest_sha256", "response_body_sha256",
  "response_http_sha256", "schema_version", "state",
] as const;

const PAGE_FAILURE_CHECKPOINT_KEYS = [
  "observed_at", "page_index", "reason_code", "reconciliation_id",
  "retry_forbidden", "schema_version", "state",
] as const;

function parsePageCheckpoint(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    return parseJsonBytes(bytes, label);
  } catch (error) {
    if (error instanceof WalmartItemReportRequestReconciliationError) {
      fail("INVALID_PAGE_CHECKPOINT", `${label} is not valid canonical checkpoint JSON`);
    }
    throw error;
  }
}

function pageCheckpointObservedAt(value: unknown, label: string): string {
  try {
    return strictCanonicalInstant(value, label);
  } catch (error) {
    if (error instanceof WalmartItemReportRequestReconciliationError) {
      fail("INVALID_PAGE_CHECKPOINT", `${label} is invalid`);
    }
    throw error;
  }
}

function exactPageCheckpointBytes(
  bytes: Uint8Array,
  expected: Record<string, unknown>,
  label: string,
): void {
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalBytes(expected)))) {
    fail("INVALID_PAGE_CHECKPOINT", `${label} is not the exact canonical checkpoint`);
  }
}

function buildPageReservationCheckpoint(
  id: string,
  pageIndex: number,
  observedAt: string,
  requestBytes: Uint8Array,
  correlation: SessionCorrelation,
): Record<string, unknown> {
  return pageCheckpoint(id, pageIndex, "RESERVED", observedAt, {
    get_attempt_limit: 1,
    retry_forbidden: true,
    request_manifest_sha256: sha256Bytes(requestBytes),
    request_correlation_id_sha256: correlation.sha256,
  });
}

function validatePageReservationCheckpoint(
  bytes: Uint8Array,
  id: string,
  pageIndex: number,
  requestBytes: Uint8Array,
  correlation: SessionCorrelation,
): string {
  const raw = parsePageCheckpoint(bytes, "page reservation checkpoint");
  assertExactKeys(
    raw,
    PAGE_RESERVATION_CHECKPOINT_KEYS,
    "page reservation checkpoint",
    "INVALID_PAGE_CHECKPOINT",
  );
  const observedAt = pageCheckpointObservedAt(
    raw.observed_at,
    "page reservation checkpoint observed_at",
  );
  const expected = buildPageReservationCheckpoint(
    id,
    pageIndex,
    observedAt,
    requestBytes,
    correlation,
  );
  exactPageCheckpointBytes(bytes, expected, "page reservation checkpoint");
  return observedAt;
}

function buildPageCompletionCheckpoint(
  id: string,
  pageIndex: number,
  observedAt: string,
  evidence: PageEvidence,
  recoveredWithoutNetwork: boolean,
): Record<string, unknown> {
  return pageCheckpoint(id, pageIndex, "CAPTURED", observedAt, {
    request_manifest_sha256: evidence.request_manifest_sha256,
    response_body_sha256: evidence.response_body_sha256,
    response_http_sha256: evidence.response_http_sha256,
    exchange_seal_sha256: evidence.exchange_seal_sha256,
    recovered_without_network: recoveredWithoutNetwork,
  });
}

function validatePageCompletionCheckpoint(
  bytes: Uint8Array,
  id: string,
  pageIndex: number,
  reservationObservedAt: string,
  responseObservedAt: string,
  evidence: PageEvidence,
): void {
  const raw = parsePageCheckpoint(bytes, "page completion checkpoint");
  assertExactKeys(
    raw,
    PAGE_COMPLETION_CHECKPOINT_KEYS,
    "page completion checkpoint",
    "INVALID_PAGE_CHECKPOINT",
  );
  const observedAt = pageCheckpointObservedAt(
    raw.observed_at,
    "page completion checkpoint observed_at",
  );
  if (observedAt !== responseObservedAt
    || Date.parse(observedAt) < Date.parse(reservationObservedAt)
    || typeof raw.recovered_without_network !== "boolean") {
    fail("INVALID_PAGE_CHECKPOINT", "page completion checkpoint has an invalid state transition");
  }
  const expected = buildPageCompletionCheckpoint(
    id,
    pageIndex,
    observedAt,
    evidence,
    raw.recovered_without_network,
  );
  exactPageCheckpointBytes(bytes, expected, "page completion checkpoint");
}

function parseRetainedPageFailure(
  bytes: Uint8Array,
  id: string,
  pageIndex: number,
): RetainedPageFailure {
  const retained = parsePageCheckpoint(bytes, "retained terminal page failure");
  assertExactKeys(
    retained,
    PAGE_FAILURE_CHECKPOINT_KEYS,
    "retained terminal page failure",
    "INVALID_PAGE_CHECKPOINT",
  );
  const reasonCode = retained.reason_code;
  if (retained.schema_version !== WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA
    || retained.reconciliation_id !== id || retained.page_index !== pageIndex
    || typeof retained.state !== "string"
    || !["AMBIGUOUS_GET", "HTTP_REVIEW_REQUIRED", "PARSE_REVIEW_REQUIRED"].includes(retained.state)
    || retained.retry_forbidden !== true
    || typeof reasonCode !== "string"
    || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(reasonCode)) {
    fail("INVALID_PAGE_CHECKPOINT", "retained terminal page failure is invalid");
  }
  const observedAt = pageCheckpointObservedAt(
    retained.observed_at,
    "retained terminal page failure observed_at",
  );
  exactPageCheckpointBytes(bytes, pageCheckpoint(
    id,
    pageIndex,
    retained.state,
    observedAt,
    { reason_code: reasonCode, retry_forbidden: true },
  ), "retained terminal page failure");
  return {
    state: retained.state as RetainedPageFailure["state"],
    reason_code: reasonCode,
    observed_at: observedAt,
  };
}

function throwRetainedPageFailure(
  bytes: Uint8Array,
  id: string,
  pageIndex: number,
): never {
  const retained = parseRetainedPageFailure(bytes, id, pageIndex);
  fail(
    retained.state === "AMBIGUOUS_GET"
      ? "AMBIGUOUS_GET_ATTEMPT"
      : retained.reason_code,
    "retained terminal GET outcome forbids network replay and has no safe offline recovery",
  );
}

async function verifyCapturedPage(
  sessionDir: string,
  names: ReturnType<typeof artifactNames>,
  requestBytes: Uint8Array,
  correlation: SessionCorrelation,
): Promise<{
  parsedBody: Uint8Array;
  evidence: PageEvidence;
  observedAt: string;
  protocolError: string | null;
}> {
  const responseBytes = await secureRead(
    sessionDir,
    names.response,
    WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_page_response_bytes,
  );
  const httpBytes = await secureRead(sessionDir, names.http);
  const sealBytes = await secureRead(sessionDir, names.seal);
  const http = parseJsonBytes(httpBytes, "retained reconciliation HTTP metadata");
  const seal = parseJsonBytes(sealBytes, "retained reconciliation exchange seal");
  const expectedSeal = pageSeal(requestBytes, responseBytes, httpBytes, correlation);
  if (!sameCanonical(seal, expectedSeal)
    || !Buffer.from(sealBytes).equals(Buffer.from(canonicalBytes(expectedSeal)))
    || http.response_body_sha256 !== sha256Bytes(responseBytes)
    || http.response_body_byte_length !== responseBytes.byteLength
    || http.request_correlation_id_sha256 !== correlation.sha256) {
    fail("INVALID_PAGE_SEAL", "retained page response does not match its immutable exchange seal");
  }
  assertExactKeys(http, [
    "echoed_correlation_id_sha256", "headers", "observed_at",
    "request_correlation_id_sha256", "response_body_byte_length",
    "response_body_sha256", "schema_version", "status",
  ], "retained reconciliation HTTP metadata");
  if (http.schema_version !== WALMART_ITEM_REPORT_RECONCILIATION_PAGE_SCHEMA) {
    fail("INVALID_HTTP_RESPONSE", "retained HTTP metadata schema is invalid");
  }
  const observedAt = strictCanonicalInstant(http.observed_at, "retained HTTP observed_at");
  const validation = validateHttpProtocol(http.status, http.headers, responseBytes, correlation);
  const rebuiltHttp = canonicalHttpMetadata(validation, responseBytes, correlation, observedAt);
  if (!sameCanonical(http, rebuiltHttp)
    || !Buffer.from(httpBytes).equals(Buffer.from(canonicalBytes(rebuiltHttp)))) {
    fail("INVALID_HTTP_RESPONSE", "retained HTTP metadata is not the canonical response envelope");
  }
  return {
    parsedBody: responseBytes,
    evidence: {
      page_index: Number((parseJsonBytes(requestBytes, "page request manifest")).page_index),
      request_manifest_path: names.request,
      request_manifest_sha256: sha256Bytes(requestBytes),
      response_body_path: names.response,
      response_body_sha256: sha256Bytes(responseBytes),
      response_http_path: names.http,
      response_http_sha256: sha256Bytes(httpBytes),
      exchange_seal_path: names.seal,
      exchange_seal_sha256: sha256Bytes(sealBytes),
    },
    observedAt,
    protocolError: validation.protocol_error,
  };
}

async function capturePage(
  sessionDir: string,
  id: string,
  pageIndex: number,
  query: QueryScope,
  original: OriginalAmbiguousRequest,
  dependencies: WalmartItemReportRequestReconciliationDependencies,
  allowNetwork: boolean,
): Promise<{ parsed: ParsedPage; evidence: PageEvidence; networkCalls: number }> {
  const names = artifactNames(id, pageIndex);
  const existingRequest = await secureReadOptional(sessionDir, names.request);
  let requestBytes: Uint8Array;
  let correlation: SessionCorrelation;
  if (existingRequest === null) {
    if (!allowNetwork) {
      fail("INVALID_FINAL_RESULT", "completed result references a page with no retained request manifest");
    }
    correlation = newCorrelation(dependencies);
    requestBytes = canonicalBytes(buildPageRequestManifest(
      id, pageIndex, query, original, correlation,
    ));
    await writeImmutable(sessionDir, names.request, requestBytes, dependencies);
  } else {
    requestBytes = existingRequest;
    const requestManifest = parseJsonBytes(requestBytes, "page request manifest");
    if (!Buffer.from(requestBytes).equals(Buffer.from(canonicalBytes(requestManifest)))) {
      fail("INVALID_PAGE_MANIFEST", "page request manifest is not canonical JSON");
    }
    correlation = pageCorrelationFromManifest(
      requestManifest,
      id,
      pageIndex,
      query,
      original,
    );
  }

  const failedBytes = await secureReadOptional(sessionDir, names.failed);
  const reservedBytes = await secureReadOptional(sessionDir, names.reserved);
  const completedBytes = await secureReadOptional(sessionDir, names.complete);
  if (failedBytes !== null) {
    throwRetainedPageFailure(failedBytes, id, pageIndex);
  }

  if (completedBytes !== null) {
    if (reservedBytes === null) {
      fail(
        "INVALID_PAGE_CHECKPOINT",
        "page completion checkpoint has no durable pre-transport reservation",
      );
    }
    const reservationObservedAt = validatePageReservationCheckpoint(
      reservedBytes,
      id,
      pageIndex,
      requestBytes,
      correlation,
    );
    const captured = await verifyCapturedPage(sessionDir, names, requestBytes, correlation);
    validatePageCompletionCheckpoint(
      completedBytes,
      id,
      pageIndex,
      reservationObservedAt,
      captured.observedAt,
      captured.evidence,
    );
    if (captured.protocolError !== null) {
      fail(captured.protocolError, "retained HTTP response cannot be used for reconciliation");
    }
    const lateFailure = await secureReadOptional(sessionDir, names.failed);
    if (lateFailure !== null) throwRetainedPageFailure(lateFailure, id, pageIndex);
    return {
      parsed: parsePageResponse(
        captured.parsedBody, pageIndex, query, original.authority.primary_correlations.create,
      ),
      evidence: captured.evidence,
      networkCalls: 0,
    };
  }

  if (reservedBytes !== null) {
    const reservationObservedAt = validatePageReservationCheckpoint(
      reservedBytes,
      id,
      pageIndex,
      requestBytes,
      correlation,
    );
    const responseParts = await Promise.all([
      secureReadOptional(sessionDir, names.response,
        WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_page_response_bytes),
      secureReadOptional(sessionDir, names.http),
      secureReadOptional(sessionDir, names.seal),
    ]);
    if (responseParts.every((value) => value !== null)) {
      const captured = await verifyCapturedPage(sessionDir, names, requestBytes, correlation);
      if (captured.protocolError !== null) {
        fail(captured.protocolError, "retained HTTP response cannot be used for reconciliation");
      }
      const parsed = parsePageResponse(
        captured.parsedBody, pageIndex, query, original.authority.primary_correlations.create,
      );
      if (!allowNetwork) {
        fail("INVALID_FINAL_RESULT", "completed result lacks a required page completion checkpoint");
      }
      const completion = buildPageCompletionCheckpoint(
        id,
        pageIndex,
        captured.observedAt,
        captured.evidence,
        true,
      );
      await writeImmutableJson(sessionDir, names.complete, completion, dependencies);
      const durableCompletion = await secureRead(sessionDir, names.complete);
      validatePageCompletionCheckpoint(
        durableCompletion,
        id,
        pageIndex,
        reservationObservedAt,
        captured.observedAt,
        captured.evidence,
      );
      const durableReservation = await secureRead(sessionDir, names.reserved);
      validatePageReservationCheckpoint(
        durableReservation,
        id,
        pageIndex,
        requestBytes,
        correlation,
      );
      if (!Buffer.from(durableReservation).equals(Buffer.from(reservedBytes))) {
        fail("INVALID_PAGE_CHECKPOINT", "page reservation changed during offline recovery");
      }
      const lateFailure = await secureReadOptional(sessionDir, names.failed);
      if (lateFailure !== null) throwRetainedPageFailure(lateFailure, id, pageIndex);
      return { parsed, evidence: captured.evidence, networkCalls: 0 };
    }
    if (responseParts.some((value) => value !== null)) {
      fail("PARTIAL_PAGE_CAPTURE", "reserved GET has a partial response capture; automatic retry is forbidden");
    }
    fail("AMBIGUOUS_GET_ATTEMPT", "reserved GET has no complete response capture; automatic retry is forbidden");
  }

  if (!allowNetwork) {
    fail("INVALID_FINAL_RESULT", "completed result cannot trigger a missing reconciliation GET");
  }

  const reservation = buildPageReservationCheckpoint(
    id,
    pageIndex,
    clockNow(dependencies).toISOString(),
    requestBytes,
    correlation,
  );
  const reservationBytes = canonicalBytes(reservation);
  await writeImmutable(sessionDir, names.reserved, reservationBytes, dependencies);
  const durableReservationBeforeTransport = await secureRead(sessionDir, names.reserved);
  const reservationObservedAt = validatePageReservationCheckpoint(
    durableReservationBeforeTransport,
    id,
    pageIndex,
    requestBytes,
    correlation,
  );
  if (!Buffer.from(durableReservationBeforeTransport).equals(Buffer.from(reservationBytes))) {
    fail("INVALID_PAGE_CHECKPOINT", "page reservation changed before transport");
  }

  let response: WalmartItemReportAtomicTransportResponse;
  try {
    response = await sendOnce(dependencies, {
      kind: "walmart-api",
      method: "GET",
      endpoint: "/v3/reports/reportRequests",
      query,
      url: null,
      headers: { accept: "application/json", "accept-encoding": "identity" },
      body: null,
      correlation_id: correlation.id,
      redirect: "manual",
      max_response_bytes: WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_page_response_bytes,
      max_redirect_response_bytes: 64 * 1024,
    });
  } catch (error) {
    await writeImmutableJson(sessionDir, names.failed, pageCheckpoint(
      id,
      pageIndex,
      "AMBIGUOUS_GET",
      clockNow(dependencies).toISOString(),
      {
        reason_code: error instanceof WalmartItemReportRequestReconciliationError
          ? error.code : "NETWORK_FAILURE",
        retry_forbidden: true,
      },
    ), dependencies);
    throw error;
  }

  const captured = capturedHttp(response, correlation, clockNow(dependencies).toISOString());
  const httpBytes = canonicalBytes(captured.http);
  const seal = pageSeal(requestBytes, captured.body, httpBytes, correlation);
  await writeImmutable(sessionDir, names.response, captured.body, dependencies);
  await writeImmutable(sessionDir, names.http, httpBytes, dependencies);
  await writeImmutableJson(sessionDir, names.seal, seal, dependencies);
  if (captured.protocol_error !== null) {
    await writeImmutableJson(sessionDir, names.failed, pageCheckpoint(
      id,
      pageIndex,
      "HTTP_REVIEW_REQUIRED",
      String(captured.http.observed_at),
      { reason_code: captured.protocol_error, retry_forbidden: true },
    ), dependencies);
    fail(captured.protocol_error, "captured HTTP response cannot be used for reconciliation");
  }

  const durableCapture = await verifyCapturedPage(
    sessionDir,
    names,
    requestBytes,
    correlation,
  );
  if (durableCapture.protocolError !== null) {
    fail(durableCapture.protocolError, "durable HTTP response cannot be used for reconciliation");
  }
  let parsed: ParsedPage;
  try {
    parsed = parsePageResponse(
      durableCapture.parsedBody,
      pageIndex,
      query,
      original.authority.primary_correlations.create,
    );
  } catch (error) {
    await writeImmutableJson(sessionDir, names.failed, pageCheckpoint(
      id,
      pageIndex,
      "PARSE_REVIEW_REQUIRED",
      durableCapture.observedAt,
      {
        reason_code: error instanceof WalmartItemReportRequestReconciliationError
          ? error.code : "MALFORMED_RESPONSE",
        retry_forbidden: true,
      },
    ), dependencies);
    throw error;
  }
  const evidence = durableCapture.evidence;
  const durableReservationAfterTransport = await secureRead(sessionDir, names.reserved);
  validatePageReservationCheckpoint(
    durableReservationAfterTransport,
    id,
    pageIndex,
    requestBytes,
    correlation,
  );
  if (!Buffer.from(durableReservationAfterTransport).equals(Buffer.from(reservationBytes))) {
    fail("INVALID_PAGE_CHECKPOINT", "page reservation changed during transport");
  }
  const completion = buildPageCompletionCheckpoint(
    id,
    pageIndex,
    durableCapture.observedAt,
    evidence,
    false,
  );
  await writeImmutableJson(sessionDir, names.complete, completion, dependencies);
  const durableCompletion = await secureRead(sessionDir, names.complete);
  validatePageCompletionCheckpoint(
    durableCompletion,
    id,
    pageIndex,
    reservationObservedAt,
    durableCapture.observedAt,
    evidence,
  );
  const lateFailure = await secureReadOptional(sessionDir, names.failed);
  if (lateFailure !== null) throwRetainedPageFailure(lateFailure, id, pageIndex);
  return { parsed, evidence, networkCalls: 1 };
}

function classifyOutcome(rows: readonly NormalizedRequestRow[]) {
  const candidates = rows.filter((row) => row.correlation_evidence !== "DIFFERENT");
  const exactCount = candidates.filter((row) => row.correlation_evidence === "EXACT").length;
  const requestIdCounts = new Map<string, number>();
  for (const row of rows) {
    requestIdCounts.set(row.request_id_sha256, (requestIdCounts.get(row.request_id_sha256) ?? 0) + 1);
  }
  const duplicateCount = [...requestIdCounts.values()].filter((count) => count > 1).length;
  let outcome: WalmartItemReportReconciliationOutcome;
  if (duplicateCount > 0 || candidates.length > 1) outcome = "AMBIGUOUS";
  else if (candidates.length === 0) outcome = "ABSENCE_ONLY";
  else if (exactCount === 1) outcome = "EXACT_MATCH";
  else outcome = "CANDIDATE_ONLY";
  return { outcome, candidates, exactCount, duplicateCount };
}

function buildFinalResult(
  id: string,
  completedAt: string,
  original: OriginalAmbiguousRequest,
  query: QueryScope,
  pages: readonly PageEvidence[],
  rows: readonly NormalizedRequestRow[],
) {
  const classified = classifyOutcome(rows);
  return {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA,
    reconciliation_id: id,
    completed_at: completedAt,
    outcome: classified.outcome,
    account_scope: original.authority.account_scope,
    query_scope: query,
    original_ambiguous_post: {
      session_authority_sha256: original.authority_sha256,
      create_manifest_sha256: original.create_manifest_sha256,
      request_reserved_sha256: original.reserved_sha256,
      manual_review_sha256: original.manual_review_sha256,
      create_correlation_id_sha256: original.authority.primary_correlations.create.sha256,
      retry_forbidden: true,
      manual_review_preserved: true,
    },
    evidence: {
      pages,
      page_count: pages.length,
      observed_row_count: rows.length,
      response_set_sha256: sha256String(canonicalWalmartItemReportJson(pages)),
    },
    candidate_set: {
      candidate_count: classified.candidates.length,
      exact_correlation_match_count: classified.exactCount,
      duplicate_request_id_count: classified.duplicateCount,
      excluded_different_correlation_count: rows.filter(
        (row) => row.correlation_evidence === "DIFFERENT",
      ).length,
      candidates: classified.candidates,
    },
    disposition: {
      request_id_adopted: false,
      request_complete_written: false,
      owner_disposition_generated: false,
      manual_disposition_generated: false,
    },
    safety: {
      report_create_post_calls: 0,
      marketplace_mutations: 0,
      database_calls: 0,
      model_calls: 0,
    },
  } as const;
}

function resultSummary(
  sessionDir: string,
  resultPath: string,
  result: Record<string, unknown>,
  networkCalls: number,
): WalmartItemReportRequestReconciliationResult {
  const evidence = asRecord(result.evidence, "reconciliation result evidence");
  const candidates = asRecord(result.candidate_set, "reconciliation result candidate_set");
  const outcome = result.outcome;
  if (!(WALMART_ITEM_REPORT_RECONCILIATION_OUTCOMES as readonly unknown[]).includes(outcome)) {
    fail("INVALID_FINAL_RESULT", "reconciliation result outcome is invalid");
  }
  return {
    mode: "EXECUTED",
    state: "RECONCILED",
    outcome: outcome as WalmartItemReportReconciliationOutcome,
    reconciliation_id: exactString(result.reconciliation_id, "reconciliation_id", 64),
    network_calls: networkCalls,
    http_calls: {
      oauth_token_calls: 0,
      walmart_api_calls: networkCalls,
      presigned_file_calls: 0,
      total_http_calls: networkCalls,
    },
    page_count: nonNegativeInteger(evidence.page_count, "result page_count"),
    observed_row_count: nonNegativeInteger(evidence.observed_row_count, "result row_count"),
    candidate_count: nonNegativeInteger(candidates.candidate_count, "result candidate_count"),
    exact_correlation_match_count: nonNegativeInteger(
      candidates.exact_correlation_match_count,
      "result exact match count",
    ),
    duplicate_request_id_count: nonNegativeInteger(
      candidates.duplicate_request_id_count,
      "result duplicate request ID count",
    ),
    session_dir: sessionDir,
    result_artifact_path: path.join(sessionDir, resultPath),
    original_request_complete_written: false,
    request_id_adopted: false,
  };
}

async function maybeLoadFinalResult(
  sessionDir: string,
  names: ReturnType<typeof artifactNames>,
  id: string,
  original: OriginalAmbiguousRequest,
  query: QueryScope,
): Promise<RetainedFinalResult | null> {
  const resultBytes = await secureReadOptional(sessionDir, names.result);
  const completeBytes = await secureReadOptional(sessionDir, names.complete);
  if (completeBytes !== null && resultBytes === null) {
    fail("INVALID_FINAL_CHECKPOINT", "final checkpoint exists without its immutable result");
  }
  if (resultBytes === null) return null;
  if (completeBytes === null) {
    fail(
      "INVALID_FINAL_RESULT",
      "uncheckpointed final result is a partial write and cannot be trusted or promoted",
    );
  }
  const result = parseJsonBytes(resultBytes, "reconciliation result");
  const expectedStatic = {
    session_authority_sha256: original.authority_sha256,
    create_manifest_sha256: original.create_manifest_sha256,
    request_reserved_sha256: original.reserved_sha256,
    manual_review_sha256: original.manual_review_sha256,
    create_correlation_id_sha256: original.authority.primary_correlations.create.sha256,
    retry_forbidden: true,
    manual_review_preserved: true,
  };
  if (result.schema_version !== WALMART_ITEM_REPORT_RECONCILIATION_SCHEMA
    || result.reconciliation_id !== id
    || !sameCanonical(result.account_scope, original.authority.account_scope)
    || !sameCanonical(result.query_scope, query)
    || !sameCanonical(result.original_ambiguous_post, expectedStatic)) {
    fail("INVALID_FINAL_RESULT", "retained reconciliation result is outside the current scope");
  }
  const completedAt = strictCanonicalInstant(result.completed_at, "result completed_at");
  const complete = parseJsonBytes(completeBytes, "final reconciliation checkpoint");
  assertExactKeys(complete, [
    "observed_at", "reconciliation_id", "recovered_without_network", "result_path",
    "result_sha256", "schema_version", "state",
  ], "final reconciliation checkpoint");
  if (complete.schema_version !== WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA
    || complete.reconciliation_id !== id || complete.state !== "COMPLETE"
    || complete.result_path !== names.result || complete.result_sha256 !== sha256Bytes(resultBytes)
    || complete.observed_at !== completedAt || complete.recovered_without_network !== false) {
    fail("INVALID_FINAL_CHECKPOINT", "final reconciliation checkpoint is invalid");
  }
  return { bytes: resultBytes, value: result, completed_at: completedAt };
}

export function planWalmartItemReportRequestReconciliation(
  input: WalmartItemReportRequestReconciliationInput,
): WalmartItemReportRequestReconciliationPlan {
  const storeIndex = positiveInteger(input.store_index, "store_index");
  let start: string | null = null;
  let end: string | null = null;
  if (input.request_submission_start_date !== null
    || input.request_submission_end_date !== null) {
    const window = validateWindow(
      input.request_submission_start_date,
      input.request_submission_end_date,
      null,
      null,
    );
    start = window.start;
    end = window.end;
  }
  return {
    mode: "PLAN",
    network_calls: 0,
    filesystem_writes: 0,
    store_index: storeIndex,
    session_dir: path.resolve(exactString(input.session_dir, "session_dir")),
    request_submission_start_date: start,
    request_submission_end_date: end,
    live_requires: "--execute",
    allowed_network_operations: [
      "POST https://marketplace.walmartapis.com/v3/token",
      "GET https://marketplace.walmartapis.com/v3/reports/reportRequests",
    ],
    marketplace_mutations: 0,
  };
}

export async function runWalmartItemReportRequestReconciliation(
  input: WalmartItemReportRequestReconciliationInput,
  dependencies: WalmartItemReportRequestReconciliationDependencies,
): Promise<WalmartItemReportRequestReconciliationPlan | WalmartItemReportRequestReconciliationResult> {
  if (!input.execute) return planWalmartItemReportRequestReconciliation(input);
  const storeIndex = positiveInteger(input.store_index, "store_index");
  const activeScope = validateAccountScope(
    dependencies.account_scope,
    storeIndex,
    "active credential account_scope",
  );
  const safeSession = await assertWalmartItemReportCaptureSessionDir(
    input.allowed_capture_root,
    input.session_dir,
    false,
  );
  const original = await loadOriginalAmbiguousRequest(safeSession.sessionDir, storeIndex);
  if (!sameCanonical(activeScope, original.authority.account_scope)) {
    fail("ACTIVE_ACCOUNT_SCOPE_MISMATCH", "active credentials do not match SessionAuthority");
  }
  const now = clockNow(dependencies);
  const window = validateWindow(
    input.request_submission_start_date,
    input.request_submission_end_date,
    original,
    now,
  );
  const query = fixedQuery(window.start, window.end);
  const id = reconciliationId(original, query);
  const names = artifactNames(id);
  await loadOrCreateScopeManifest(
    safeSession.sessionDir, names, id, original, query, now, dependencies,
  );
  const retainedFinal = await maybeLoadFinalResult(
    safeSession.sessionDir, names, id, original, query,
  );

  const rows: NormalizedRequestRow[] = [];
  const pages: PageEvidence[] = [];
  const queryDigests = new Set<string>();
  let currentQuery: QueryScope | null = query;
  let totalBytes = 0;
  let networkCalls = 0;
  let expectedTotalCount: number | null = null;
  let pageIndex = 1;
  while (currentQuery !== null) {
    if (pageIndex > WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_pages) {
      fail("PAGE_CAP", "report-request pagination exceeds the fixed page cap");
    }
    const queryDigest = sha256String(canonicalWalmartItemReportJson(currentQuery));
    if (queryDigests.has(queryDigest)) fail("PAGINATION_CYCLE", "report-request pagination repeated a query");
    queryDigests.add(queryDigest);
    const captured = await capturePage(
      safeSession.sessionDir,
      id,
      pageIndex,
      currentQuery,
      original,
      dependencies,
      retainedFinal === null,
    );
    if (currentQuery.page === undefined
      && captured.parsed.advertised_page !== null
      && captured.parsed.advertised_page !== 0
      && captured.parsed.advertised_page !== 1) {
      fail("PAGINATION_DRIFT", "initial response advertises an impossible starting page");
    }
    if (currentQuery.page !== undefined
      && captured.parsed.advertised_page !== Number(currentQuery.page)) {
      fail("PAGINATION_DRIFT", "response page does not match the exact requested page");
    }
    if (currentQuery.limit !== undefined
      && captured.parsed.advertised_limit !== Number(currentQuery.limit)) {
      fail("PAGINATION_DRIFT", "response limit does not match the exact requested limit");
    }
    pages.push(captured.evidence);
    rows.push(...captured.parsed.rows);
    networkCalls += captured.networkCalls;
    totalBytes += Number((await secureRead(
      safeSession.sessionDir,
      captured.evidence.response_body_path,
      WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_page_response_bytes,
    )).byteLength);
    if (totalBytes > WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_total_response_bytes) {
      fail("TOTAL_BYTE_CAP", "captured report-request pages exceed the total byte cap");
    }
    if (rows.length > WALMART_ITEM_REPORT_RECONCILIATION_LIMITS.max_rows) {
      fail("ROW_CAP", "captured report-request rows exceed the total row cap");
    }
    if (captured.parsed.advertised_total_count !== null) {
      if (expectedTotalCount !== null
        && expectedTotalCount !== captured.parsed.advertised_total_count) {
        fail("PAGINATION_DRIFT", "response totalCount changed between pages");
      }
      expectedTotalCount = captured.parsed.advertised_total_count;
    }
    currentQuery = nextQuery(captured.parsed, query, rows.length);
    pageIndex += 1;
  }
  if (expectedTotalCount !== null && rows.length !== expectedTotalCount) {
    fail("PAGINATION_INCOMPLETE", "captured row count does not equal the advertised totalCount");
  }

  const finalResult = buildFinalResult(
    id,
    retainedFinal?.completed_at ?? clockNow(dependencies).toISOString(),
    original,
    query,
    pages,
    rows,
  );
  const resultBytes = canonicalBytes(finalResult);
  if (retainedFinal !== null) {
    if (networkCalls !== 0 || !Buffer.from(retainedFinal.bytes).equals(Buffer.from(resultBytes))) {
      fail("INVALID_FINAL_RESULT", "completed result is not byte-equivalent to sealed page evidence");
    }
    await revalidateOriginalArtifacts(safeSession.sessionDir, original);
    return resultSummary(safeSession.sessionDir, names.result, retainedFinal.value, 0);
  }
  await revalidateOriginalArtifacts(safeSession.sessionDir, original);
  await writeImmutable(safeSession.sessionDir, names.result, resultBytes, dependencies);
  await writeImmutableJson(safeSession.sessionDir, names.complete, {
    schema_version: WALMART_ITEM_REPORT_RECONCILIATION_CHECKPOINT_SCHEMA,
    reconciliation_id: id,
    state: "COMPLETE",
    observed_at: finalResult.completed_at,
    result_path: names.result,
    result_sha256: sha256Bytes(resultBytes),
    recovered_without_network: false,
  }, dependencies);
  await revalidateOriginalArtifacts(safeSession.sessionDir, original);
  return resultSummary(safeSession.sessionDir, names.result, finalResult, networkCalls);
}
