import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type { Client } from "@libsql/client";

import {
  WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
  canonicalWalmartItemReportJson,
  verifyWalmartItemReportCatalogSource,
  walmartItemReportSha256,
  walmartItemReportUtf8Sha256,
  walmartListingKey,
  type SealedWalmartItemReportCatalogSource,
  type WalmartItemReportCatalogRow,
} from "@/lib/walmart/item-report-published-source";

export const WALMART_SELLER_CATALOG_AUTHORITY_BINDING_SCHEMA =
  "walmart-seller-catalog-authority-binding/v1" as const;
export const WALMART_EXACT_IDENTIFIER_DUPLICATE_GUARD_BINDING_SCHEMA =
  "walmart-exact-identifier-duplicate-guard-binding/v1" as const;
export const WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS =
  24 * 60 * 60 * 1_000;
export const WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS = 5 * 60 * 1_000;
export const WALMART_SELLER_CATALOG_AUTHORITY_FILE_MAX_BYTES =
  128 * 1024 * 1024;

const CHANNEL = "WALMART_US" as const;
const MIRROR_PROJECTION_SCHEMA =
  "walmart-catalog-item-exact-mirror-projection/v1" as const;

export type WalmartSellerCatalogAuthorityErrorCode =
  | "INVALID_AUTHORITY_INPUT"
  | "UNSAFE_CATALOG_SOURCE_PATH"
  | "CATALOG_SOURCE_FILE_CHANGED"
  | "CATALOG_SOURCE_FILE_SHA256_MISMATCH"
  | "CATALOG_SOURCE_JSON_INVALID"
  | "CATALOG_SOURCE_SCOPE_MISMATCH"
  | "CATALOG_SOURCE_STALE_OR_FUTURE"
  | "CATALOG_MIRROR_EMPTY_OR_INVALID"
  | "CATALOG_MIRROR_NOT_ATOMIC"
  | "CATALOG_MIRROR_STALE_OR_FUTURE"
  | "CATALOG_MIRROR_SOURCE_SKEW"
  | "CATALOG_MIRROR_RECONCILIATION_MISMATCH"
  | "CATALOG_REPORT_DIAGNOSTIC_MISSING"
  | "CATALOG_REPORT_DIAGNOSTIC_MISMATCH"
  | "CATALOG_AUTHORITY_BINDING_INVALID"
  | "CATALOG_AUTHORITY_BINDING_DRIFT";

export class WalmartSellerCatalogAuthorityError extends Error {
  readonly code: WalmartSellerCatalogAuthorityErrorCode;

  constructor(code: WalmartSellerCatalogAuthorityErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "WalmartSellerCatalogAuthorityError";
    this.code = code;
  }
}

interface ExactMirrorProjectionRow {
  listing_key: string;
  sku: string;
  item_id: string | null;
  title: string | null;
  lifecycle_status: string | null;
  published_status: string | null;
}

export interface WalmartSellerCatalogAuthorityBindingBody {
  schema_version: typeof WALMART_SELLER_CATALOG_AUTHORITY_BINDING_SCHEMA;
  account_scope: {
    channel: typeof CHANNEL;
    store_index: number;
    business_seller_account_fingerprint_sha256: string;
    capture_credential_scope_fingerprint_sha256: string;
  };
  source_artifact: {
    absolute_path: string;
    file_sha256: string;
    file_byte_length: number;
    schema_version: typeof WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA;
    source_id: string;
    body_sha256: string;
    artifact_account_fingerprint_sha256: string;
    published_source_id: string;
    published_source_body_sha256: string;
    report_request_id_sha256: string;
    requested_at: string;
    cutoff_at: string;
    downloaded_at: string;
    raw_transport_sha256: string;
    decoded_report_sha256: string;
    row_count: number;
    rows_sha256: string;
    published_row_count: number;
    published_rows_sha256: string;
    status_counts_sha256: string;
  };
  mirror_reconciliation: {
    projection_schema_version: typeof MIRROR_PROJECTION_SCHEMA;
    synced_at: string;
    row_count: number;
    source_projection_sha256: string;
    database_projection_sha256: string;
    exact_match: true;
  };
  walmart_report_diagnostic: {
    report_type: "ITEM_CATALOG";
    status: "DOWNLOADED";
    request_id_sha256: string;
    row_count: number;
    downloaded_at: string;
    source_download_skew_ms: number;
    mirror_sync_skew_ms: number;
    exact_match: true;
  };
  freshness_policy: {
    source_cutoff_and_download_max_age_ms: typeof WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS;
    mirror_and_report_max_age_ms: typeof WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS;
    mirror_source_skew_max_ms: typeof WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS;
    future_tolerance_ms: 0;
  };
}

export interface SealedWalmartAllStatusSellerCatalogAuthorityBinding
  extends WalmartSellerCatalogAuthorityBindingBody {
  binding_id: string;
  body_sha256: string;
}

