import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type { Client, InStatement, Transaction } from "@libsql/client";

import {
  WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
  canonicalWalmartItemReportJson,
  verifyWalmartItemReportCatalogSource,
  walmartItemReportSha256,
  walmartItemReportUtf8Sha256,
  type SealedWalmartItemReportCatalogSource,
  type WalmartItemReportCatalogRow,
} from "@/lib/walmart/item-report-published-source";
import {
  walmartOwnerPermitTrustedKeys,
  type WalmartOwnerPermitEnvironment,
} from "./walmart-owner-permit";

export const WALMART_NEW_SKU_CATALOG_ACTIVATION_PLAN_SCHEMA =
  "walmart-new-sku-catalog-activation-plan/v2" as const;
export const WALMART_NEW_SKU_CATALOG_ACTIVATION_RECEIPT_SCHEMA =
  "walmart-new-sku-catalog-activation-receipt/v2" as const;
export const WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_SCHEMA =
  "walmart-new-sku-catalog-activation-owner-approval/1.0.0" as const;
export const WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ALGORITHM =
  "Ed25519" as const;
export const WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ACTION =
  "WALMART_ITEM_V6_CATALOG_ACTIVATE" as const;
export const WALMART_NEW_SKU_CATALOG_ACTIVATION_MAX_SOURCE_AGE_MS =
  24 * 60 * 60 * 1_000;
export const WALMART_NEW_SKU_CATALOG_ACTIVATION_MAX_PLAN_AGE_MS =
  30 * 60 * 1_000;
export const WALMART_NEW_SKU_CATALOG_ACTIVATION_FILE_MAX_BYTES =
  128 * 1024 * 1024;

const ITEM_CATALOG_REPORT_TYPE = "ITEM_CATALOG" as const;
const CONFIRMATION_PREFIX =
  "APPLY_WALMART_NEW_SKU_CATALOG_ACTIVATION_V2" as const;
const OWNER_APPROVAL_SIGNING_DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_ITEM_V6_CATALOG_ACTIVATE\0v1\0",
  "utf8",
);
// Stay below SQLite builds that retain the historical 999 bind-parameter cap.
const INSERT_ROWS_PER_STATEMENT = 90;

export const WALMART_NEW_SKU_CATALOG_ACTIVATION_CLAIMS = Object.freeze({
  owner_codex_only: true,
  walmart_api_calls: 0,
  paid_provider_calls: 0,
  marketplace_mutated: false,
  listing_published: false,
  listing_delisted: false,
  repriced: false,
  inventory_purchased: false,
  database_scope: "WalmartCatalogItem(store)+WalmartReport(ITEM_CATALOG)",
  all_status_store_scoped_replace: true,
  transaction_rollback_on_failure: true,
});

export const WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_CLAIMS =
  Object.freeze({
    database_write_authorized: true,
    database_scope: "WalmartCatalogItem(store)+WalmartReport(ITEM_CATALOG)",
    all_status_store_scoped_replace: true,
    walmart_api_calls: 0,
    provider_calls: 0,
    marketplace_mutated: false,
    listing_published: false,
    listing_delisted: false,
    repriced: false,
    inventory_purchased: false,
  });

export type WalmartNewSkuCatalogActivationErrorCode =
  | "INVALID_ACTIVATION_INPUT"
  | "UNSAFE_CATALOG_SOURCE_PATH"
  | "CATALOG_SOURCE_FILE_CHANGED"
  | "CATALOG_SOURCE_FILE_SHA256_MISMATCH"
  | "CATALOG_SOURCE_NOT_CANONICAL"
  | "CATALOG_SOURCE_INVALID"
  | "CATALOG_SOURCE_SCOPE_MISMATCH"
  | "CATALOG_SOURCE_STALE_OR_FUTURE"
  | "CATALOG_SCHEMA_UNAVAILABLE"
  | "CATALOG_DATABASE_STATE_INVALID"
  | "CATALOG_ACTIVATION_BLOCKED"
  | "CATALOG_ACTIVATION_PLAN_INVALID"
  | "CATALOG_ACTIVATION_PLAN_EXPIRED"
  | "CATALOG_ACTIVATION_OWNER_KEY_UNTRUSTED"
  | "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID"
  | "CATALOG_ACTIVATION_OWNER_APPROVAL_EXPIRED"
  | "CATALOG_ACTIVATION_OWNER_APPROVAL_BINDING_MISMATCH"
  | "CATALOG_ACTIVATION_OWNER_APPROVAL_CHANGED"
  | "CATALOG_ACTIVATION_CONFIRMATION_MISMATCH"
  | "CATALOG_ACTIVATION_PRECONDITION_DRIFT"
  | "CATALOG_ACTIVATION_POSTCONDITION_FAILED";

export class WalmartNewSkuCatalogActivationError extends Error {
  readonly code: WalmartNewSkuCatalogActivationErrorCode;

  constructor(code: WalmartNewSkuCatalogActivationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "WalmartNewSkuCatalogActivationError";
    this.code = code;
  }
}

interface SqlExecutor {
  execute(statement: InStatement): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface MirrorStateRow {
  id: string;
  sku: string;
  item_id: string | null;
  title: string | null;
  lifecycle_status: string | null;
  published_status: string | null;
  synced_at: string;
  main_image_url: string | null;
  main_image_fetched_at: string | null;
}

interface ReportStateRow {
  id: string;
  request_id_sha256: string;
  status: string;
  requested_at: string;
  status_checked_at: string | null;
  ready_at: string | null;
  downloaded_at: string | null;
  row_count: number | null;
  error: string | null;
  updated_at: string;
}

interface DatabaseState {
  mirrorRows: MirrorStateRow[];
  reportRows: ReportStateRow[];
  requestConflict: {
    store_index: number;
    report_type: string;
    request_id_sha256: string;
  } | null;
}

interface ExpectedMirrorRow {
  sku: string;
  item_id: string | null;
  title: string | null;
  lifecycle_status: string | null;
  published_status: string;
  synced_at: string;
  main_image_url: string | null;
  main_image_fetched_at: string | null;
}

interface ExpectedLatestReport {
  report_type: typeof ITEM_CATALOG_REPORT_TYPE;
  request_id_sha256: string;
  status: "DOWNLOADED";
  requested_at: string;
  downloaded_at: string;
  row_count: number;
}

interface PostconditionProjection {
  mirror_rows: ExpectedMirrorRow[];
  latest_downloaded_report: ExpectedLatestReport | null;
}

export interface WalmartNewSkuCatalogActivationPlanBody {
  schema_version: typeof WALMART_NEW_SKU_CATALOG_ACTIVATION_PLAN_SCHEMA;
  command: "PLAN";
  environment: string;
  planned_at: string;
  expires_at: string;
  database_target_fingerprint_sha256: string;
  store_index: number;
  account_scope: {
    business_seller_account_fingerprint_sha256: string;
    capture_credential_scope_fingerprint_sha256: string;
  };
  source: {
    absolute_path: string;
    file_sha256: string;
    byte_length: number;
    schema_version: typeof WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA;
    source_id: string;
    body_sha256: string;
    seller_account_fingerprint_sha256: string;
    report_request_id_sha256: string;
    requested_at: string;
    cutoff_at: string;
    downloaded_at: string;
    row_count: number;
    rows_sha256: string;
  };
  current_state: {
    mirror_row_count: number;
    item_catalog_report_row_count: number;
    precondition_sha256: string;
    current_postcondition_sha256: string;
  };
  expected_postcondition_sha256: string;
  action: "ACTIVATE" | "NOOP_ALREADY_ACTIVE";
  eligible_for_apply: boolean;
  blockers: string[];
  claims: typeof WALMART_NEW_SKU_CATALOG_ACTIVATION_CLAIMS;
}

export interface SealedWalmartNewSkuCatalogActivationPlan
  extends WalmartNewSkuCatalogActivationPlanBody {
  plan_sha256: string;
}

export interface WalmartNewSkuCatalogActivationOwnerApprovalSignedBody {
  approval_id: string;
  action: typeof WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ACTION;
  authority_environment: WalmartOwnerPermitEnvironment;
  environment: string;
  plan_sha256: string;
  source_file_sha256: string;
  source_body_sha256: string;
  source_rows_sha256: string;
  report_request_id_sha256: string;
  store_index: number;
  business_seller_account_fingerprint_sha256: string;
  capture_credential_scope_fingerprint_sha256: string;
  database_target_fingerprint_sha256: string;
  expected_postcondition_sha256: string;
  issued_at: string;
  expires_at: string;
  approved_by: string;
  decision_ref: string;
  claims: typeof WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_CLAIMS;
}

export interface WalmartNewSkuCatalogActivationOwnerApprovalEnvelope {
  schema_version:
    typeof WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_SCHEMA;
  algorithm:
    typeof WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ALGORITHM;
  key_id: string;
  owner_public_key_spki_sha256: string;
  signed_body: WalmartNewSkuCatalogActivationOwnerApprovalSignedBody;
}

export interface WalmartNewSkuCatalogActivationOwnerApprovalSigningRequest
  extends WalmartNewSkuCatalogActivationOwnerApprovalEnvelope {
  signing_message_base64: string;
  signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64";
  signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE";
  approval_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE";
}

export interface WalmartNewSkuCatalogActivationOwnerApproval
  extends WalmartNewSkuCatalogActivationOwnerApprovalEnvelope {
  signature_base64: string;
  signature_sha256: string;
  approval_sha256: string;
}

export interface WalmartNewSkuCatalogActivationReceiptBody {
  schema_version: typeof WALMART_NEW_SKU_CATALOG_ACTIVATION_RECEIPT_SCHEMA;
  status: "ACTIVE";
  environment: string;
  plan_sha256: string;
  database_target_fingerprint_sha256: string;
  store_index: number;
  business_seller_account_fingerprint_sha256: string;
  capture_credential_scope_fingerprint_sha256: string;
  owner_approval_sha256: string;
  owner_approval_artifact_sha256: string;
  source_file_sha256: string;
  source_id: string;
  source_body_sha256: string;
  report_request_id_sha256: string;
  active_synced_at: string;
  row_count: number;
  postcondition_sha256: string;
  claims: typeof WALMART_NEW_SKU_CATALOG_ACTIVATION_CLAIMS;
}

export interface SealedWalmartNewSkuCatalogActivationReceipt
  extends WalmartNewSkuCatalogActivationReceiptBody {
  receipt_id: string;
  receipt_sha256: string;
}

export interface PlanWalmartNewSkuCatalogActivationInput {
  db: Client;
  sourcePath: string;
  expectedSourceFileSha256: string;
  storeIndex: number;
  businessSellerAccountFingerprintSha256: string;
  activeCaptureCredentialScopeFingerprintSha256: string;
  databaseTargetFingerprintSha256: string;
  environment: string;
  now: Date;
  expiresAt?: Date;
}

export interface ApplyWalmartNewSkuCatalogActivationInput {
  db: Client;
  plan: unknown;
  ownerApproval: unknown;
  ownerApprovalArtifactSha256: string;
  confirmation: string;
  businessSellerAccountFingerprintSha256: string;
  activeCaptureCredentialScopeFingerprintSha256: string;
  databaseTargetFingerprintSha256: string;
  environment: string;
  now: Date;
  ownerTrustEnvironment?: NodeJS.ProcessEnv;
  recheckOwnerApproval: () => Promise<{
    approval: unknown;
    artifactSha256: string;
    businessSellerAccountFingerprintSha256: string;
    activeCaptureCredentialScopeFingerprintSha256: string;
  }>;
  testHooks?: {
    afterStoreDelete?: (transaction: Transaction) => Promise<void>;
    beforeCommit?: (transaction: Transaction) => Promise<void>;
  };
}

export interface ApplyWalmartNewSkuCatalogActivationResult {
  receipt: SealedWalmartNewSkuCatalogActivationReceipt;
  database_changed: boolean;
  idempotent_replay: boolean;
}

function fail(
  code: WalmartNewSkuCatalogActivationErrorCode,
  message: string,
): never {
  throw new WalmartNewSkuCatalogActivationError(code, message);
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("INVALID_ACTIVATION_INPUT", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function exactEnvironment(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) {
    fail(
      "INVALID_ACTIVATION_INPUT",
      "environment must be 1-64 lowercase letters, digits, underscore, or hyphen",
    );
  }
  return value;
}

function exactStoreIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("INVALID_ACTIVATION_INPUT", "storeIndex must be a positive safe integer");
  }
  return Number(value);
}