export interface SealedWalmartExactIdentifierDuplicateGuardBinding {
  schema_version: typeof WALMART_EXACT_IDENTIFIER_DUPLICATE_GUARD_BINDING_SCHEMA;
  account_scope: {
    channel: typeof CHANNEL;
    store_index: number;
    business_seller_account_fingerprint_sha256: string;
  };
  policy: {
    mode: "EXACT_SKU_AND_UPC_PREFLIGHT_ONLY";
    product_source: "PRODUCT_TRUTH_DONOR_CATALOG";
    full_seller_catalog_required: false;
    seller_recipe_catalog_scan_required: false;
    exact_seller_sku_absence_required_before_certification: true;
    exact_upc_catalog_search_required_before_certification: true;
    checks_must_bind_staged_sku_and_upc: true;
  };
  owner_decision_ref: string;
  binding_id: string;
  body_sha256: string;
}

export type SealedWalmartSellerCatalogAuthorityBinding =
  | SealedWalmartAllStatusSellerCatalogAuthorityBinding
  | SealedWalmartExactIdentifierDuplicateGuardBinding;

export interface BuildWalmartSellerCatalogAuthorityBindingInput {
  db: Client;
  sourcePath: string;
  expectedSourceFileSha256: string;
  storeIndex: number;
  businessSellerAccountFingerprintSha256: string;
  activeCaptureCredentialScopeFingerprintSha256: string;
  now: Date;
}

function fail(
  code: WalmartSellerCatalogAuthorityErrorCode,
  message: string,
): never {
  throw new WalmartSellerCatalogAuthorityError(code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalWalmartItemReportJson(keys) !== canonicalWalmartItemReportJson(wanted)) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", `${label} fields are not exact`);
  }
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("INVALID_AUTHORITY_INPUT", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function bindingSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", `${label} must be a non-empty exact string`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < minimum) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", `${label} must be a safe integer >= ${minimum}`);
  }
  return Number(parsed);
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", `${label} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", `${label} must be an ISO timestamp`);
  }
  return value;
}

function dbIso(value: unknown, label: string): string {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  if (!Number.isFinite(parsed)) {
    fail("CATALOG_MIRROR_EMPTY_OR_INVALID", `${label} is not a timestamp`);
  }
  return new Date(parsed).toISOString();
}

function exactDbNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    fail("CATALOG_MIRROR_EMPTY_OR_INVALID", `${label} must be string or null`);
  }
  return value;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStat(
  left: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number },
  right: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function readPinnedCatalogSource(input: {
  path: string;
  expectedSha256: string;
}): Promise<{
  bytes: Buffer;
  fileSha256: string;
  source: SealedWalmartItemReportCatalogSource;
}> {
  const expectedSha256 = sha256(input.expectedSha256, "expectedSourceFileSha256");
  if (!isAbsolute(input.path) || resolve(input.path) !== input.path || input.path.includes("\0")) {
    fail("UNSAFE_CATALOG_SOURCE_PATH", "catalog source path must be absolute and normalized");
  }
  const beforePath = await lstat(input.path).catch(() => null);
  if (!beforePath || !beforePath.isFile() || beforePath.isSymbolicLink()) {
    fail("UNSAFE_CATALOG_SOURCE_PATH", "catalog source must be a regular non-symlink file");
  }
  if (beforePath.size < 2 || beforePath.size > WALMART_SELLER_CATALOG_AUTHORITY_FILE_MAX_BYTES) {
    fail("UNSAFE_CATALOG_SOURCE_PATH", "catalog source file size is outside the safety bounds");
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(input.path, flags).catch(() => null);
  if (!handle) {
    fail("UNSAFE_CATALOG_SOURCE_PATH", "catalog source cannot be opened without following symlinks");
  }
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameStat(beforePath, opened)) {
      fail("CATALOG_SOURCE_FILE_CHANGED", "catalog source changed before read");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size || !sameStat(opened, after)) {
      fail("CATALOG_SOURCE_FILE_CHANGED", "catalog source changed during read");
    }
  } finally {
    await handle.close();
  }
  const afterPath = await lstat(input.path).catch(() => null);
  if (!afterPath || !afterPath.isFile() || afterPath.isSymbolicLink()
    || !sameStat(beforePath, afterPath)) {
    fail("CATALOG_SOURCE_FILE_CHANGED", "catalog source path changed during read");
  }

  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  if (fileSha256 !== expectedSha256) {
    fail("CATALOG_SOURCE_FILE_SHA256_MISMATCH", "catalog source bytes do not match the independent digest");
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("CATALOG_SOURCE_JSON_INVALID", "catalog source is not strict UTF-8 JSON");
  }
  try {
    return {
      bytes,
      fileSha256,
      source: verifyWalmartItemReportCatalogSource(parsed),
    };
  } catch (error) {
    fail(
      "CATALOG_SOURCE_JSON_INVALID",
      `catalog source seal is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertFreshInstant(input: {
  value: string;
  nowMs: number;
  label: string;
  code: WalmartSellerCatalogAuthorityErrorCode;
}): number {
  const parsed = Date.parse(input.value);
  const age = input.nowMs - parsed;
  if (!Number.isFinite(parsed) || age < 0 || age > WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS) {
    fail(input.code, `${input.label} must be nonfuture and no older than 24 hours`);
  }
  return parsed;
}

function sourceMirrorProjection(row: WalmartItemReportCatalogRow): ExactMirrorProjectionRow {
  return {
    listing_key: row.listing_key,
    sku: row.sku,
    item_id: row.reported_legacy_item_identifier_opaque
      ?? row.reported_legacy_wpid_opaque,
    title: row.reported_product_name,
    lifecycle_status: row.reported_lifecycle_status,
    published_status: row.published_status,
  };
}

async function readMirrorProjection(input: {
  db: Client;
  storeIndex: number;
}): Promise<{ rows: ExactMirrorProjectionRow[]; syncedAt: string }> {
  const result = await input.db.execute({
    sql: `SELECT sku,itemId,title,lifecycleStatus,publishedStatus,syncedAt
          FROM WalmartCatalogItem WHERE storeIndex=? ORDER BY sku`,
    args: [input.storeIndex],
  });
  if (result.rows.length === 0) {
    fail("CATALOG_MIRROR_EMPTY_OR_INVALID", "WalmartCatalogItem mirror is empty");
  }
  const syncInstants = new Set<string>();
  const rows = result.rows.map((row, index): ExactMirrorProjectionRow => {
    const sku = exactDbNullableString(row.sku, `WalmartCatalogItem[${index}].sku`);
    if (!sku) {
      fail("CATALOG_MIRROR_EMPTY_OR_INVALID", `WalmartCatalogItem[${index}].sku is empty`);
    }
    syncInstants.add(dbIso(row.syncedAt, `WalmartCatalogItem[${index}].syncedAt`));
    return {
      listing_key: walmartListingKey(input.storeIndex, sku),
      sku,
      item_id: exactDbNullableString(row.itemId, `WalmartCatalogItem[${index}].itemId`),
      title: exactDbNullableString(row.title, `WalmartCatalogItem[${index}].title`),
      lifecycle_status: exactDbNullableString(
        row.lifecycleStatus,
        `WalmartCatalogItem[${index}].lifecycleStatus`,
      ),
      published_status: exactDbNullableString(
        row.publishedStatus,
        `WalmartCatalogItem[${index}].publishedStatus`,
      ),
    };
  }).sort((left, right) => codeUnitCompare(left.listing_key, right.listing_key));
  if (new Set(rows.map((row) => row.listing_key)).size !== rows.length) {
    fail("CATALOG_MIRROR_RECONCILIATION_MISMATCH", "WalmartCatalogItem has duplicate listing keys");
  }
  if (syncInstants.size !== 1) {
    fail("CATALOG_MIRROR_NOT_ATOMIC", "WalmartCatalogItem rows do not share one syncedAt");
  }
  return { rows, syncedAt: [...syncInstants][0]! };
}

async function readReportDiagnostic(input: {
  db: Client;
  storeIndex: number;
}): Promise<{
  requestIdSha256: string;
  rowCount: number;
  downloadedAt: string;
}> {
  const result = await input.db.execute({
    sql: `SELECT requestId,rowCount,downloadedAt,status
          FROM WalmartReport
          WHERE storeIndex=? AND reportType='ITEM_CATALOG' AND status='DOWNLOADED'
          ORDER BY julianday(downloadedAt) DESC,downloadedAt DESC,requestedAt DESC
          LIMIT 1`,
    args: [input.storeIndex],
  });
  const row = result.rows[0];
  if (!row) {
    fail("CATALOG_REPORT_DIAGNOSTIC_MISSING", "latest downloaded ITEM_CATALOG report is missing");
  }
  if (row.status !== "DOWNLOADED" || typeof row.requestId !== "string" || !row.requestId) {
    fail("CATALOG_REPORT_DIAGNOSTIC_MISSING", "latest ITEM_CATALOG report is invalid");
  }
  const rawCount = typeof row.rowCount === "bigint" ? Number(row.rowCount) : row.rowCount;
  if (!Number.isSafeInteger(rawCount) || Number(rawCount) < 1) {
    fail("CATALOG_REPORT_DIAGNOSTIC_MISSING", "latest ITEM_CATALOG report rowCount is invalid");
  }
  return {
    requestIdSha256: walmartItemReportUtf8Sha256(row.requestId),
    rowCount: Number(rawCount),
    downloadedAt: dbIso(row.downloadedAt, "WalmartReport.downloadedAt"),
  };
}

function sealBinding(
  body: WalmartSellerCatalogAuthorityBindingBody,
): SealedWalmartAllStatusSellerCatalogAuthorityBinding {
  const bodySha256 = walmartItemReportSha256(body);
  return {
    ...body,
    binding_id: `walmart-seller-catalog-authority-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256,
  };
}

/**
 * Build a read-only authority binding from independently pinned ITEM v6 bytes.
 * WalmartReport is deliberately only a required diagnostic cross-check: it
 * cannot substitute for the sealed source artifact or its exact mirror match.
 */