function exactNow(value: unknown, label = "now"): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("INVALID_ACTIVATION_INPUT", `${label} must be a valid Date`);
  }
  return value;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", `${label} must be a non-empty exact string`);
  }
  return value;
}

function exactInteger(value: unknown, label: string, minimum = 0): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < minimum) {
    fail(
      "CATALOG_ACTIVATION_PLAN_INVALID",
      `${label} must be a safe integer >= ${minimum}`,
    );
  }
  return Number(normalized);
}

function exactIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", `${label} must be an ISO timestamp`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalWalmartItemReportJson(actual) !== canonicalWalmartItemReportJson(expected)) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", `${label} fields are not exact`);
  }
}

function sameClaims(value: unknown): boolean {
  return canonicalWalmartItemReportJson(value)
    === canonicalWalmartItemReportJson(WALMART_NEW_SKU_CATALOG_ACTIVATION_CLAIMS);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dbNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    fail("CATALOG_DATABASE_STATE_INVALID", `${label} must be string or null`);
  }
  return value;
}

function dbString(value: unknown, label: string): string {
  const parsed = dbNullableString(value, label);
  if (!parsed) fail("CATALOG_DATABASE_STATE_INVALID", `${label} must not be empty`);
  return parsed;
}

function dbInteger(value: unknown, label: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized)) {
    fail("CATALOG_DATABASE_STATE_INVALID", `${label} must be a safe integer`);
  }
  return Number(normalized);
}

function dbIso(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const parsed = new Date(
    typeof value === "bigint" ? Number(value) : value as string | number,
  );
  if (!Number.isFinite(parsed.getTime())) {
    fail("CATALOG_DATABASE_STATE_INVALID", `${label} must be a timestamp`);
  }
  return parsed.toISOString();
}