export async function buildWalmartSellerCatalogAuthorityBinding(
  input: BuildWalmartSellerCatalogAuthorityBindingInput,
): Promise<SealedWalmartAllStatusSellerCatalogAuthorityBinding> {
  if (!Number.isInteger(input.storeIndex) || input.storeIndex < 1
    || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    fail("INVALID_AUTHORITY_INPUT", "storeIndex and now are invalid");
  }
  const businessFingerprint = sha256(
    input.businessSellerAccountFingerprintSha256,
    "businessSellerAccountFingerprintSha256",
  );
  const captureFingerprint = sha256(
    input.activeCaptureCredentialScopeFingerprintSha256,
    "activeCaptureCredentialScopeFingerprintSha256",
  );
  const pinned = await readPinnedCatalogSource({
    path: input.sourcePath,
    expectedSha256: input.expectedSourceFileSha256,
  });
  const source = pinned.source;
  if (source.account_scope.channel !== CHANNEL
    || source.account_scope.store_index !== input.storeIndex
    || source.account_scope.seller_account_fingerprint_sha256 !== captureFingerprint) {
    fail(
      "CATALOG_SOURCE_SCOPE_MISMATCH",
      "catalog source account/store does not match the active capture credential scope",
    );
  }

  const nowMs = input.now.getTime();
  const cutoffMs = assertFreshInstant({
    value: source.report.cutoff_at,
    nowMs,
    label: "catalog source cutoff_at",
    code: "CATALOG_SOURCE_STALE_OR_FUTURE",
  });
  const sourceDownloadedMs = assertFreshInstant({
    value: source.report.downloaded_at,
    nowMs,
    label: "catalog source downloaded_at",
    code: "CATALOG_SOURCE_STALE_OR_FUTURE",
  });
  if (cutoffMs > sourceDownloadedMs) {
    fail("CATALOG_SOURCE_STALE_OR_FUTURE", "catalog source cutoff is after download");
  }

  const sourceProjection = source.rows.map(sourceMirrorProjection)
    .sort((left, right) => codeUnitCompare(left.listing_key, right.listing_key));
  const mirror = await readMirrorProjection({ db: input.db, storeIndex: input.storeIndex });
  const mirrorSyncedMs = assertFreshInstant({
    value: mirror.syncedAt,
    nowMs,
    label: "WalmartCatalogItem syncedAt",
    code: "CATALOG_MIRROR_STALE_OR_FUTURE",
  });
  const mirrorSourceSkewMs = Math.abs(mirrorSyncedMs - sourceDownloadedMs);
  if (mirrorSourceSkewMs > WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS) {
    fail("CATALOG_MIRROR_SOURCE_SKEW", "mirror syncedAt is not bound to source download time");
  }
  const sourceProjectionSha256 = walmartItemReportSha256(sourceProjection);
  const databaseProjectionSha256 = walmartItemReportSha256(mirror.rows);
  if (sourceProjection.length !== mirror.rows.length
    || sourceProjectionSha256 !== databaseProjectionSha256
    || canonicalWalmartItemReportJson(sourceProjection)
      !== canonicalWalmartItemReportJson(mirror.rows)) {
    fail(
      "CATALOG_MIRROR_RECONCILIATION_MISMATCH",
      "WalmartCatalogItem does not exactly match every all-status source row",
    );
  }

  const report = await readReportDiagnostic({ db: input.db, storeIndex: input.storeIndex });
  const reportDownloadedMs = assertFreshInstant({
    value: report.downloadedAt,
    nowMs,
    label: "WalmartReport downloadedAt",
    code: "CATALOG_REPORT_DIAGNOSTIC_MISMATCH",
  });
  const sourceDownloadSkewMs = Math.abs(reportDownloadedMs - sourceDownloadedMs);
  const reportMirrorSkewMs = Math.abs(reportDownloadedMs - mirrorSyncedMs);
  if (report.requestIdSha256 !== source.report.report_request_id_sha256
    || report.rowCount !== source.rows.length
    || sourceDownloadSkewMs > WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS
    || reportMirrorSkewMs > WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS) {
    fail(
      "CATALOG_REPORT_DIAGNOSTIC_MISMATCH",
      "latest WalmartReport does not diagnostically match the pinned source and mirror",
    );
  }

  // The two tables are mutable compatibility mirrors. Read them a second time
  // after reconciliation so a concurrent replace/report update cannot yield a
  // binding assembled from two different database instants.
  const mirrorAfter = await readMirrorProjection({
    db: input.db,
    storeIndex: input.storeIndex,
  });
  const reportAfter = await readReportDiagnostic({
    db: input.db,
    storeIndex: input.storeIndex,
  });
  if (canonicalWalmartItemReportJson(mirrorAfter)
      !== canonicalWalmartItemReportJson(mirror)
    || canonicalWalmartItemReportJson(reportAfter)
      !== canonicalWalmartItemReportJson(report)) {
    fail(
      "CATALOG_AUTHORITY_BINDING_DRIFT",
      "catalog mirror or diagnostic report changed during authority read",
    );
  }

  const body: WalmartSellerCatalogAuthorityBindingBody = {
    schema_version: WALMART_SELLER_CATALOG_AUTHORITY_BINDING_SCHEMA,
    account_scope: {
      channel: CHANNEL,
      store_index: input.storeIndex,
      business_seller_account_fingerprint_sha256: businessFingerprint,
      capture_credential_scope_fingerprint_sha256: captureFingerprint,
    },
    source_artifact: {
      absolute_path: input.sourcePath,
      file_sha256: pinned.fileSha256,
      file_byte_length: pinned.bytes.byteLength,
      schema_version: WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
      source_id: source.source_id,
      body_sha256: source.body_sha256,
      artifact_account_fingerprint_sha256:
        source.account_scope.seller_account_fingerprint_sha256,
      published_source_id: source.published_source.source_id,
      published_source_body_sha256: source.published_source.body_sha256,
      report_request_id_sha256: source.report.report_request_id_sha256,
      requested_at: source.report.requested_at,
      cutoff_at: source.report.cutoff_at,
      downloaded_at: source.report.downloaded_at,
      raw_transport_sha256: source.report.raw_transport_sha256,
      decoded_report_sha256: source.report.decoded_report_sha256,
      row_count: source.rows.length,
      rows_sha256: source.reconciliation.rows_sha256,
      published_row_count: source.reconciliation.published_row_count,
      published_rows_sha256: source.reconciliation.published_rows_sha256,
      status_counts_sha256: walmartItemReportSha256({
        published_status_counts: source.reconciliation.published_status_counts,
        lifecycle_status_counts: source.reconciliation.lifecycle_status_counts,
        lifecycle_status_not_reported_count:
          source.reconciliation.lifecycle_status_not_reported_count,
      }),
    },
    mirror_reconciliation: {
      projection_schema_version: MIRROR_PROJECTION_SCHEMA,
      synced_at: mirror.syncedAt,
      row_count: mirror.rows.length,
      source_projection_sha256: sourceProjectionSha256,
      database_projection_sha256: databaseProjectionSha256,
      exact_match: true,
    },
    walmart_report_diagnostic: {
      report_type: "ITEM_CATALOG",
      status: "DOWNLOADED",
      request_id_sha256: report.requestIdSha256,
      row_count: report.rowCount,
      downloaded_at: report.downloadedAt,
      source_download_skew_ms: sourceDownloadSkewMs,
      mirror_sync_skew_ms: reportMirrorSkewMs,
      exact_match: true,
    },
    freshness_policy: {
      source_cutoff_and_download_max_age_ms:
        WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS,
      mirror_and_report_max_age_ms: WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS,
      mirror_source_skew_max_ms: WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS,
      future_tolerance_ms: 0,
    },
  };
  const sealed = verifyWalmartSellerCatalogAuthorityBinding(sealBinding(body));
  if (isWalmartExactIdentifierDuplicateGuardBinding(sealed)) {
    fail(
      "CATALOG_AUTHORITY_BINDING_INVALID",
      "all-status catalog builder produced an exact-identifier guard",
    );
  }
  return sealed;
}

export function buildWalmartExactIdentifierDuplicateGuardBinding(input: {
  storeIndex: number;
  businessSellerAccountFingerprintSha256: string;
  ownerDecisionRef: string;
}): SealedWalmartExactIdentifierDuplicateGuardBinding {
  if (!Number.isInteger(input.storeIndex) || input.storeIndex < 1) {
    fail("INVALID_AUTHORITY_INPUT", "storeIndex is invalid");
  }
  const body = {
    schema_version: WALMART_EXACT_IDENTIFIER_DUPLICATE_GUARD_BINDING_SCHEMA,
    account_scope: {
      channel: CHANNEL,
      store_index: input.storeIndex,
      business_seller_account_fingerprint_sha256: sha256(
        input.businessSellerAccountFingerprintSha256,
        "businessSellerAccountFingerprintSha256",
      ),
    },
    policy: {
      mode: "EXACT_SKU_AND_UPC_PREFLIGHT_ONLY",
      product_source: "PRODUCT_TRUTH_DONOR_CATALOG",
      full_seller_catalog_required: false,
      seller_recipe_catalog_scan_required: false,
      exact_seller_sku_absence_required_before_certification: true,
      exact_upc_catalog_search_required_before_certification: true,
      checks_must_bind_staged_sku_and_upc: true,
    },
    owner_decision_ref: exactString(input.ownerDecisionRef, "ownerDecisionRef"),
  } as const;
  const bodySha256 = walmartItemReportSha256(body);
  return verifyWalmartExactIdentifierDuplicateGuardBinding({
    ...body,
    binding_id: `walmart-exact-identifier-guard-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256,
  });
}

export function isWalmartExactIdentifierDuplicateGuardBinding(
  input: SealedWalmartSellerCatalogAuthorityBinding,
): input is SealedWalmartExactIdentifierDuplicateGuardBinding {
  return input.schema_version ===
    WALMART_EXACT_IDENTIFIER_DUPLICATE_GUARD_BINDING_SCHEMA;
}

export function verifyWalmartExactIdentifierDuplicateGuardBinding(
  input: unknown,
): SealedWalmartExactIdentifierDuplicateGuardBinding {
  const root = record(input, "exact identifier duplicate guard binding");
  assertExactKeys(root, [
    "schema_version",
    "account_scope",
    "policy",
    "owner_decision_ref",
    "binding_id",
    "body_sha256",
  ], "exact identifier duplicate guard binding");
  if (root.schema_version !==
    WALMART_EXACT_IDENTIFIER_DUPLICATE_GUARD_BINDING_SCHEMA) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "exact identifier guard schema is invalid");
  }
  const account = record(root.account_scope, "account_scope");
  assertExactKeys(account, [
    "channel",
    "store_index",
    "business_seller_account_fingerprint_sha256",
  ], "account_scope");
  if (account.channel !== CHANNEL) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "account_scope.channel is invalid");
  }
  const policy = record(root.policy, "policy");
  assertExactKeys(policy, [
    "mode",
    "product_source",
    "full_seller_catalog_required",
    "seller_recipe_catalog_scan_required",
    "exact_seller_sku_absence_required_before_certification",
    "exact_upc_catalog_search_required_before_certification",
    "checks_must_bind_staged_sku_and_upc",
  ], "policy");
  if (policy.mode !== "EXACT_SKU_AND_UPC_PREFLIGHT_ONLY"
    || policy.product_source !== "PRODUCT_TRUTH_DONOR_CATALOG"
    || policy.full_seller_catalog_required !== false
    || policy.seller_recipe_catalog_scan_required !== false
    || policy.exact_seller_sku_absence_required_before_certification !== true
    || policy.exact_upc_catalog_search_required_before_certification !== true
    || policy.checks_must_bind_staged_sku_and_upc !== true) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "exact identifier guard policy changed");
  }
  const parsed: SealedWalmartExactIdentifierDuplicateGuardBinding = {
    schema_version: WALMART_EXACT_IDENTIFIER_DUPLICATE_GUARD_BINDING_SCHEMA,
    account_scope: {
      channel: CHANNEL,
      store_index: safeInteger(account.store_index, "account_scope.store_index", 1),
      business_seller_account_fingerprint_sha256: bindingSha256(
        account.business_seller_account_fingerprint_sha256,
        "account_scope.business_seller_account_fingerprint_sha256",
      ),
    },
    policy: {
      mode: "EXACT_SKU_AND_UPC_PREFLIGHT_ONLY",
      product_source: "PRODUCT_TRUTH_DONOR_CATALOG",
      full_seller_catalog_required: false,
      seller_recipe_catalog_scan_required: false,
      exact_seller_sku_absence_required_before_certification: true,
      exact_upc_catalog_search_required_before_certification: true,
      checks_must_bind_staged_sku_and_upc: true,
    },
    owner_decision_ref: exactString(root.owner_decision_ref, "owner_decision_ref"),
    binding_id: exactString(root.binding_id, "binding_id"),
    body_sha256: bindingSha256(root.body_sha256, "body_sha256"),
  };
  const body = structuredClone(parsed) as unknown as Record<string, unknown>;
  delete body.binding_id;
  delete body.body_sha256;
  const expectedBodySha256 = walmartItemReportSha256(body);
  if (parsed.body_sha256 !== expectedBodySha256
    || parsed.binding_id !==
      `walmart-exact-identifier-guard-${expectedBodySha256.slice(0, 16)}`) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "exact identifier guard seal is invalid");
  }
  return parsed;
}

/** Strict, pure verification of a previously sealed binding. */
export function verifyWalmartSellerCatalogAuthorityBinding(
  input: unknown,
): SealedWalmartSellerCatalogAuthorityBinding {
  const root = record(input, "catalog authority binding");
  if (root.schema_version ===
    WALMART_EXACT_IDENTIFIER_DUPLICATE_GUARD_BINDING_SCHEMA) {
    return verifyWalmartExactIdentifierDuplicateGuardBinding(root);
  }
  assertExactKeys(root, [
    "schema_version",
    "account_scope",
    "source_artifact",
    "mirror_reconciliation",
    "walmart_report_diagnostic",
    "freshness_policy",
    "binding_id",
    "body_sha256",
  ], "catalog authority binding");
  if (root.schema_version !== WALMART_SELLER_CATALOG_AUTHORITY_BINDING_SCHEMA) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "catalog authority schema is invalid");
  }

  const account = record(root.account_scope, "account_scope");
  assertExactKeys(account, [
    "channel",
    "store_index",
    "business_seller_account_fingerprint_sha256",
    "capture_credential_scope_fingerprint_sha256",
  ], "account_scope");
  if (account.channel !== CHANNEL) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "account_scope.channel is invalid");
  }
  const storeIndex = safeInteger(account.store_index, "account_scope.store_index", 1);
  const businessFingerprint = bindingSha256(
    account.business_seller_account_fingerprint_sha256,
    "account_scope.business_seller_account_fingerprint_sha256",
  );
  const captureFingerprint = bindingSha256(
    account.capture_credential_scope_fingerprint_sha256,
    "account_scope.capture_credential_scope_fingerprint_sha256",
  );

  const source = record(root.source_artifact, "source_artifact");
  assertExactKeys(source, [
    "absolute_path",
    "file_sha256",
    "file_byte_length",
    "schema_version",
    "source_id",
    "body_sha256",
    "artifact_account_fingerprint_sha256",
    "published_source_id",
    "published_source_body_sha256",
    "report_request_id_sha256",
    "requested_at",
    "cutoff_at",
    "downloaded_at",
    "raw_transport_sha256",
    "decoded_report_sha256",
    "row_count",
    "rows_sha256",
    "published_row_count",
    "published_rows_sha256",
    "status_counts_sha256",
  ], "source_artifact");
  const absolutePath = exactString(source.absolute_path, "source_artifact.absolute_path");
  if (!isAbsolute(absolutePath) || resolve(absolutePath) !== absolutePath) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "source artifact path is not absolute and normalized");
  }
  if (source.schema_version !== WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "source artifact schema is invalid");
  }
  const sourceArtifact = {
    absolute_path: absolutePath,
    file_sha256: bindingSha256(source.file_sha256, "source_artifact.file_sha256"),
    file_byte_length: safeInteger(source.file_byte_length, "source_artifact.file_byte_length", 2),
    schema_version: WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
    source_id: exactString(source.source_id, "source_artifact.source_id"),
    body_sha256: bindingSha256(source.body_sha256, "source_artifact.body_sha256"),
    artifact_account_fingerprint_sha256: bindingSha256(
      source.artifact_account_fingerprint_sha256,
      "source_artifact.artifact_account_fingerprint_sha256",
    ),
    published_source_id: exactString(
      source.published_source_id,
      "source_artifact.published_source_id",
    ),
    published_source_body_sha256: bindingSha256(
      source.published_source_body_sha256,
      "source_artifact.published_source_body_sha256",
    ),
    report_request_id_sha256: bindingSha256(
      source.report_request_id_sha256,
      "source_artifact.report_request_id_sha256",
    ),
    requested_at: iso(source.requested_at, "source_artifact.requested_at"),
    cutoff_at: iso(source.cutoff_at, "source_artifact.cutoff_at"),
    downloaded_at: iso(source.downloaded_at, "source_artifact.downloaded_at"),
    raw_transport_sha256: bindingSha256(
      source.raw_transport_sha256,
      "source_artifact.raw_transport_sha256",
    ),
    decoded_report_sha256: bindingSha256(
      source.decoded_report_sha256,
      "source_artifact.decoded_report_sha256",
    ),
    row_count: safeInteger(source.row_count, "source_artifact.row_count", 1),
    rows_sha256: bindingSha256(source.rows_sha256, "source_artifact.rows_sha256"),
    published_row_count: safeInteger(
      source.published_row_count,
      "source_artifact.published_row_count",
    ),
    published_rows_sha256: bindingSha256(
      source.published_rows_sha256,
      "source_artifact.published_rows_sha256",
    ),
    status_counts_sha256: bindingSha256(
      source.status_counts_sha256,
      "source_artifact.status_counts_sha256",
    ),
  };
  if (sourceArtifact.artifact_account_fingerprint_sha256 !== captureFingerprint
    || sourceArtifact.source_id
      !== `walmart-item-report-catalog-${sourceArtifact.body_sha256.slice(0, 16)}`
    || sourceArtifact.published_source_id
      !== `walmart-item-report-published-${sourceArtifact.published_source_body_sha256.slice(0, 16)}`
    || sourceArtifact.file_byte_length > WALMART_SELLER_CATALOG_AUTHORITY_FILE_MAX_BYTES
    || sourceArtifact.published_row_count > sourceArtifact.row_count
    || Date.parse(sourceArtifact.requested_at) > Date.parse(sourceArtifact.cutoff_at)
    || Date.parse(sourceArtifact.cutoff_at) > Date.parse(sourceArtifact.downloaded_at)) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "source artifact scope or chronology is invalid");
  }

  const mirror = record(root.mirror_reconciliation, "mirror_reconciliation");
  assertExactKeys(mirror, [
    "projection_schema_version",
    "synced_at",
    "row_count",
    "source_projection_sha256",
    "database_projection_sha256",
    "exact_match",
  ], "mirror_reconciliation");
  if (mirror.projection_schema_version !== MIRROR_PROJECTION_SCHEMA || mirror.exact_match !== true) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "mirror reconciliation policy is invalid");
  }
  const sourceProjectionSha256 = bindingSha256(
    mirror.source_projection_sha256,
    "mirror_reconciliation.source_projection_sha256",
  );
  const databaseProjectionSha256 = bindingSha256(
    mirror.database_projection_sha256,
    "mirror_reconciliation.database_projection_sha256",
  );
  const mirrorRowCount = safeInteger(mirror.row_count, "mirror_reconciliation.row_count", 1);
  const mirrorSyncedAt = iso(mirror.synced_at, "mirror_reconciliation.synced_at");
  if (mirrorRowCount !== sourceArtifact.row_count
    || sourceProjectionSha256 !== databaseProjectionSha256) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "mirror reconciliation does not prove exact equality");
  }

  const report = record(root.walmart_report_diagnostic, "walmart_report_diagnostic");
  assertExactKeys(report, [
    "report_type",
    "status",
    "request_id_sha256",
    "row_count",
    "downloaded_at",
    "source_download_skew_ms",
    "mirror_sync_skew_ms",
    "exact_match",
  ], "walmart_report_diagnostic");
  if (report.report_type !== "ITEM_CATALOG" || report.status !== "DOWNLOADED"
    || report.exact_match !== true) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "WalmartReport diagnostic policy is invalid");
  }
  const reportRequestSha256 = bindingSha256(
    report.request_id_sha256,
    "walmart_report_diagnostic.request_id_sha256",
  );
  const reportRowCount = safeInteger(report.row_count, "walmart_report_diagnostic.row_count", 1);
  const sourceDownloadSkewMs = safeInteger(
    report.source_download_skew_ms,
    "walmart_report_diagnostic.source_download_skew_ms",
  );
  const mirrorSyncSkewMs = safeInteger(
    report.mirror_sync_skew_ms,
    "walmart_report_diagnostic.mirror_sync_skew_ms",
  );
  const reportDownloadedAt = iso(
    report.downloaded_at,
    "walmart_report_diagnostic.downloaded_at",
  );
  const computedSourceDownloadSkewMs = Math.abs(
    Date.parse(reportDownloadedAt) - Date.parse(sourceArtifact.downloaded_at),
  );
  const computedMirrorSyncSkewMs = Math.abs(
    Date.parse(reportDownloadedAt) - Date.parse(mirrorSyncedAt),
  );
  if (reportRequestSha256 !== sourceArtifact.report_request_id_sha256
    || reportRowCount !== sourceArtifact.row_count
    || sourceDownloadSkewMs !== computedSourceDownloadSkewMs
    || mirrorSyncSkewMs !== computedMirrorSyncSkewMs
    || Math.abs(Date.parse(mirrorSyncedAt) - Date.parse(sourceArtifact.downloaded_at))
      > WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS
    || sourceDownloadSkewMs > WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS
    || mirrorSyncSkewMs > WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "WalmartReport diagnostic does not match source");
  }

  const freshness = record(root.freshness_policy, "freshness_policy");
  assertExactKeys(freshness, [
    "source_cutoff_and_download_max_age_ms",
    "mirror_and_report_max_age_ms",
    "mirror_source_skew_max_ms",
    "future_tolerance_ms",
  ], "freshness_policy");
  if (freshness.source_cutoff_and_download_max_age_ms
      !== WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS
    || freshness.mirror_and_report_max_age_ms
      !== WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS
    || freshness.mirror_source_skew_max_ms
      !== WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS
    || freshness.future_tolerance_ms !== 0) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "freshness policy was weakened or changed");
  }

  const parsed: SealedWalmartAllStatusSellerCatalogAuthorityBinding = {
    schema_version: WALMART_SELLER_CATALOG_AUTHORITY_BINDING_SCHEMA,
    account_scope: {
      channel: CHANNEL,
      store_index: storeIndex,
      business_seller_account_fingerprint_sha256: businessFingerprint,
      capture_credential_scope_fingerprint_sha256: captureFingerprint,
    },
    source_artifact: sourceArtifact,
    mirror_reconciliation: {
      projection_schema_version: MIRROR_PROJECTION_SCHEMA,
      synced_at: mirrorSyncedAt,
      row_count: mirrorRowCount,
      source_projection_sha256: sourceProjectionSha256,
      database_projection_sha256: databaseProjectionSha256,
      exact_match: true,
    },
    walmart_report_diagnostic: {
      report_type: "ITEM_CATALOG",
      status: "DOWNLOADED",
      request_id_sha256: reportRequestSha256,
      row_count: reportRowCount,
      downloaded_at: reportDownloadedAt,
      source_download_skew_ms: sourceDownloadSkewMs,
      mirror_sync_skew_ms: mirrorSyncSkewMs,
      exact_match: true,
    },
    freshness_policy: {
      source_cutoff_and_download_max_age_ms: WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS,
      mirror_and_report_max_age_ms: WALMART_SELLER_CATALOG_AUTHORITY_MAX_AGE_MS,
      mirror_source_skew_max_ms: WALMART_SELLER_CATALOG_MIRROR_SKEW_MAX_MS,
      future_tolerance_ms: 0,
    },
    binding_id: exactString(root.binding_id, "binding_id"),
    body_sha256: bindingSha256(root.body_sha256, "body_sha256"),
  };
  const body = structuredClone(parsed) as unknown as Record<string, unknown>;
  delete body.binding_id;
  delete body.body_sha256;
  const expectedBodySha256 = walmartItemReportSha256(body);
  const expectedBindingId = `walmart-seller-catalog-authority-${expectedBodySha256.slice(0, 16)}`;
  if (parsed.body_sha256 !== expectedBodySha256 || parsed.binding_id !== expectedBindingId) {
    fail("CATALOG_AUTHORITY_BINDING_INVALID", "catalog authority binding seal is invalid");
  }
  return parsed;
}

/**
 * Reread the pinned file and DB, then require the newly derived binding to be
 * canonical byte-exact with the expected binding. Freshness is evaluated at
 * this call's current time, so an old-but-unchanged binding still fails closed.
 */
export async function recheckWalmartSellerCatalogAuthorityBinding(input: {
  db: Client;
  expected: unknown;
  now: Date;
}): Promise<SealedWalmartSellerCatalogAuthorityBinding> {
  const expected = verifyWalmartSellerCatalogAuthorityBinding(input.expected);
  if (isWalmartExactIdentifierDuplicateGuardBinding(expected)) {
    return expected;
  }
  const current = await buildWalmartSellerCatalogAuthorityBinding({
    db: input.db,
    sourcePath: expected.source_artifact.absolute_path,
    expectedSourceFileSha256: expected.source_artifact.file_sha256,
    storeIndex: expected.account_scope.store_index,
    businessSellerAccountFingerprintSha256:
      expected.account_scope.business_seller_account_fingerprint_sha256,
    activeCaptureCredentialScopeFingerprintSha256:
      expected.account_scope.capture_credential_scope_fingerprint_sha256,
    now: input.now,
  });
  if (canonicalWalmartItemReportJson(current)
    !== canonicalWalmartItemReportJson(expected)) {
    fail("CATALOG_AUTHORITY_BINDING_DRIFT", "catalog authority binding changed on recheck");
  }
  return current;
}