function sameFileStat(
  left: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readPinnedCatalogSource(input: {
  path: string;
  expectedSha256: string;
}): Promise<{
  bytes: Buffer;
  fileSha256: string;
  source: SealedWalmartItemReportCatalogSource;
}> {
  const expectedSha256 = exactSha256(input.expectedSha256, "expectedSourceFileSha256");
  if (!isAbsolute(input.path) || resolve(input.path) !== input.path || input.path.includes("\0")) {
    fail(
      "UNSAFE_CATALOG_SOURCE_PATH",
      "catalog source path must be normalized and absolute",
    );
  }
  const beforePath = await lstat(input.path).catch(() => null);
  if (!beforePath || !beforePath.isFile() || beforePath.isSymbolicLink()
    || beforePath.nlink !== 1) {
    fail(
      "UNSAFE_CATALOG_SOURCE_PATH",
      "catalog source must be a single-link non-symlink regular file",
    );
  }
  const permissions = beforePath.mode & 0o777;
  if ((permissions & 0o077) !== 0 || (permissions & 0o400) === 0
    || (permissions & 0o111) !== 0) {
    fail(
      "UNSAFE_CATALOG_SOURCE_PATH",
      "catalog source must be owner-readable, non-executable, and inaccessible to group/other",
    );
  }
  if (beforePath.size < 2
    || beforePath.size > WALMART_NEW_SKU_CATALOG_ACTIVATION_FILE_MAX_BYTES) {
    fail("UNSAFE_CATALOG_SOURCE_PATH", "catalog source size is outside safety bounds");
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(input.path, flags).catch(() => null);
  if (!handle) {
    fail("UNSAFE_CATALOG_SOURCE_PATH", "catalog source cannot be opened without symlinks");
  }
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileStat(beforePath, opened)) {
      fail("CATALOG_SOURCE_FILE_CHANGED", "catalog source changed before read");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size || !sameFileStat(opened, after)) {
      fail("CATALOG_SOURCE_FILE_CHANGED", "catalog source changed during read");
    }
  } finally {
    await handle.close();
  }
  const afterPath = await lstat(input.path).catch(() => null);
  if (!afterPath || !afterPath.isFile() || afterPath.isSymbolicLink()
    || afterPath.nlink !== 1 || !sameFileStat(beforePath, afterPath)) {
    fail("CATALOG_SOURCE_FILE_CHANGED", "catalog source path changed during read");
  }
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  if (fileSha256 !== expectedSha256) {
    fail(
      "CATALOG_SOURCE_FILE_SHA256_MISMATCH",
      "catalog source bytes differ from the independently supplied SHA-256",
    );
  }
  let parsed: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("CATALOG_SOURCE_INVALID", "catalog source must be strict UTF-8 JSON");
  }
  let source: SealedWalmartItemReportCatalogSource;
  try {
    source = verifyWalmartItemReportCatalogSource(parsed);
  } catch (error) {
    fail(
      "CATALOG_SOURCE_INVALID",
      `catalog source seal is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalWalmartItemReportJson(source) !== text) {
    fail(
      "CATALOG_SOURCE_NOT_CANONICAL",
      "catalog source bytes must be the exact canonical verified JSON",
    );
  }
  return { bytes, fileSha256, source };
}

function assertSourceScopeAndFreshness(input: {
  source: SealedWalmartItemReportCatalogSource;
  storeIndex: number;
  activeCaptureCredentialScopeFingerprintSha256: string;
  now: Date;
}): void {
  if (input.source.account_scope.channel !== "WALMART_US"
    || input.source.account_scope.store_index !== input.storeIndex
    || input.source.account_scope.seller_account_fingerprint_sha256
      !== input.activeCaptureCredentialScopeFingerprintSha256) {
    fail(
      "CATALOG_SOURCE_SCOPE_MISMATCH",
      "catalog source does not belong to the current Walmart credential/store scope",
    );
  }
  const nowMs = input.now.getTime();
  const requested = Date.parse(input.source.report.requested_at);
  const cutoff = Date.parse(input.source.report.cutoff_at);
  const downloaded = Date.parse(input.source.report.downloaded_at);
  if (![requested, cutoff, downloaded].every(Number.isFinite)
    || requested > cutoff || cutoff > downloaded
    || cutoff > nowMs || downloaded > nowMs
    || nowMs - cutoff > WALMART_NEW_SKU_CATALOG_ACTIVATION_MAX_SOURCE_AGE_MS
    || nowMs - downloaded > WALMART_NEW_SKU_CATALOG_ACTIVATION_MAX_SOURCE_AGE_MS) {
    fail(
      "CATALOG_SOURCE_STALE_OR_FUTURE",
      "catalog source chronology must be nonfuture and no older than 24 hours",
    );
  }
}

async function executeRows(
  executor: SqlExecutor,
  statement: InStatement,
): Promise<Array<Record<string, unknown>>> {
  try {
    return (await executor.execute(statement)).rows;
  } catch (error) {
    fail(
      "CATALOG_SCHEMA_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function readDatabaseState(input: {
  executor: SqlExecutor;
  storeIndex: number;
  sourceRequestId: string;
}): Promise<DatabaseState> {
  // Keep transaction executors strictly sequential. Remote libSQL transactions
  // are not required to support concurrent statements on one transaction.
  const mirrorRaw = await executeRows(input.executor, {
      sql: `SELECT id,sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt,
                   mainImageUrl,mainImageFetchedAt
            FROM WalmartCatalogItem
            WHERE storeIndex=?
            ORDER BY sku,id`,
      args: [input.storeIndex],
    });
  const reportRaw = await executeRows(input.executor, {
      sql: `SELECT id,requestId,status,requestedAt,statusCheckedAt,readyAt,
                   downloadedAt,rowCount,error,updatedAt
            FROM WalmartReport
            WHERE storeIndex=? AND reportType='ITEM_CATALOG'
            ORDER BY requestedAt,id`,
      args: [input.storeIndex],
    });
  const conflictRaw = await executeRows(input.executor, {
      sql: `SELECT storeIndex,reportType,requestId
            FROM WalmartReport WHERE requestId=? LIMIT 1`,
      args: [input.sourceRequestId],
    });
  const mirrorRows = mirrorRaw.map((row, index): MirrorStateRow => ({
    id: dbString(row.id, `WalmartCatalogItem[${index}].id`),
    sku: dbString(row.sku, `WalmartCatalogItem[${index}].sku`),
    item_id: dbNullableString(row.itemId, `WalmartCatalogItem[${index}].itemId`),
    title: dbNullableString(row.title, `WalmartCatalogItem[${index}].title`),
    lifecycle_status: dbNullableString(
      row.lifecycleStatus,
      `WalmartCatalogItem[${index}].lifecycleStatus`,
    ),
    published_status: dbNullableString(
      row.publishedStatus,
      `WalmartCatalogItem[${index}].publishedStatus`,
    ),
    synced_at: dbIso(row.syncedAt, `WalmartCatalogItem[${index}].syncedAt`)!,
    main_image_url: dbNullableString(
      row.mainImageUrl,
      `WalmartCatalogItem[${index}].mainImageUrl`,
    ),
    main_image_fetched_at: dbIso(
      row.mainImageFetchedAt,
      `WalmartCatalogItem[${index}].mainImageFetchedAt`,
      true,
    ),
  }));
  if (new Set(mirrorRows.map((row) => row.sku)).size !== mirrorRows.length) {
    fail("CATALOG_DATABASE_STATE_INVALID", "WalmartCatalogItem has duplicate store/SKU rows");
  }
  const reportRows = reportRaw.map((row, index): ReportStateRow => ({
    id: dbString(row.id, `WalmartReport[${index}].id`),
    request_id_sha256: walmartItemReportUtf8Sha256(
      dbString(row.requestId, `WalmartReport[${index}].requestId`),
    ),
    status: dbString(row.status, `WalmartReport[${index}].status`),
    requested_at: dbIso(row.requestedAt, `WalmartReport[${index}].requestedAt`)!,
    status_checked_at: dbIso(
      row.statusCheckedAt,
      `WalmartReport[${index}].statusCheckedAt`,
      true,
    ),
    ready_at: dbIso(row.readyAt, `WalmartReport[${index}].readyAt`, true),
    downloaded_at: dbIso(
      row.downloadedAt,
      `WalmartReport[${index}].downloadedAt`,
      true,
    ),
    row_count: dbInteger(row.rowCount, `WalmartReport[${index}].rowCount`, true),
    error: dbNullableString(row.error, `WalmartReport[${index}].error`),
    updated_at: dbIso(row.updatedAt, `WalmartReport[${index}].updatedAt`)!,
  }));
  const conflict = conflictRaw[0];
  const requestConflict = conflict
    ? {
        store_index: dbInteger(conflict.storeIndex, "WalmartReport conflict storeIndex")!,
        report_type: dbString(conflict.reportType, "WalmartReport conflict reportType"),
        request_id_sha256: walmartItemReportUtf8Sha256(
          dbString(conflict.requestId, "WalmartReport conflict requestId"),
        ),
      }
    : null;
  return { mirrorRows, reportRows, requestConflict };
}

function sourceItemId(row: WalmartItemReportCatalogRow): string | null {
  return row.reported_legacy_item_identifier_opaque
    ?? row.reported_legacy_wpid_opaque;
}

function expectedMirrorRows(
  source: SealedWalmartItemReportCatalogSource,
  current: DatabaseState,
): ExpectedMirrorRow[] {
  const images = new Map(
    current.mirrorRows.map((row) => [
      row.sku,
      {
        main_image_url: row.main_image_url,
        main_image_fetched_at: row.main_image_fetched_at,
      },
    ]),
  );
  return source.rows.map((row): ExpectedMirrorRow => {
    const image = images.get(row.sku);
    return {
      sku: row.sku,
      item_id: sourceItemId(row),
      title: row.reported_product_name,
      lifecycle_status: row.reported_lifecycle_status,
      published_status: row.published_status,
      synced_at: source.report.downloaded_at,
      main_image_url: image?.main_image_url ?? null,
      main_image_fetched_at: image?.main_image_fetched_at ?? null,
    };
  }).sort((left, right) => compareCodeUnits(left.sku, right.sku));
}

function latestDownloadedReport(rows: ReportStateRow[]): ReportStateRow | null {
  return rows
    .filter((row) => row.status === "DOWNLOADED" && row.downloaded_at !== null)
    .sort((left, right) => {
      const downloaded = Date.parse(right.downloaded_at!) - Date.parse(left.downloaded_at!);
      if (downloaded !== 0) return downloaded;
      const requested = Date.parse(right.requested_at) - Date.parse(left.requested_at);
      if (requested !== 0) return requested;
      return compareCodeUnits(right.id, left.id);
    })[0] ?? null;
}

function currentPostconditionProjection(state: DatabaseState): PostconditionProjection {
  const latest = latestDownloadedReport(state.reportRows);
  return {
    mirror_rows: state.mirrorRows.map((row): ExpectedMirrorRow => ({
      sku: row.sku,
      item_id: row.item_id,
      title: row.title,
      lifecycle_status: row.lifecycle_status,
      published_status: row.published_status ?? "",
      synced_at: row.synced_at,
      main_image_url: row.main_image_url,
      main_image_fetched_at: row.main_image_fetched_at,
    })).sort((left, right) => compareCodeUnits(left.sku, right.sku)),
    latest_downloaded_report: latest
      ? {
          report_type: ITEM_CATALOG_REPORT_TYPE,
          request_id_sha256: latest.request_id_sha256,
          status: "DOWNLOADED",
          requested_at: latest.requested_at,
          downloaded_at: latest.downloaded_at!,
          row_count: latest.row_count ?? -1,
        }
      : null,
  };
}

function expectedPostconditionProjection(input: {
  source: SealedWalmartItemReportCatalogSource;
  current: DatabaseState;
}): PostconditionProjection {
  return {
    mirror_rows: expectedMirrorRows(input.source, input.current),
    latest_downloaded_report: {
      report_type: ITEM_CATALOG_REPORT_TYPE,
      request_id_sha256: input.source.report.report_request_id_sha256,
      status: "DOWNLOADED",
      requested_at: input.source.report.requested_at,
      downloaded_at: input.source.report.downloaded_at,
      row_count: input.source.rows.length,
    },
  };
}

function preconditionSha256(state: DatabaseState): string {
  return walmartItemReportSha256({
    mirror_rows: state.mirrorRows,
    report_rows: state.reportRows,
    request_conflict: state.requestConflict,
  });
}

function postconditionSha256(projection: PostconditionProjection): string {
  return walmartItemReportSha256(projection);
}

function activationBlockers(input: {
  source: SealedWalmartItemReportCatalogSource;
  state: DatabaseState;
}): string[] {
  const blockers: string[] = [];
  if (input.state.requestConflict
    && (input.state.requestConflict.store_index !== input.source.account_scope.store_index
      || input.state.requestConflict.report_type !== ITEM_CATALOG_REPORT_TYPE)) {
    blockers.push("REPORT_REQUEST_ID_CONFLICTS_WITH_ANOTHER_SCOPE");
  }
  const sourceDownloaded = Date.parse(input.source.report.downloaded_at);
  for (const report of input.state.reportRows) {
    if (report.status !== "DOWNLOADED" || report.downloaded_at === null
      || report.request_id_sha256 === input.source.report.report_request_id_sha256) {
      continue;
    }
    if (Date.parse(report.downloaded_at) >= sourceDownloaded) {
      blockers.push("DIFFERENT_EQUAL_OR_NEWER_ITEM_CATALOG_REPORT_EXISTS");
      break;
    }
  }
  return blockers;
}

function planBodySha256(body: WalmartNewSkuCatalogActivationPlanBody): string {
  return walmartItemReportSha256(body);
}

function sourceBinding(input: {
  source: SealedWalmartItemReportCatalogSource;
  path: string;
  fileSha256: string;
  byteLength: number;
}): WalmartNewSkuCatalogActivationPlanBody["source"] {
  return {
    absolute_path: input.path,
    file_sha256: input.fileSha256,
    byte_length: input.byteLength,
    schema_version: WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
    source_id: input.source.source_id,
    body_sha256: input.source.body_sha256,
    seller_account_fingerprint_sha256:
      input.source.account_scope.seller_account_fingerprint_sha256,
    report_request_id_sha256: input.source.report.report_request_id_sha256,
    requested_at: input.source.report.requested_at,
    cutoff_at: input.source.report.cutoff_at,
    downloaded_at: input.source.report.downloaded_at,
    row_count: input.source.rows.length,
    rows_sha256: input.source.reconciliation.rows_sha256,
  };
}

export async function planWalmartNewSkuCatalogActivation(
  input: PlanWalmartNewSkuCatalogActivationInput,
): Promise<SealedWalmartNewSkuCatalogActivationPlan> {
  const storeIndex = exactStoreIndex(input.storeIndex);
  const now = exactNow(input.now);
  const environment = exactEnvironment(input.environment);
  const targetFingerprint = exactSha256(
    input.databaseTargetFingerprintSha256,
    "databaseTargetFingerprintSha256",
  );
  const businessSellerFingerprint = exactSha256(
    input.businessSellerAccountFingerprintSha256,
    "businessSellerAccountFingerprintSha256",
  );
  const captureCredentialFingerprint = exactSha256(
    input.activeCaptureCredentialScopeFingerprintSha256,
    "activeCaptureCredentialScopeFingerprintSha256",
  );
  const expiresAt = input.expiresAt
    ? exactNow(input.expiresAt, "expiresAt")
    : new Date(now.getTime() + WALMART_NEW_SKU_CATALOG_ACTIVATION_MAX_PLAN_AGE_MS);
  if (expiresAt.getTime() <= now.getTime()
    || expiresAt.getTime() - now.getTime()
      > WALMART_NEW_SKU_CATALOG_ACTIVATION_MAX_PLAN_AGE_MS) {
    fail(
      "INVALID_ACTIVATION_INPUT",
      "expiresAt must be after now and no more than 30 minutes later",
    );
  }
  const pinned = await readPinnedCatalogSource({
    path: input.sourcePath,
    expectedSha256: input.expectedSourceFileSha256,
  });
  assertSourceScopeAndFreshness({
    source: pinned.source,
    storeIndex,
    activeCaptureCredentialScopeFingerprintSha256: captureCredentialFingerprint,
    now,
  });
  if (expiresAt.getTime() > Date.parse(pinned.source.report.downloaded_at)
      + WALMART_NEW_SKU_CATALOG_ACTIVATION_MAX_SOURCE_AGE_MS) {
    fail(
      "INVALID_ACTIVATION_INPUT",
      "plan may not outlive the pinned catalog source freshness window",
    );
  }
  const state = await readDatabaseState({
    executor: input.db,
    storeIndex,
    sourceRequestId: pinned.source.report.report_request_id,
  });
  const blockers = activationBlockers({ source: pinned.source, state });
  const currentPostSha256 = postconditionSha256(currentPostconditionProjection(state));
  const expectedPostSha256 = postconditionSha256(expectedPostconditionProjection({
    source: pinned.source,
    current: state,
  }));
  const body: WalmartNewSkuCatalogActivationPlanBody = {
    schema_version: WALMART_NEW_SKU_CATALOG_ACTIVATION_PLAN_SCHEMA,
    command: "PLAN",
    environment,
    planned_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    database_target_fingerprint_sha256: targetFingerprint,
    store_index: storeIndex,
    account_scope: {
      business_seller_account_fingerprint_sha256: businessSellerFingerprint,
      capture_credential_scope_fingerprint_sha256: captureCredentialFingerprint,
    },
    source: sourceBinding({
      source: pinned.source,
      path: input.sourcePath,
      fileSha256: pinned.fileSha256,
      byteLength: pinned.bytes.byteLength,
    }),
    current_state: {
      mirror_row_count: state.mirrorRows.length,
      item_catalog_report_row_count: state.reportRows.length,
      precondition_sha256: preconditionSha256(state),
      current_postcondition_sha256: currentPostSha256,
    },
    expected_postcondition_sha256: expectedPostSha256,
    action: currentPostSha256 === expectedPostSha256
      ? "NOOP_ALREADY_ACTIVE"
      : "ACTIVATE",
    eligible_for_apply: blockers.length === 0,
    blockers,
    claims: WALMART_NEW_SKU_CATALOG_ACTIVATION_CLAIMS,
  };
  return verifyWalmartNewSkuCatalogActivationPlan({
    ...body,
    plan_sha256: planBodySha256(body),
  });
}

export function verifyWalmartNewSkuCatalogActivationPlan(
  input: unknown,
): SealedWalmartNewSkuCatalogActivationPlan {
  const root = record(input, "catalog activation plan");
  assertExactKeys(root, [
    "schema_version",
    "command",
    "environment",
    "planned_at",
    "expires_at",
    "database_target_fingerprint_sha256",
    "store_index",
    "account_scope",
    "source",
    "current_state",
    "expected_postcondition_sha256",
    "action",
    "eligible_for_apply",
    "blockers",
    "claims",
    "plan_sha256",
  ], "catalog activation plan");
  if (root.schema_version !== WALMART_NEW_SKU_CATALOG_ACTIVATION_PLAN_SCHEMA
    || root.command !== "PLAN") {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "plan schema or command is invalid");
  }
  const source = record(root.source, "plan.source");
  const accountScope = record(root.account_scope, "plan.account_scope");
  assertExactKeys(accountScope, [
    "business_seller_account_fingerprint_sha256",
    "capture_credential_scope_fingerprint_sha256",
  ], "plan.account_scope");
  assertExactKeys(source, [
    "absolute_path",
    "file_sha256",
    "byte_length",
    "schema_version",
    "source_id",
    "body_sha256",
    "seller_account_fingerprint_sha256",
    "report_request_id_sha256",
    "requested_at",
    "cutoff_at",
    "downloaded_at",
    "row_count",
    "rows_sha256",
  ], "plan.source");
  const current = record(root.current_state, "plan.current_state");
  assertExactKeys(current, [
    "mirror_row_count",
    "item_catalog_report_row_count",
    "precondition_sha256",
    "current_postcondition_sha256",
  ], "plan.current_state");
  const absolutePath = exactString(source.absolute_path, "plan.source.absolute_path");
  if (!isAbsolute(absolutePath) || resolve(absolutePath) !== absolutePath) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "plan source path is not normalized absolute");
  }
  const plannedAt = exactIso(root.planned_at, "plan.planned_at");
  const expiresAt = exactIso(root.expires_at, "plan.expires_at");
  const requestedAt = exactIso(source.requested_at, "plan.source.requested_at");
  const cutoffAt = exactIso(source.cutoff_at, "plan.source.cutoff_at");
  const downloadedAt = exactIso(source.downloaded_at, "plan.source.downloaded_at");
  if (Date.parse(plannedAt) >= Date.parse(expiresAt)
    || Date.parse(expiresAt) - Date.parse(plannedAt)
      > WALMART_NEW_SKU_CATALOG_ACTIVATION_MAX_PLAN_AGE_MS
    || Date.parse(requestedAt) > Date.parse(cutoffAt)
    || Date.parse(cutoffAt) > Date.parse(downloadedAt)) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "plan or source chronology is invalid");
  }
  if (source.schema_version !== WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "plan source schema is invalid");
  }
  const blockers = Array.isArray(root.blockers)
    && root.blockers.every((value) => typeof value === "string" && value.length > 0)
    ? [...root.blockers] as string[]
    : fail("CATALOG_ACTIVATION_PLAN_INVALID", "plan blockers must be exact strings");
  const eligible = root.eligible_for_apply === true;
  if (root.eligible_for_apply !== (blockers.length === 0)
    || (root.action !== "ACTIVATE" && root.action !== "NOOP_ALREADY_ACTIVE")
    || !sameClaims(root.claims)) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "plan policy fields are inconsistent");
  }
  const parsed: SealedWalmartNewSkuCatalogActivationPlan = {
    schema_version: WALMART_NEW_SKU_CATALOG_ACTIVATION_PLAN_SCHEMA,
    command: "PLAN",
    environment: exactEnvironment(root.environment),
    planned_at: plannedAt,
    expires_at: expiresAt,
    database_target_fingerprint_sha256: exactSha256(
      root.database_target_fingerprint_sha256,
      "plan.database_target_fingerprint_sha256",
    ),
    store_index: exactStoreIndex(root.store_index),
    account_scope: {
      business_seller_account_fingerprint_sha256: exactSha256(
        accountScope.business_seller_account_fingerprint_sha256,
        "plan.account_scope.business_seller_account_fingerprint_sha256",
      ),
      capture_credential_scope_fingerprint_sha256: exactSha256(
        accountScope.capture_credential_scope_fingerprint_sha256,
        "plan.account_scope.capture_credential_scope_fingerprint_sha256",
      ),
    },
    source: {
      absolute_path: absolutePath,
      file_sha256: exactSha256(source.file_sha256, "plan.source.file_sha256"),
      byte_length: exactInteger(source.byte_length, "plan.source.byte_length", 2),
      schema_version: WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
      source_id: exactString(source.source_id, "plan.source.source_id"),
      body_sha256: exactSha256(source.body_sha256, "plan.source.body_sha256"),
      seller_account_fingerprint_sha256: exactSha256(
        source.seller_account_fingerprint_sha256,
        "plan.source.seller_account_fingerprint_sha256",
      ),
      report_request_id_sha256: exactSha256(
        source.report_request_id_sha256,
        "plan.source.report_request_id_sha256",
      ),
      requested_at: requestedAt,
      cutoff_at: cutoffAt,
      downloaded_at: downloadedAt,
      row_count: exactInteger(source.row_count, "plan.source.row_count", 1),
      rows_sha256: exactSha256(source.rows_sha256, "plan.source.rows_sha256"),
    },
    current_state: {
      mirror_row_count: exactInteger(
        current.mirror_row_count,
        "plan.current_state.mirror_row_count",
      ),
      item_catalog_report_row_count: exactInteger(
        current.item_catalog_report_row_count,
        "plan.current_state.item_catalog_report_row_count",
      ),
      precondition_sha256: exactSha256(
        current.precondition_sha256,
        "plan.current_state.precondition_sha256",
      ),
      current_postcondition_sha256: exactSha256(
        current.current_postcondition_sha256,
        "plan.current_state.current_postcondition_sha256",
      ),
    },
    expected_postcondition_sha256: exactSha256(
      root.expected_postcondition_sha256,
      "plan.expected_postcondition_sha256",
    ),
    action: root.action,
    eligible_for_apply: eligible,
    blockers,
    claims: WALMART_NEW_SKU_CATALOG_ACTIVATION_CLAIMS,
    plan_sha256: exactSha256(root.plan_sha256, "plan.plan_sha256"),
  };
  if (parsed.source.byte_length > WALMART_NEW_SKU_CATALOG_ACTIVATION_FILE_MAX_BYTES
    || parsed.source.seller_account_fingerprint_sha256
      !== parsed.account_scope.capture_credential_scope_fingerprint_sha256
    || parsed.source.source_id
      !== `walmart-item-report-catalog-${parsed.source.body_sha256.slice(0, 16)}`
    || (parsed.action === "NOOP_ALREADY_ACTIVE"
      && parsed.current_state.current_postcondition_sha256
        !== parsed.expected_postcondition_sha256)
    || (parsed.action === "ACTIVATE"
      && parsed.current_state.current_postcondition_sha256
        === parsed.expected_postcondition_sha256)) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "plan source or action binding is invalid");
  }
  const { plan_sha256: actual, ...body } = parsed;
  if (planBodySha256(body) !== actual) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "plan seal is invalid");
  }
  return parsed;
}

function approvalAuthorityEnvironment(environment: string): WalmartOwnerPermitEnvironment {
  if (environment === "production") return "PRODUCTION";
  if (environment === "test_fixture_only") return "TEST_FIXTURE_ONLY";
  fail(
    "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID",
    "catalog activation environment has no owner-signing authority domain",
  );
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || !value || /\s/u.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.byteLength > 0 && bytes.toString("base64") === value;
  } catch {
    return false;
  }
}

function approvalReference(value: unknown, label: string): string {
  const parsed = exactString(value, label);
  if (/TODO|PLACEHOLDER/u.test(parsed.toUpperCase())) {
    fail("CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID", `${label} is a placeholder`);
  }
  return parsed;
}

function decisionReference(value: unknown): string {
  const parsed = approvalReference(value, "owner approval decision_ref");
  try {
    const url = new URL(parsed);
    if (!url.protocol || url.protocol === "javascript:") throw new Error("unsafe protocol");
  } catch {
    fail(
      "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID",
      "owner approval decision_ref must be an absolute non-javascript URL",
    );
  }
  return parsed;
}

function approvalKey(input: {
  keyId: string;
  environment: WalmartOwnerPermitEnvironment;
  env?: NodeJS.ProcessEnv;
}) {
  let keys;
  try {
    keys = walmartOwnerPermitTrustedKeys(input.env);
  } catch (error) {
    fail(
      "CATALOG_ACTIVATION_OWNER_KEY_UNTRUSTED",
      error instanceof Error ? error.message : String(error),
    );
  }
  const key = keys.find((candidate) => candidate.key_id === input.keyId);
  if (!key || key.status !== "ACTIVE" || key.environment !== input.environment) {
    fail(
      "CATALOG_ACTIVATION_OWNER_KEY_UNTRUSTED",
      "catalog activation owner key is absent, revoked, or belongs to another authority domain",
    );
  }
  return key;
}

export function walmartNewSkuCatalogActivationOwnerApprovalSigningMessage(
  envelope: WalmartNewSkuCatalogActivationOwnerApprovalEnvelope,
): Buffer {
  return Buffer.concat([
    OWNER_APPROVAL_SIGNING_DOMAIN,
    Buffer.from(canonicalWalmartItemReportJson(envelope), "utf8"),
  ]);
}

function ownerApprovalSignedBody(
  input: unknown,
): WalmartNewSkuCatalogActivationOwnerApprovalSignedBody {
  const value = record(input, "catalog activation owner approval signed_body");
  assertExactKeys(value, [
    "approval_id",
    "action",
    "authority_environment",
    "environment",
    "plan_sha256",
    "source_file_sha256",
    "source_body_sha256",
    "source_rows_sha256",
    "report_request_id_sha256",
    "store_index",
    "business_seller_account_fingerprint_sha256",
    "capture_credential_scope_fingerprint_sha256",
    "database_target_fingerprint_sha256",
    "expected_postcondition_sha256",
    "issued_at",
    "expires_at",
    "approved_by",
    "decision_ref",
    "claims",
  ], "catalog activation owner approval signed_body");
  if (value.action !== WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ACTION
    || (value.authority_environment !== "PRODUCTION"
      && value.authority_environment !== "TEST_FIXTURE_ONLY")
    || canonicalWalmartItemReportJson(value.claims)
      !== canonicalWalmartItemReportJson(
        WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_CLAIMS,
      )) {
    fail(
      "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID",
      "catalog activation owner approval action, authority, or claims are invalid",
    );
  }
  const approvalId = approvalReference(value.approval_id, "owner approval approval_id");
  if (!/^[-a-zA-Z0-9:._/]{8,200}$/u.test(approvalId)) {
    fail("CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID", "owner approval approval_id is invalid");
  }
  return {
    approval_id: approvalId,
    action: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ACTION,
    authority_environment: value.authority_environment,
    environment: exactEnvironment(value.environment),
    plan_sha256: exactSha256(value.plan_sha256, "owner approval plan_sha256"),
    source_file_sha256: exactSha256(
      value.source_file_sha256,
      "owner approval source_file_sha256",
    ),
    source_body_sha256: exactSha256(
      value.source_body_sha256,
      "owner approval source_body_sha256",
    ),
    source_rows_sha256: exactSha256(
      value.source_rows_sha256,
      "owner approval source_rows_sha256",
    ),
    report_request_id_sha256: exactSha256(
      value.report_request_id_sha256,
      "owner approval report_request_id_sha256",
    ),
    store_index: exactStoreIndex(value.store_index),
    business_seller_account_fingerprint_sha256: exactSha256(
      value.business_seller_account_fingerprint_sha256,
      "owner approval business_seller_account_fingerprint_sha256",
    ),
    capture_credential_scope_fingerprint_sha256: exactSha256(
      value.capture_credential_scope_fingerprint_sha256,
      "owner approval capture_credential_scope_fingerprint_sha256",
    ),
    database_target_fingerprint_sha256: exactSha256(
      value.database_target_fingerprint_sha256,
      "owner approval database_target_fingerprint_sha256",
    ),
    expected_postcondition_sha256: exactSha256(
      value.expected_postcondition_sha256,
      "owner approval expected_postcondition_sha256",
    ),
    issued_at: exactIso(value.issued_at, "owner approval issued_at"),
    expires_at: exactIso(value.expires_at, "owner approval expires_at"),
    approved_by: approvalReference(value.approved_by, "owner approval approved_by"),
    decision_ref: decisionReference(value.decision_ref),
    claims: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_CLAIMS,
  };
}

function assertOwnerApprovalBodyBindings(input: {
  body: WalmartNewSkuCatalogActivationOwnerApprovalSignedBody;
  plan: SealedWalmartNewSkuCatalogActivationPlan;
  now: Date;
}): void {
  const { body, plan, now } = input;
  const issuedAt = Date.parse(body.issued_at);
  const expiresAt = Date.parse(body.expires_at);
  if (new Date(issuedAt).toISOString() !== body.issued_at
    || new Date(expiresAt).toISOString() !== body.expires_at
    || issuedAt > now.getTime() + 5 * 60_000
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > WALMART_NEW_SKU_CATALOG_ACTIVATION_MAX_PLAN_AGE_MS) {
    fail(
      "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID",
      "catalog activation owner approval chronology is invalid",
    );
  }
  if (now.getTime() > expiresAt) {
    fail(
      "CATALOG_ACTIVATION_OWNER_APPROVAL_EXPIRED",
      "catalog activation owner approval has expired",
    );
  }
  const expectedAuthority = approvalAuthorityEnvironment(plan.environment);
  if (body.authority_environment !== expectedAuthority
    || body.environment !== plan.environment
    || body.plan_sha256 !== plan.plan_sha256
    || body.source_file_sha256 !== plan.source.file_sha256
    || body.source_body_sha256 !== plan.source.body_sha256
    || body.source_rows_sha256 !== plan.source.rows_sha256
    || body.report_request_id_sha256 !== plan.source.report_request_id_sha256
    || body.store_index !== plan.store_index
    || body.business_seller_account_fingerprint_sha256
      !== plan.account_scope.business_seller_account_fingerprint_sha256
    || body.capture_credential_scope_fingerprint_sha256
      !== plan.account_scope.capture_credential_scope_fingerprint_sha256
    || body.database_target_fingerprint_sha256
      !== plan.database_target_fingerprint_sha256
    || body.expected_postcondition_sha256 !== plan.expected_postcondition_sha256) {
    fail(
      "CATALOG_ACTIVATION_OWNER_APPROVAL_BINDING_MISMATCH",
      "catalog activation owner approval does not bind the exact sealed plan",
    );
  }
}

export function buildWalmartNewSkuCatalogActivationOwnerApprovalSigningRequest(input: {
  plan: unknown;
  keyId: string;
  approvalId: string;
  issuedAt: Date;
  expiresAt: Date;
  approvedBy: string;
  decisionRef: string;
  now: Date;
  env?: NodeJS.ProcessEnv;
}): WalmartNewSkuCatalogActivationOwnerApprovalSigningRequest {
  const plan = verifyWalmartNewSkuCatalogActivationPlan(input.plan);
  const now = exactNow(input.now);
  const authorityEnvironment = approvalAuthorityEnvironment(plan.environment);
  const key = approvalKey({
    keyId: approvalReference(input.keyId, "owner approval key_id"),
    environment: authorityEnvironment,
    env: input.env,
  });
  const body = ownerApprovalSignedBody({
    approval_id: input.approvalId,
    action: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ACTION,
    authority_environment: authorityEnvironment,
    environment: plan.environment,
    plan_sha256: plan.plan_sha256,
    source_file_sha256: plan.source.file_sha256,
    source_body_sha256: plan.source.body_sha256,
    source_rows_sha256: plan.source.rows_sha256,
    report_request_id_sha256: plan.source.report_request_id_sha256,
    store_index: plan.store_index,
    business_seller_account_fingerprint_sha256:
      plan.account_scope.business_seller_account_fingerprint_sha256,
    capture_credential_scope_fingerprint_sha256:
      plan.account_scope.capture_credential_scope_fingerprint_sha256,
    database_target_fingerprint_sha256: plan.database_target_fingerprint_sha256,
    expected_postcondition_sha256: plan.expected_postcondition_sha256,
    issued_at: exactNow(input.issuedAt, "issuedAt").toISOString(),
    expires_at: exactNow(input.expiresAt, "expiresAt").toISOString(),
    approved_by: input.approvedBy,
    decision_ref: input.decisionRef,
    claims: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_CLAIMS,
  });
  assertOwnerApprovalBodyBindings({ body, plan, now });
  const envelope: WalmartNewSkuCatalogActivationOwnerApprovalEnvelope = {
    schema_version: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_SCHEMA,
    algorithm: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ALGORITHM,
    key_id: key.key_id,
    owner_public_key_spki_sha256: key.public_key_spki_sha256,
    signed_body: body,
  };
  return {
    ...envelope,
    signing_message_base64:
      walmartNewSkuCatalogActivationOwnerApprovalSigningMessage(envelope).toString("base64"),
    signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64",
    signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
    approval_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
  };
}

function approvalEnvelopeFromRequest(input: unknown): {
  envelope: WalmartNewSkuCatalogActivationOwnerApprovalEnvelope;
  signingMessageBase64: string;
} {
  const request = record(input, "catalog activation owner approval signing request");
  assertExactKeys(request, [
    "schema_version",
    "algorithm",
    "key_id",
    "owner_public_key_spki_sha256",
    "signed_body",
    "signing_message_base64",
    "signature_base64",
    "signature_sha256",
    "approval_sha256",
  ], "catalog activation owner approval signing request");
  if (request.schema_version !== WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_SCHEMA
    || request.algorithm
      !== WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ALGORITHM
    || request.signature_base64 !== "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64"
    || request.signature_sha256 !== "TODO_AFTER_EXTERNAL_SIGNATURE"
    || request.approval_sha256 !== "TODO_AFTER_EXTERNAL_SIGNATURE") {
    fail(
      "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID",
      "catalog activation owner approval signing request is invalid",
    );
  }
  const envelope: WalmartNewSkuCatalogActivationOwnerApprovalEnvelope = {
    schema_version: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_SCHEMA,
    algorithm: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ALGORITHM,
    key_id: approvalReference(request.key_id, "owner approval key_id"),
    owner_public_key_spki_sha256: exactSha256(
      request.owner_public_key_spki_sha256,
      "owner approval public key fingerprint",
    ),
    signed_body: ownerApprovalSignedBody(request.signed_body),
  };
  const signingMessageBase64 = approvalReference(
    request.signing_message_base64,
    "owner approval signing_message_base64",
  );
  if (signingMessageBase64
    !== walmartNewSkuCatalogActivationOwnerApprovalSigningMessage(envelope).toString("base64")) {
    fail(
      "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID",
      "catalog activation owner approval signing message is detached from its envelope",
    );
  }
  return { envelope, signingMessageBase64 };
}

export function assembleWalmartNewSkuCatalogActivationOwnerApproval(input: {
  request: unknown;
  plan: unknown;
  detachedSignature: Uint8Array;
  now: Date;
  env?: NodeJS.ProcessEnv;
}): WalmartNewSkuCatalogActivationOwnerApproval {
  const plan = verifyWalmartNewSkuCatalogActivationPlan(input.plan);
  const { envelope } = approvalEnvelopeFromRequest(input.request);
  assertOwnerApprovalBodyBindings({ body: envelope.signed_body, plan, now: exactNow(input.now) });
  const signature = Buffer.from(input.detachedSignature);
  if (signature.byteLength !== 64) {
    fail(
      "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID",
      "catalog activation owner signature must be exactly 64 raw Ed25519 bytes",
    );
  }
  const signatureBase64 = signature.toString("base64");
  const signatureSha256 = createHash("sha256").update(signature).digest("hex");
  const unsigned = {
    ...envelope,
    signature_base64: signatureBase64,
    signature_sha256: signatureSha256,
  };
  const approval: WalmartNewSkuCatalogActivationOwnerApproval = {
    ...unsigned,
    approval_sha256: walmartItemReportSha256(unsigned),
  };
  return assertWalmartNewSkuCatalogActivationOwnerApproval({
    approval,
    plan,
    now: input.now,
    env: input.env,
  });
}

export function assertWalmartNewSkuCatalogActivationOwnerApproval(input: {
  approval: unknown;
  plan: unknown;
  now: Date;
  env?: NodeJS.ProcessEnv;
  artifactSha256?: string;
}): WalmartNewSkuCatalogActivationOwnerApproval {
  const plan = verifyWalmartNewSkuCatalogActivationPlan(input.plan);
  const value = record(input.approval, "catalog activation owner approval");
  assertExactKeys(value, [
    "schema_version",
    "algorithm",
    "key_id",
    "owner_public_key_spki_sha256",
    "signed_body",
    "signature_base64",
    "signature_sha256",
    "approval_sha256",
  ], "catalog activation owner approval");
  if (value.schema_version !== WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_SCHEMA
    || value.algorithm !== WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ALGORITHM) {
    fail("CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID", "owner approval schema is invalid");
  }
  const body = ownerApprovalSignedBody(value.signed_body);
  assertOwnerApprovalBodyBindings({ body, plan, now: exactNow(input.now) });
  const keyId = approvalReference(value.key_id, "owner approval key_id");
  const key = approvalKey({
    keyId,
    environment: body.authority_environment,
    env: input.env,
  });
  const keyFingerprint = exactSha256(
    value.owner_public_key_spki_sha256,
    "owner approval public key fingerprint",
  );
  const signatureBase64 = value.signature_base64;
  if (!canonicalBase64(signatureBase64)) {
    fail("CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID", "owner signature is not canonical base64");
  }
  const signature = Buffer.from(signatureBase64, "base64");
  const signatureSha256 = exactSha256(
    value.signature_sha256,
    "owner approval signature_sha256",
  );
  const envelope: WalmartNewSkuCatalogActivationOwnerApprovalEnvelope = {
    schema_version: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_SCHEMA,
    algorithm: WALMART_NEW_SKU_CATALOG_ACTIVATION_OWNER_APPROVAL_ALGORITHM,
    key_id: keyId,
    owner_public_key_spki_sha256: keyFingerprint,
    signed_body: body,
  };
  const unsigned = {
    ...envelope,
    signature_base64: signatureBase64,
    signature_sha256: signatureSha256,
  };
  const approvalSha256 = exactSha256(value.approval_sha256, "owner approval approval_sha256");
  const publicKey = createPublicKey({
    key: Buffer.from(key.public_key_spki_der_base64, "base64"),
    format: "der",
    type: "spki",
  });
  if (keyFingerprint !== key.public_key_spki_sha256
    || signature.byteLength !== 64
    || signatureSha256 !== createHash("sha256").update(signature).digest("hex")
    || approvalSha256 !== walmartItemReportSha256(unsigned)
    || !verifySignature(
      null,
      walmartNewSkuCatalogActivationOwnerApprovalSigningMessage(envelope),
      publicKey,
      signature,
    )) {
    fail(
      "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID",
      "catalog activation owner signature, seal, or trust-root binding is invalid",
    );
  }
  const approval: WalmartNewSkuCatalogActivationOwnerApproval = {
    ...unsigned,
    approval_sha256: approvalSha256,
  };
  if (input.artifactSha256 !== undefined) {
    const expectedArtifactSha256 = exactSha256(
      input.artifactSha256,
      "ownerApprovalArtifactSha256",
    );
    const actualArtifactSha256 = createHash("sha256")
      .update(canonicalWalmartItemReportJson(approval))
      .digest("hex");
    if (actualArtifactSha256 !== expectedArtifactSha256) {
      fail(
        "CATALOG_ACTIVATION_OWNER_APPROVAL_INVALID",
        "canonical owner approval bytes differ from the independently supplied artifact SHA-256",
      );
    }
  }
  return approval;
}

export function buildWalmartNewSkuCatalogActivationConfirmation(input: {
  plan: unknown;
  ownerApproval: unknown;
  ownerApprovalArtifactSha256: string;
  now: Date;
  env?: NodeJS.ProcessEnv;
}): string {
  const plan = verifyWalmartNewSkuCatalogActivationPlan(input.plan);
  const artifactSha256 = exactSha256(
    input.ownerApprovalArtifactSha256,
    "ownerApprovalArtifactSha256",
  );
  const approval = assertWalmartNewSkuCatalogActivationOwnerApproval({
    approval: input.ownerApproval,
    plan,
    now: input.now,
    env: input.env,
    artifactSha256,
  });
  return [
    CONFIRMATION_PREFIX,
    plan.plan_sha256,
    approval.approval_sha256,
    artifactSha256,
    plan.database_target_fingerprint_sha256,
    String(plan.store_index),
    plan.environment,
  ].join(":");
}

function sealReceipt(
  body: WalmartNewSkuCatalogActivationReceiptBody,
): SealedWalmartNewSkuCatalogActivationReceipt {
  const receiptSha256 = walmartItemReportSha256(body);
  return {
    ...body,
    receipt_id: `walmart-new-sku-catalog-active-${receiptSha256.slice(0, 16)}`,
    receipt_sha256: receiptSha256,
  };
}

export function verifyWalmartNewSkuCatalogActivationReceipt(
  input: unknown,
): SealedWalmartNewSkuCatalogActivationReceipt {
  const value = record(input, "catalog activation receipt");
  assertExactKeys(value, [
    "schema_version",
    "status",
    "environment",
    "plan_sha256",
    "database_target_fingerprint_sha256",
    "store_index",
    "business_seller_account_fingerprint_sha256",
    "capture_credential_scope_fingerprint_sha256",
    "owner_approval_sha256",
    "owner_approval_artifact_sha256",
    "source_file_sha256",
    "source_id",
    "source_body_sha256",
    "report_request_id_sha256",
    "active_synced_at",
    "row_count",
    "postcondition_sha256",
    "claims",
    "receipt_id",
    "receipt_sha256",
  ], "catalog activation receipt");
  if (value.schema_version !== WALMART_NEW_SKU_CATALOG_ACTIVATION_RECEIPT_SCHEMA
    || value.status !== "ACTIVE" || !sameClaims(value.claims)) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "catalog activation receipt policy is invalid");
  }
  const parsed: SealedWalmartNewSkuCatalogActivationReceipt = {
    schema_version: WALMART_NEW_SKU_CATALOG_ACTIVATION_RECEIPT_SCHEMA,
    status: "ACTIVE",
    environment: exactEnvironment(value.environment),
    plan_sha256: exactSha256(value.plan_sha256, "receipt.plan_sha256"),
    database_target_fingerprint_sha256: exactSha256(
      value.database_target_fingerprint_sha256,
      "receipt.database_target_fingerprint_sha256",
    ),
    store_index: exactStoreIndex(value.store_index),
    business_seller_account_fingerprint_sha256: exactSha256(
      value.business_seller_account_fingerprint_sha256,
      "receipt.business_seller_account_fingerprint_sha256",
    ),
    capture_credential_scope_fingerprint_sha256: exactSha256(
      value.capture_credential_scope_fingerprint_sha256,
      "receipt.capture_credential_scope_fingerprint_sha256",
    ),
    owner_approval_sha256: exactSha256(
      value.owner_approval_sha256,
      "receipt.owner_approval_sha256",
    ),
    owner_approval_artifact_sha256: exactSha256(
      value.owner_approval_artifact_sha256,
      "receipt.owner_approval_artifact_sha256",
    ),
    source_file_sha256: exactSha256(
      value.source_file_sha256,
      "receipt.source_file_sha256",
    ),
    source_id: exactString(value.source_id, "receipt.source_id"),
    source_body_sha256: exactSha256(
      value.source_body_sha256,
      "receipt.source_body_sha256",
    ),
    report_request_id_sha256: exactSha256(
      value.report_request_id_sha256,
      "receipt.report_request_id_sha256",
    ),
    active_synced_at: exactIso(value.active_synced_at, "receipt.active_synced_at"),
    row_count: exactInteger(value.row_count, "receipt.row_count", 1),
    postcondition_sha256: exactSha256(
      value.postcondition_sha256,
      "receipt.postcondition_sha256",
    ),
    claims: WALMART_NEW_SKU_CATALOG_ACTIVATION_CLAIMS,
    receipt_id: exactString(value.receipt_id, "receipt.receipt_id"),
    receipt_sha256: exactSha256(value.receipt_sha256, "receipt.receipt_sha256"),
  };
  const body = structuredClone(parsed) as unknown as Record<string, unknown>;
  delete body.receipt_id;
  delete body.receipt_sha256;
  const expectedSha256 = walmartItemReportSha256(body);
  if (parsed.receipt_sha256 !== expectedSha256
    || parsed.receipt_id
      !== `walmart-new-sku-catalog-active-${expectedSha256.slice(0, 16)}`) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "catalog activation receipt seal is invalid");
  }
  return parsed;
}

function deterministicMirrorId(storeIndex: number, sku: string): string {
  return `wmcat-${walmartItemReportSha256({ store_index: storeIndex, sku }).slice(0, 32)}`;
}

async function insertExpectedMirrorRows(input: {
  transaction: Transaction;
  storeIndex: number;
  rows: ExpectedMirrorRow[];
}): Promise<void> {
  for (let start = 0; start < input.rows.length; start += INSERT_ROWS_PER_STATEMENT) {
    const chunk = input.rows.slice(start, start + INSERT_ROWS_PER_STATEMENT);
    const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
    const args: Array<string | number | null> = [];
    for (const row of chunk) {
      args.push(
        deterministicMirrorId(input.storeIndex, row.sku),
        input.storeIndex,
        row.sku,
        row.item_id,
        row.title,
        row.lifecycle_status,
        row.published_status,
        row.synced_at,
        row.main_image_url,
        row.main_image_fetched_at,
      );
    }
    await input.transaction.execute({
      sql: `INSERT INTO WalmartCatalogItem
              (id,storeIndex,sku,itemId,title,lifecycleStatus,publishedStatus,
               syncedAt,mainImageUrl,mainImageFetchedAt)
            VALUES ${placeholders}`,
      args,
    });
  }
}

async function activateReportDiagnostic(input: {
  transaction: Transaction;
  source: SealedWalmartItemReportCatalogSource;
  storeIndex: number;
}): Promise<void> {
  const existing = await input.transaction.execute({
    sql: `SELECT id,storeIndex,reportType FROM WalmartReport WHERE requestId=? LIMIT 1`,
    args: [input.source.report.report_request_id],
  });
  const row = existing.rows[0];
  if (row) {
    if (Number(row.storeIndex) !== input.storeIndex
      || row.reportType !== ITEM_CATALOG_REPORT_TYPE) {
      fail(
        "CATALOG_ACTIVATION_BLOCKED",
        "source report requestId belongs to another WalmartReport scope",
      );
    }
    await input.transaction.execute({
      sql: `UPDATE WalmartReport
            SET status='DOWNLOADED',requestedAt=?,statusCheckedAt=?,readyAt=?,
                downloadedAt=?,rowCount=?,error=NULL,updatedAt=?
            WHERE requestId=?`,
      args: [
        input.source.report.requested_at,
        input.source.report.cutoff_at,
        input.source.report.cutoff_at,
        input.source.report.downloaded_at,
        input.source.rows.length,
        input.source.report.downloaded_at,
        input.source.report.report_request_id,
      ],
    });
    return;
  }
  const id = `wmreport-${input.source.report.report_request_id_sha256.slice(0, 24)}`;
  await input.transaction.execute({
    sql: `INSERT INTO WalmartReport
            (id,storeIndex,reportType,requestId,status,requestedAt,statusCheckedAt,
             readyAt,downloadedAt,rowCount,error,updatedAt)
          VALUES (?,?,'ITEM_CATALOG',?,'DOWNLOADED',?,?,?,?,?,NULL,?)`,
    args: [
      id,
      input.storeIndex,
      input.source.report.report_request_id,
      input.source.report.requested_at,
      input.source.report.cutoff_at,
      input.source.report.cutoff_at,
      input.source.report.downloaded_at,
      input.source.rows.length,
      input.source.report.downloaded_at,
    ],
  });
}

function receiptFor(
  plan: SealedWalmartNewSkuCatalogActivationPlan,
  ownerApproval: WalmartNewSkuCatalogActivationOwnerApproval,
  ownerApprovalArtifactSha256: string,
): SealedWalmartNewSkuCatalogActivationReceipt {
  return verifyWalmartNewSkuCatalogActivationReceipt(sealReceipt({
    schema_version: WALMART_NEW_SKU_CATALOG_ACTIVATION_RECEIPT_SCHEMA,
    status: "ACTIVE",
    environment: plan.environment,
    plan_sha256: plan.plan_sha256,
    database_target_fingerprint_sha256:
      plan.database_target_fingerprint_sha256,
    store_index: plan.store_index,
    business_seller_account_fingerprint_sha256:
      plan.account_scope.business_seller_account_fingerprint_sha256,
    capture_credential_scope_fingerprint_sha256:
      plan.account_scope.capture_credential_scope_fingerprint_sha256,
    owner_approval_sha256: ownerApproval.approval_sha256,
    owner_approval_artifact_sha256: ownerApprovalArtifactSha256,
    source_file_sha256: plan.source.file_sha256,
    source_id: plan.source.source_id,
    source_body_sha256: plan.source.body_sha256,
    report_request_id_sha256: plan.source.report_request_id_sha256,
    active_synced_at: plan.source.downloaded_at,
    row_count: plan.source.row_count,
    postcondition_sha256: plan.expected_postcondition_sha256,
    claims: WALMART_NEW_SKU_CATALOG_ACTIVATION_CLAIMS,
  }));
}

export async function applyWalmartNewSkuCatalogActivation(
  input: ApplyWalmartNewSkuCatalogActivationInput,
): Promise<ApplyWalmartNewSkuCatalogActivationResult> {
  const plan = verifyWalmartNewSkuCatalogActivationPlan(input.plan);
  const now = exactNow(input.now);
  const environment = exactEnvironment(input.environment);
  const targetFingerprint = exactSha256(
    input.databaseTargetFingerprintSha256,
    "databaseTargetFingerprintSha256",
  );
  const businessSellerFingerprint = exactSha256(
    input.businessSellerAccountFingerprintSha256,
    "businessSellerAccountFingerprintSha256",
  );
  const captureCredentialFingerprint = exactSha256(
    input.activeCaptureCredentialScopeFingerprintSha256,
    "activeCaptureCredentialScopeFingerprintSha256",
  );
  if (environment !== plan.environment
    || targetFingerprint !== plan.database_target_fingerprint_sha256
    || businessSellerFingerprint
      !== plan.account_scope.business_seller_account_fingerprint_sha256
    || captureCredentialFingerprint
      !== plan.account_scope.capture_credential_scope_fingerprint_sha256) {
    fail(
      "CATALOG_ACTIVATION_PLAN_INVALID",
      "apply environment, account scope, or database target differs from the sealed plan",
    );
  }
  if (now.getTime() < Date.parse(plan.planned_at)
    || now.getTime() > Date.parse(plan.expires_at)) {
    fail("CATALOG_ACTIVATION_PLAN_EXPIRED", "catalog activation plan is not current");
  }
  if (!plan.eligible_for_apply || plan.blockers.length > 0) {
    fail(
      "CATALOG_ACTIVATION_BLOCKED",
      plan.blockers.join("; ") || "sealed plan is not eligible",
    );
  }
  const ownerApprovalArtifactSha256 = exactSha256(
    input.ownerApprovalArtifactSha256,
    "ownerApprovalArtifactSha256",
  );
  const ownerApproval = assertWalmartNewSkuCatalogActivationOwnerApproval({
    approval: input.ownerApproval,
    plan,
    now,
    env: input.ownerTrustEnvironment,
    artifactSha256: ownerApprovalArtifactSha256,
  });
  if (input.confirmation !== buildWalmartNewSkuCatalogActivationConfirmation({
    plan,
    ownerApproval,
    ownerApprovalArtifactSha256,
    now,
    env: input.ownerTrustEnvironment,
  })) {
    fail(
      "CATALOG_ACTIVATION_CONFIRMATION_MISMATCH",
      "confirmation does not bind the exact plan/source/target/store/environment",
    );
  }
  const outerPinned = await readPinnedCatalogSource({
    path: plan.source.absolute_path,
    expectedSha256: plan.source.file_sha256,
  });
  assertSourceScopeAndFreshness({
    source: outerPinned.source,
    storeIndex: plan.store_index,
    activeCaptureCredentialScopeFingerprintSha256: captureCredentialFingerprint,
    now,
  });
  const reboundSource = sourceBinding({
    source: outerPinned.source,
    path: plan.source.absolute_path,
    fileSha256: outerPinned.fileSha256,
    byteLength: outerPinned.bytes.byteLength,
  });
  if (canonicalWalmartItemReportJson(reboundSource)
    !== canonicalWalmartItemReportJson(plan.source)) {
    fail("CATALOG_ACTIVATION_PLAN_INVALID", "catalog source differs from sealed plan");
  }

  const transaction = await input.db.transaction("write");
  let committed = false;
  try {
    const innerPinned = await readPinnedCatalogSource({
      path: plan.source.absolute_path,
      expectedSha256: plan.source.file_sha256,
    });
    if (innerPinned.fileSha256 !== outerPinned.fileSha256
      || !innerPinned.bytes.equals(outerPinned.bytes)) {
      fail("CATALOG_SOURCE_FILE_CHANGED", "catalog source changed before transaction apply");
    }
    assertSourceScopeAndFreshness({
      source: innerPinned.source,
      storeIndex: plan.store_index,
      activeCaptureCredentialScopeFingerprintSha256: captureCredentialFingerprint,
      now,
    });
    const rechecked = await input.recheckOwnerApproval();
    const recheckedBusinessFingerprint = exactSha256(
      rechecked.businessSellerAccountFingerprintSha256,
      "rechecked businessSellerAccountFingerprintSha256",
    );
    const recheckedCaptureFingerprint = exactSha256(
      rechecked.activeCaptureCredentialScopeFingerprintSha256,
      "rechecked activeCaptureCredentialScopeFingerprintSha256",
    );
    const recheckedArtifactSha256 = exactSha256(
      rechecked.artifactSha256,
      "rechecked owner approval artifact SHA-256",
    );
    const recheckedApproval = assertWalmartNewSkuCatalogActivationOwnerApproval({
      approval: rechecked.approval,
      plan,
      now,
      env: input.ownerTrustEnvironment,
      artifactSha256: recheckedArtifactSha256,
    });
    if (recheckedBusinessFingerprint !== businessSellerFingerprint
      || recheckedCaptureFingerprint !== captureCredentialFingerprint
      || recheckedArtifactSha256 !== ownerApprovalArtifactSha256
      || canonicalWalmartItemReportJson(recheckedApproval)
        !== canonicalWalmartItemReportJson(ownerApproval)) {
      fail(
        "CATALOG_ACTIVATION_OWNER_APPROVAL_CHANGED",
        "owner approval or active Walmart account scope changed before transaction apply",
      );
    }
    const current = await readDatabaseState({
      executor: transaction,
      storeIndex: plan.store_index,
      sourceRequestId: innerPinned.source.report.report_request_id,
    });
    const blockers = activationBlockers({ source: innerPinned.source, state: current });
    if (blockers.length > 0) {
      fail("CATALOG_ACTIVATION_BLOCKED", blockers.join("; "));
    }
    const expectedProjection = expectedPostconditionProjection({
      source: innerPinned.source,
      current,
    });
    const expectedPostSha256 = postconditionSha256(expectedProjection);
    if (expectedPostSha256 !== plan.expected_postcondition_sha256) {
      fail(
        "CATALOG_ACTIVATION_PRECONDITION_DRIFT",
        "preserved image cache or expected postcondition changed after plan",
      );
    }
    const currentPostSha256 = postconditionSha256(
      currentPostconditionProjection(current),
    );
    if (currentPostSha256 === plan.expected_postcondition_sha256) {
      await transaction.rollback();
      return {
        receipt: receiptFor(plan, ownerApproval, ownerApprovalArtifactSha256),
        database_changed: false,
        idempotent_replay: true,
      };
    }
    if (preconditionSha256(current) !== plan.current_state.precondition_sha256) {
      fail(
        "CATALOG_ACTIVATION_PRECONDITION_DRIFT",
        "catalog mirror or report history changed after sealed plan creation",
      );
    }
    await transaction.execute({
      sql: "DELETE FROM WalmartCatalogItem WHERE storeIndex=?",
      args: [plan.store_index],
    });
    if (input.testHooks?.afterStoreDelete) {
      await input.testHooks.afterStoreDelete(transaction);
    }
    await insertExpectedMirrorRows({
      transaction,
      storeIndex: plan.store_index,
      rows: expectedProjection.mirror_rows,
    });
    await activateReportDiagnostic({
      transaction,
      source: innerPinned.source,
      storeIndex: plan.store_index,
    });
    if (input.testHooks?.beforeCommit) {
      await input.testHooks.beforeCommit(transaction);
    }
    const after = await readDatabaseState({
      executor: transaction,
      storeIndex: plan.store_index,
      sourceRequestId: innerPinned.source.report.report_request_id,
    });
    if (postconditionSha256(currentPostconditionProjection(after))
      !== plan.expected_postcondition_sha256) {
      fail(
        "CATALOG_ACTIVATION_POSTCONDITION_FAILED",
        "atomic catalog replace did not produce the sealed expected postcondition",
      );
    }
    await transaction.commit();
    committed = true;
  } catch (error) {
    if (!transaction.closed) await transaction.rollback();
    throw error;
  } finally {
    if (!transaction.closed) transaction.close();
  }
  if (!committed) {
    fail("CATALOG_ACTIVATION_POSTCONDITION_FAILED", "catalog activation did not commit");
  }
  return {
    receipt: receiptFor(plan, ownerApproval, ownerApprovalArtifactSha256),
    database_changed: true,
    idempotent_replay: false,
  };
}
