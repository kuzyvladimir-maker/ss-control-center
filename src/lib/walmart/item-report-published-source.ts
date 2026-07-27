/**
 * Offline, fail-closed ITEM v4/v6 parser and authoritative v6 population compiler.
 *
 * The input is an immutable capture envelope for the complete request chain:
 * create POST, READY status GET, download-locator GET, and presigned file GET.
 * A separately trusted context must contain per-exchange seals produced by the
 * atomic capture adapter while it holds the selected seller credential scope.
 * The compiler deterministically decodes transport, strictly parses the ITEM
 * report, reconciles every record, and emits the exact PUBLISHED population. It
 * has no filesystem, DB, network, or model I/O.
 *
 * Trust boundary: these seals detect detached/mixed capture artifacts only when
 * their expected digests arrive through that external trusted adapter boundary.
 * They are not Walmart signatures and do not independently prove TLS identity,
 * server authenticity, or the truth of caller-authored trusted context.
 *
 * Important identity rules: documented ProductId + ProductIdType are preserved
 * as an opaque typed global-product identifier (UPC/EAN/ISBN semantics), never
 * as a buyer-facing Walmart item ID. Legacy `Item ID`, `WPID`, and lifecycle
 * columns are separate optional evidence and are never aliases or scope filters.
 */

import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";

import {
  walmartListingKey,
  type WalmartListingIdentity,
} from "./catalog-truth-export.ts";

export { walmartListingKey } from "./catalog-truth-export.ts";

export const WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA =
  "walmart-item-report-published-source/v1" as const;
export const WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA =
  "walmart-item-report-catalog-source/v1" as const;
export const WALMART_ITEM_REPORT_STATUS_POLICY =
  "walmart-item-v4-v6-published-only/v1" as const;
export const WALMART_ITEM_REPORT_CATALOG_STATUS_POLICY =
  "walmart-item-v6-all-status-catalog/v1" as const;
export const WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA =
  "walmart-item-report-create-request/v1" as const;
export const WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA =
  "walmart-item-report-ready-request/v1" as const;
export const WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA =
  "walmart-item-report-download-locator-request/v1" as const;
export const WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA =
  "walmart-item-report-file-request/v1" as const;
export const WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID =
  "walmart-item-report-download-url-policy/v1" as const;
export const WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID =
  "walmart-item-report-trusted-atomic-exchange/v1" as const;

const APPROVED_DOWNLOAD_HOST_SUFFIXES = Object.freeze([
  ".amazonaws.com",
  ".blob.core.windows.net",
  ".cloudfront.net",
  ".storage.googleapis.com",
  ".walmartapis.com",
] as const);

const CHANNEL = "WALMART_US" as const;
const REPORT_TYPE = "ITEM" as const;
const TEXT_ENCODING = "utf-8" as const;

export const WALMART_ITEM_REPORT_LIMITS = Object.freeze({
  max_transport_bytes: 64 * 1024 * 1024,
  max_decoded_report_bytes: 128 * 1024 * 1024,
  max_create_request_bytes: 1024 * 1024,
  max_create_response_bytes: 1024 * 1024,
  max_ready_request_bytes: 1024 * 1024,
  max_ready_status_bytes: 1024 * 1024,
  max_download_locator_request_bytes: 1024 * 1024,
  max_download_locator_response_bytes: 1024 * 1024,
  max_report_file_request_bytes: 2 * 1024 * 1024,
  max_redirects: 8,
  max_logical_records: 50_000,
  max_columns: 512,
  max_field_characters: 1_000_000,
  max_compression_ratio: 1_000,
} as const);

const PUBLISHED_STATUSES = ["PUBLISHED", "SYSTEM_PROBLEM", "UNPUBLISHED"] as const;
const LIFECYCLE_STATUSES = ["ACTIVE", "ARCHIVED", "RETIRED"] as const;
type PublishedStatus = (typeof PUBLISHED_STATUSES)[number];
type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
type SupportedReportVersion = "v4" | "v6";
type Delimiter = "," | "\t";
type LineEnding = "LF" | "CRLF" | "MIXED" | "NONE";
type DownloadContainer = "plain" | "gzip" | "zip";

const REQUIRED_HEADER_ALIASES = {
  sku: ["SKU"],
  product_name: ["ProductName"],
  product_id: ["ProductId"],
  product_id_type: ["ProductIdType"],
  published_status: ["PublishedStatus"],
} as const;

const OPTIONAL_HEADER_ALIASES = {
  lifecycle_status: ["LifecycleStatus"],
  product_condition: ["ProductCondition"],
  legacy_item_id: ["Item ID", "Walmart Item ID"],
  legacy_wpid: ["WPID"],
} as const;

type RequiredHeaderRole = keyof typeof REQUIRED_HEADER_ALIASES;
type OptionalHeaderRole = keyof typeof OPTIONAL_HEADER_ALIASES;

export interface WalmartItemReportCaptureEvidence {
  create_request_manifest_bytes: Uint8Array;
  create_response_payload_bytes: Uint8Array;
  ready_status_request_manifest_bytes: Uint8Array;
  download_locator_request_manifest_bytes: Uint8Array;
  download_locator_response_payload_bytes: Uint8Array;
  report_file_request_manifest_bytes: Uint8Array;
  downloaded_body_bytes: Uint8Array;
  ready_status_payload_bytes: Uint8Array;
  http: {
    create_response: HttpResponseCaptureMetadata;
    ready_status_response: HttpResponseCaptureMetadata;
    download_locator_response: HttpResponseCaptureMetadata;
    download_response: HttpResponseCaptureMetadata;
  };
}

export interface HttpResponseCaptureMetadata {
  status: number;
  content_type: string | null;
  content_length: number | null;
  echoed_correlation_id_sha256: string | null;
  echoed_report_request_id_sha256: string | null;
}

export interface WalmartItemReportCompileContext {
  account_scope: {
    channel: typeof CHANNEL;
    store_index: number;
    seller_account_fingerprint_sha256: string;
  };
  request_correlations: {
    create_sha256: string;
    ready_status_sha256: string;
    download_locator_sha256: string;
    report_file_sha256: string;
  };
  trusted_exchange_seals: {
    create_response_sha256: string;
    ready_status_response_sha256: string;
    download_locator_response_sha256: string;
    download_response_sha256: string;
  };
  ready_at: string;
  download_locator_at: string;
  report_file_requested_at: string;
  downloaded_at: string;
}

export interface WalmartPublishedListingRow extends WalmartListingIdentity {
  reported_product_identifier_opaque: string;
  reported_product_identifier_type_opaque: string;
  reported_product_identifier_header: string;
  reported_product_identifier_type_header: string;
  reported_product_name: string;
  reported_product_name_header: string;
  reported_product_condition: string | null;
  reported_product_condition_header: string | null;
  reported_lifecycle_status: LifecycleStatus | null;
  reported_lifecycle_status_header: string | null;
  reported_legacy_item_identifier_opaque: string | null;
  reported_legacy_item_identifier_header: string | null;
  reported_legacy_wpid_opaque: string | null;
  reported_legacy_wpid_header: string | null;
  published_status: "PUBLISHED";
  source_record_number: number;
  source_record_sha256: string;
}

interface StatusCount<T extends string> {
  status: T;
  count: number;
}

export interface WalmartItemReportPublishedSourceBody {
  schema_version: typeof WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA;
  account_scope: WalmartItemReportCompileContext["account_scope"];
  report: {
    source_system: "walmart_marketplace_api";
    report_type: typeof REPORT_TYPE;
    report_version: "v6";
    report_request_id: string;
    requested_at: string;
    cutoff_at: string;
    cutoff_basis: "READY_OBSERVED_UPPER_BOUND";
    ready_at: string;
    download_locator_at: string;
    report_file_requested_at: string;
    downloaded_at: string;
    create_request: {
      manifest_schema_version: typeof WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA;
      manifest_sha256: string;
      manifest_byte_length: number;
      method: "POST";
      endpoint: "/v3/reports/reportRequests";
      report_type: typeof REPORT_TYPE;
      report_version: "v6";
      content_type: "application/json";
      body_empty_object: true;
      unfiltered_full_report: true;
      account_scope_exact_match: true;
      request_correlation_id_sha256: string;
    };
    create_response: {
      payload_sha256: string;
      payload_byte_length: number;
      http_status: number;
      http_content_type: string | null;
      http_content_length: number | null;
      request_id_exact_match: true;
      request_submission_date_exact_match: true;
      trusted_exchange_policy_id: typeof WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID;
      trusted_exchange_sha256: string;
      echoed_correlation_id_sha256: string | null;
      echoed_report_request_id_sha256: string | null;
    };
    authority_evidence: {
      request_manifest_schema_version: typeof WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA;
      request_manifest_sha256: string;
      request_manifest_byte_length: number;
      method: "GET";
      endpoint: "/v3/reports/reportRequests/{requestId}";
      request_id_path_exact_match: true;
      account_scope_exact_match: true;
      request_correlation_id_sha256: string;
      trusted_exchange_policy_id: typeof WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID;
      trusted_exchange_sha256: string;
      ready_status_payload_sha256: string;
      ready_status_payload_byte_length: number;
      request_status: "READY";
      request_id_exact_match: true;
      report_type_exact_match: true;
      report_version_exact_match: true;
      http_status: number;
      http_content_type: string | null;
      http_content_length: number | null;
      echoed_correlation_id_sha256: string | null;
      echoed_report_request_id_sha256: string | null;
    };
    download_locator: {
      request_manifest_schema_version: typeof WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA;
      request_manifest_sha256: string;
      request_manifest_byte_length: number;
      method: "GET";
      endpoint: "/v3/reports/downloadReport";
      request_id_exact_match: true;
      unfiltered_locator_request: true;
      account_scope_exact_match: true;
      request_correlation_id_sha256: string;
      trusted_exchange_policy_id: typeof WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID;
      trusted_exchange_sha256: string;
      response_payload_sha256: string;
      response_payload_byte_length: number;
      http_status: number;
      http_content_type: string | null;
      http_content_length: number | null;
      download_url_sha256: string;
      download_url_expiration_at: string;
      echoed_correlation_id_sha256: string | null;
      echoed_report_request_id_sha256: string | null;
    };
    report_file_request: {
      manifest_schema_version: typeof WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA;
      manifest_sha256: string;
      manifest_byte_length: number;
      method: "GET";
      url_policy_id: typeof WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID;
      initial_url_sha256: string;
      final_url_sha256: string;
      redirect_chain_sha256: string;
      redirect_count: number;
      all_urls_policy_approved: true;
      locator_url_exact_match: true;
      account_scope_exact_match: true;
      request_correlation_id_sha256: string;
    };
    download_transport: {
      bytes_sha256: string;
      byte_length: number;
      http_content_type: string | null;
      http_content_length: number | null;
      http_status: number;
      trusted_exchange_policy_id: typeof WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID;
      trusted_exchange_sha256: string;
      echoed_correlation_id_sha256: string | null;
      echoed_report_request_id_sha256: string | null;
      detected_container: DownloadContainer;
      decoded_member_name: string | null;
    };
    decoded_report: {
      bytes_sha256: string;
      byte_length: number;
      text_encoding: typeof TEXT_ENCODING;
      utf8_bom: boolean;
      delimiter: Delimiter;
      media_type: "text/csv" | "text/tab-separated-values";
      line_ending: LineEnding;
      header: string[];
      header_sha256: string;
      header_mapping: Record<RequiredHeaderRole, number> & Record<OptionalHeaderRole, number | null>;
      logical_record_count: number;
      data_record_count: number;
    };
  };
  status_semantics: {
    policy_id: typeof WALMART_ITEM_REPORT_STATUS_POLICY;
    accepted_published_statuses: PublishedStatus[];
    accepted_lifecycle_statuses: LifecycleStatus[];
    inclusion_rule: {
      published_status: "PUBLISHED";
      lifecycle_filter: "NONE";
    };
    lifecycle_status_role: "OPTIONAL_EVIDENCE_ONLY";
  };
  reconciliation: {
    parsed_data_record_count: number;
    included_published_count: number;
    excluded_non_published_count: number;
    unique_published_listing_count: number;
    output_row_count: number;
    malformed_record_count: 0;
    duplicate_listing_key_count: 0;
    conflicting_listing_key_count: 0;
    published_status_counts: Array<StatusCount<PublishedStatus>>;
    lifecycle_status_counts: Array<StatusCount<LifecycleStatus>>;
    lifecycle_status_not_reported_count: number;
  };
  published_population_complete: true;
  rows: WalmartPublishedListingRow[];
}

export interface SealedWalmartItemReportPublishedSource
  extends WalmartItemReportPublishedSourceBody {
  source_id: string;
  body_sha256: string;
}

/**
 * One exact row from the complete ITEM v6 report population. Unlike
 * WalmartPublishedListingRow this projection intentionally retains every
 * supported PublishedStatus. LifecycleStatus remains independent evidence:
 * PUBLISHED + ARCHIVED is valid input and must not disappear from the catalog.
 */
export interface WalmartItemReportCatalogRow
  extends Omit<WalmartPublishedListingRow, "published_status"> {
  reported_brand: string | null;
  reported_brand_header: string;
  published_status: PublishedStatus;
}

export interface WalmartItemReportCatalogSourceBody {
  schema_version: typeof WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA;
  account_scope: WalmartItemReportCompileContext["account_scope"];
  report: {
    source_system: "walmart_marketplace_api";
    report_type: typeof REPORT_TYPE;
    report_version: "v6";
    report_request_id: string;
    report_request_id_sha256: string;
    requested_at: string;
    cutoff_at: string;
    cutoff_basis: "READY_OBSERVED_UPPER_BOUND";
    downloaded_at: string;
    raw_transport_sha256: string;
    decoded_report_sha256: string;
    parsed_data_record_count: number;
  };
  published_source: {
    schema_version: typeof WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA;
    source_id: string;
    body_sha256: string;
  };
  status_semantics: {
    policy_id: typeof WALMART_ITEM_REPORT_CATALOG_STATUS_POLICY;
    included_published_statuses: PublishedStatus[];
    accepted_lifecycle_statuses: LifecycleStatus[];
    inclusion_rule: "ALL_REPORT_ROWS";
    lifecycle_status_role: "OPTIONAL_EVIDENCE_ONLY";
  };
  reconciliation: {
    parsed_data_record_count: number;
    output_row_count: number;
    unique_listing_count: number;
    rows_sha256: string;
    published_row_count: number;
    published_rows_sha256: string;
    malformed_record_count: 0;
    duplicate_listing_key_count: 0;
    conflicting_listing_key_count: 0;
    published_status_counts: Array<StatusCount<PublishedStatus>>;
    lifecycle_status_counts: Array<StatusCount<LifecycleStatus>>;
    lifecycle_status_not_reported_count: number;
  };
  catalog_population_complete: true;
  rows: WalmartItemReportCatalogRow[];
}

export interface SealedWalmartItemReportCatalogSource
  extends WalmartItemReportCatalogSourceBody {
  source_id: string;
  body_sha256: string;
}

type JsonRecord = Record<string, unknown>;

interface ParsedCapture {
  createRequestBytes: Uint8Array;
  createResponseBytes: Uint8Array;
  readyRequestBytes: Uint8Array;
  downloadLocatorRequestBytes: Uint8Array;
  downloadLocatorResponseBytes: Uint8Array;
  reportFileRequestBytes: Uint8Array;
  transportBytes: Uint8Array;
  statusBytes: Uint8Array;
  createResponseHttp: ParsedHttpResponseMetadata;
  readyStatusHttp: ParsedHttpResponseMetadata;
  downloadLocatorHttp: ParsedHttpResponseMetadata;
  downloadHttp: ParsedHttpResponseMetadata;
}

interface ParsedHttpResponseMetadata {
  status: number;
  contentType: string | null;
  contentLength: number | null;
  echoedCorrelationIdSha256: string | null;
  echoedReportRequestIdSha256: string | null;
}

interface DecodedTransport {
  container: DownloadContainer;
  memberName: string | null;
  reportBytes: Uint8Array;
}

interface HeaderMapping extends Record<RequiredHeaderRole, number>, Record<OptionalHeaderRole, number | null> {}

interface ParsedReport {
  delimiter: Delimiter;
  mediaType: "text/csv" | "text/tab-separated-values";
  utf8Bom: boolean;
  lineEnding: LineEnding;
  header: string[];
  headerMapping: HeaderMapping;
  records: Array<{ sourceRecordNumber: number; cells: string[] }>;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function assertExactKeys(value: JsonRecord, required: readonly string[], path: string): void {
  const allowed = new Set(required);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length) throw new Error(`${path} has unsupported fields: ${extras.join(", ")}`);
  if (missing.length) throw new Error(`${path} is missing required fields: ${missing.join(", ")}`);
}

function exactString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  if (value.length > WALMART_ITEM_REPORT_LIMITS.max_field_characters) {
    throw new Error(`${path} exceeds the field-length safety cap`);
  }
  if (value !== value.trim()) throw new Error(`${path} must already be trimmed`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${path} must not contain control characters`);
  return value;
}

function exactText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  if (value.length > WALMART_ITEM_REPORT_LIMITS.max_field_characters) {
    throw new Error(`${path} exceeds the field-length safety cap`);
  }
  if (value !== value.trim()) throw new Error(`${path} must already be trimmed`);
  if (/[\u0000\r\n]/u.test(value)) throw new Error(`${path} must not contain NUL or line breaks`);
  return value;
}

function nullableHeaderString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return exactString(value, path);
}

function sha256String(value: unknown, path: string): string {
  const parsed = exactString(value, path);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
  return parsed;
}

function nullableSha256String(value: unknown, path: string): string | null {
  if (value === null) return null;
  return sha256String(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${path} must be a positive safe integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${path} must be a non-negative safe integer`);
  return Number(value);
}

function nullableNonNegativeInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  return nonNegativeInteger(value, path);
}

function isoTimestamp(value: unknown, path: string): string {
  const parsed = exactString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(parsed)
    || !Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${path} must be an ISO-8601 timestamp with timezone`);
  }
  return parsed;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Canonical JSON used for all body, header, and record seals. */
export function canonicalWalmartItemReportJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalWalmartItemReportJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonicalWalmartItemReportJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}

export function walmartItemReportSha256(value: unknown): string {
  return createHash("sha256").update(canonicalWalmartItemReportJson(value)).digest("hex");
}

/** SHA-256 for opaque exact UTF-8 values such as correlation IDs and presigned URLs. */
export function walmartItemReportUtf8Sha256(value: string): string {
  return createHash("sha256").update(exactString(value, "opaque UTF-8 value"), "utf8").digest("hex");
}

export interface WalmartItemReportTrustedExchangeInput {
  request_manifest_bytes: Uint8Array;
  request_correlation_id_sha256: string;
  response_payload_bytes: Uint8Array;
  http: HttpResponseCaptureMetadata;
}

/**
 * Deterministic exchange seal expected from the trusted atomic capture adapter.
 * The digest is not a server signature. Its authority comes only from supplying
 * the expected value through trusted compile context, outside the mutable capture.
 */
export function walmartItemReportTrustedExchangeSha256(input: unknown): string {
  const raw = asRecord(input, "trusted exchange input");
  assertExactKeys(raw, [
    "request_manifest_bytes",
    "request_correlation_id_sha256",
    "response_payload_bytes",
    "http",
  ], "trusted exchange input");
  const requestBytes = copyBytes(
    raw.request_manifest_bytes,
    "trusted exchange input.request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_report_file_request_bytes,
  );
  const responseBytes = copyBytes(
    raw.response_payload_bytes,
    "trusted exchange input.response_payload_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes,
  );
  const correlationSha256 = sha256String(
    raw.request_correlation_id_sha256,
    "trusted exchange input.request_correlation_id_sha256",
  );
  const http = asRecord(raw.http, "trusted exchange input.http");
  assertExactKeys(http, [
    "status",
    "content_type",
    "content_length",
    "echoed_correlation_id_sha256",
    "echoed_report_request_id_sha256",
  ], "trusted exchange input.http");
  const status = positiveInteger(http.status, "trusted exchange input.http.status");
  const contentType = http.content_type === null
    ? null
    : exactString(http.content_type, "trusted exchange input.http.content_type");
  const contentLength = nullableNonNegativeInteger(
    http.content_length,
    "trusted exchange input.http.content_length",
  );
  if (contentLength !== null && contentLength !== responseBytes.byteLength) {
    throw new Error("trusted exchange input HTTP content length does not match response bytes");
  }
  const echoedCorrelation = nullableSha256String(
    http.echoed_correlation_id_sha256,
    "trusted exchange input.http.echoed_correlation_id_sha256",
  );
  const echoedRequestId = nullableSha256String(
    http.echoed_report_request_id_sha256,
    "trusted exchange input.http.echoed_report_request_id_sha256",
  );
  return walmartItemReportSha256({
    policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
    request_manifest_sha256: sha256Bytes(requestBytes),
    request_manifest_byte_length: requestBytes.byteLength,
    request_correlation_id_sha256: correlationSha256,
    response_payload_sha256: sha256Bytes(responseBytes),
    response_payload_byte_length: responseBytes.byteLength,
    http_status: status,
    http_content_type: contentType,
    http_content_length: contentLength,
    echoed_correlation_id_sha256: echoedCorrelation,
    echoed_report_request_id_sha256: echoedRequestId,
  });
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyBytes(value: unknown, path: string, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${path} must be a non-empty Uint8Array`);
  }
  if (value.byteLength > maximum) throw new Error(`${path} exceeds the ${maximum}-byte safety cap`);
  return new Uint8Array(value);
}

function parseCapture(input: unknown): ParsedCapture {
  const raw = asRecord(input, "capture");
  assertExactKeys(raw, [
    "create_request_manifest_bytes",
    "create_response_payload_bytes",
    "ready_status_request_manifest_bytes",
    "ready_status_payload_bytes",
    "download_locator_request_manifest_bytes",
    "download_locator_response_payload_bytes",
    "report_file_request_manifest_bytes",
    "downloaded_body_bytes",
    "http",
  ], "capture");
  const createRequestBytes = copyBytes(
    raw.create_request_manifest_bytes,
    "capture.create_request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_create_request_bytes,
  );
  const createResponseBytes = copyBytes(
    raw.create_response_payload_bytes,
    "capture.create_response_payload_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes,
  );
  const readyRequestBytes = copyBytes(
    raw.ready_status_request_manifest_bytes,
    "capture.ready_status_request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_ready_request_bytes,
  );
  const downloadLocatorRequestBytes = copyBytes(
    raw.download_locator_request_manifest_bytes,
    "capture.download_locator_request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_request_bytes,
  );
  const downloadLocatorResponseBytes = copyBytes(
    raw.download_locator_response_payload_bytes,
    "capture.download_locator_response_payload_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes,
  );
  const reportFileRequestBytes = copyBytes(
    raw.report_file_request_manifest_bytes,
    "capture.report_file_request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_report_file_request_bytes,
  );
  const transportBytes = copyBytes(
    raw.downloaded_body_bytes,
    "capture.downloaded_body_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_transport_bytes,
  );
  const statusBytes = copyBytes(
    raw.ready_status_payload_bytes,
    "capture.ready_status_payload_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes,
  );
  const http = asRecord(raw.http, "capture.http");
  assertExactKeys(http, [
    "create_response",
    "ready_status_response",
    "download_locator_response",
    "download_response",
  ], "capture.http");
  const parseHttp = (
    value: unknown,
    path: string,
    bodyLength: number,
    allowedStatuses: readonly number[],
  ): ParsedHttpResponseMetadata => {
    const metadata = asRecord(value, path);
    assertExactKeys(metadata, [
      "status",
      "content_type",
      "content_length",
      "echoed_correlation_id_sha256",
      "echoed_report_request_id_sha256",
    ], path);
    const status = positiveInteger(metadata.status, `${path}.status`);
    if (!allowedStatuses.includes(status)) {
      throw new Error(`${path}.status must be ${allowedStatuses.join(" or ")}`);
    }
    const contentType = metadata.content_type === null
      ? null
      : exactString(metadata.content_type, `${path}.content_type`);
    const contentLength = nullableNonNegativeInteger(metadata.content_length, `${path}.content_length`);
    if (contentLength !== null && contentLength !== bodyLength) {
      throw new Error(`${path}.content_length does not match captured body bytes`);
    }
    return {
      status,
      contentType,
      contentLength,
      echoedCorrelationIdSha256: nullableSha256String(
        metadata.echoed_correlation_id_sha256,
        `${path}.echoed_correlation_id_sha256`,
      ),
      echoedReportRequestIdSha256: nullableSha256String(
        metadata.echoed_report_request_id_sha256,
        `${path}.echoed_report_request_id_sha256`,
      ),
    };
  };
  return {
    createRequestBytes,
    createResponseBytes,
    readyRequestBytes,
    downloadLocatorRequestBytes,
    downloadLocatorResponseBytes,
    reportFileRequestBytes,
    transportBytes,
    statusBytes,
    createResponseHttp: parseHttp(
      http.create_response,
      "capture.http.create_response",
      createResponseBytes.byteLength,
      [200, 201],
    ),
    readyStatusHttp: parseHttp(
      http.ready_status_response,
      "capture.http.ready_status_response",
      statusBytes.byteLength,
      [200],
    ),
    downloadLocatorHttp: parseHttp(
      http.download_locator_response,
      "capture.http.download_locator_response",
      downloadLocatorResponseBytes.byteLength,
      [200],
    ),
    downloadHttp: parseHttp(
      http.download_response,
      "capture.http.download_response",
      transportBytes.byteLength,
      [200],
    ),
  };
}

function parseContext(input: unknown): WalmartItemReportCompileContext {
  const raw = asRecord(input, "context");
  assertExactKeys(raw, [
    "account_scope",
    "request_correlations",
    "trusted_exchange_seals",
    "ready_at",
    "download_locator_at",
    "report_file_requested_at",
    "downloaded_at",
  ], "context");
  const scope = asRecord(raw.account_scope, "context.account_scope");
  assertExactKeys(scope, ["channel", "store_index", "seller_account_fingerprint_sha256"], "context.account_scope");
  if (scope.channel !== CHANNEL) throw new Error(`context.account_scope.channel must be ${CHANNEL}`);
  const readyAt = isoTimestamp(raw.ready_at, "context.ready_at");
  const downloadLocatorAt = isoTimestamp(raw.download_locator_at, "context.download_locator_at");
  const reportFileRequestedAt = isoTimestamp(raw.report_file_requested_at, "context.report_file_requested_at");
  const downloadedAt = isoTimestamp(raw.downloaded_at, "context.downloaded_at");
  if (Date.parse(readyAt) > Date.parse(downloadLocatorAt)
    || Date.parse(downloadLocatorAt) > Date.parse(reportFileRequestedAt)
    || Date.parse(reportFileRequestedAt) > Date.parse(downloadedAt)) {
    throw new Error(
      "context chronology must satisfy ready_at <= download_locator_at <= report_file_requested_at <= downloaded_at",
    );
  }
  const correlations = asRecord(raw.request_correlations, "context.request_correlations");
  assertExactKeys(correlations, [
    "create_sha256",
    "ready_status_sha256",
    "download_locator_sha256",
    "report_file_sha256",
  ], "context.request_correlations");
  const requestCorrelations = {
    create_sha256: sha256String(correlations.create_sha256, "context.request_correlations.create_sha256"),
    ready_status_sha256: sha256String(
      correlations.ready_status_sha256,
      "context.request_correlations.ready_status_sha256",
    ),
    download_locator_sha256: sha256String(
      correlations.download_locator_sha256,
      "context.request_correlations.download_locator_sha256",
    ),
    report_file_sha256: sha256String(
      correlations.report_file_sha256,
      "context.request_correlations.report_file_sha256",
    ),
  };
  if (new Set(Object.values(requestCorrelations)).size !== 4) {
    throw new Error("context.request_correlations must use a distinct correlation ID hash for every request");
  }
  const seals = asRecord(raw.trusted_exchange_seals, "context.trusted_exchange_seals");
  assertExactKeys(seals, [
    "create_response_sha256",
    "ready_status_response_sha256",
    "download_locator_response_sha256",
    "download_response_sha256",
  ], "context.trusted_exchange_seals");
  const trustedExchangeSeals = {
    create_response_sha256: sha256String(
      seals.create_response_sha256,
      "context.trusted_exchange_seals.create_response_sha256",
    ),
    ready_status_response_sha256: sha256String(
      seals.ready_status_response_sha256,
      "context.trusted_exchange_seals.ready_status_response_sha256",
    ),
    download_locator_response_sha256: sha256String(
      seals.download_locator_response_sha256,
      "context.trusted_exchange_seals.download_locator_response_sha256",
    ),
    download_response_sha256: sha256String(
      seals.download_response_sha256,
      "context.trusted_exchange_seals.download_response_sha256",
    ),
  };
  if (new Set(Object.values(trustedExchangeSeals)).size !== 4) {
    throw new Error("context.trusted_exchange_seals must contain four distinct atomic exchange seals");
  }
  return {
    account_scope: {
      channel: CHANNEL,
      store_index: positiveInteger(scope.store_index, "context.account_scope.store_index"),
      seller_account_fingerprint_sha256: sha256String(
        scope.seller_account_fingerprint_sha256,
        "context.account_scope.seller_account_fingerprint_sha256",
      ),
    },
    request_correlations: requestCorrelations,
    trusted_exchange_seals: trustedExchangeSeals,
    ready_at: readyAt,
    download_locator_at: downloadLocatorAt,
    report_file_requested_at: reportFileRequestedAt,
    downloaded_at: downloadedAt,
  };
}

function decodeUtf8(bytes: Uint8Array, path: string, allowBom: boolean): { text: string; bom: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bom && !allowBom) throw new Error(`${path} must not contain a UTF-8 BOM`);
  const body = bom ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body), bom };
  } catch {
    throw new Error(`${path} is not valid UTF-8`);
  }
}

function parseJsonBytes(bytes: Uint8Array, path: string): JsonRecord {
  const { text } = decodeUtf8(bytes, path, false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} must contain valid JSON`);
  }
  return asRecord(parsed, path);
}

function advertisedStrings(values: unknown[], label: string): string[] {
  const advertised = values.filter((value) => value !== undefined && value !== null);
  if (advertised.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error(`captured Walmart payload has invalid advertised ${label}`);
  }
  return advertised as string[];
}

function advertisedTimestamp(
  values: unknown[],
  label: string,
  required: boolean,
): string | null {
  const advertised = advertisedStrings(values, label);
  if (required && advertised.length === 0) throw new Error(`captured Walmart payload is missing ${label}`);
  if (advertised.length === 0) return null;
  const instants = advertised.map((value, index) => Date.parse(isoTimestamp(value, `${label}[${index}]`)));
  if (new Set(instants).size !== 1) throw new Error(`captured Walmart payload has conflicting ${label}`);
  return new Date(instants[0]).toISOString();
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function assertHttpEchoBindings(
  http: ParsedHttpResponseMetadata,
  expectedCorrelationSha256: string,
  requestId: string,
  path: string,
): void {
  if (http.echoedCorrelationIdSha256 !== null
    && http.echoedCorrelationIdSha256 !== expectedCorrelationSha256) {
    throw new Error(`${path}.echoed_correlation_id_sha256 conflicts with request manifest`);
  }
  const requestIdSha256 = walmartItemReportUtf8Sha256(requestId);
  if (http.echoedReportRequestIdSha256 !== null
    && http.echoedReportRequestIdSha256 !== requestIdSha256) {
    throw new Error(`${path}.echoed_report_request_id_sha256 conflicts with report requestId`);
  }
}

function assertTrustedExchangeBinding(
  requestManifestBytes: Uint8Array,
  requestCorrelationSha256: string,
  responsePayloadBytes: Uint8Array,
  http: ParsedHttpResponseMetadata,
  expectedSealSha256: string,
  path: string,
): void {
  const actual = walmartItemReportTrustedExchangeSha256({
    request_manifest_bytes: requestManifestBytes,
    request_correlation_id_sha256: requestCorrelationSha256,
    response_payload_bytes: responsePayloadBytes,
    http: {
      status: http.status,
      content_type: http.contentType,
      content_length: http.contentLength,
      echoed_correlation_id_sha256: http.echoedCorrelationIdSha256,
      echoed_report_request_id_sha256: http.echoedReportRequestIdSha256,
    },
  });
  if (actual !== expectedSealSha256) {
    throw new Error(`${path} does not match the trusted atomic capture exchange seal`);
  }
}

export interface WalmartItemReportRequestManifestBinding {
  account_scope: WalmartItemReportCompileContext["account_scope"];
  request_correlation_id_sha256: string;
}

export interface WalmartItemReportFileRedirectInput {
  status: 301 | 302 | 303 | 307 | 308;
  from_url: string;
  to_url: string;
}

export interface WalmartItemReportFileRequestManifestInput
  extends WalmartItemReportRequestManifestBinding {
  locator_url: string;
  redirects?: WalmartItemReportFileRedirectInput[];
}

interface DownloadUrlDescriptor {
  url_sha256: string;
  hostname: string;
  path_sha256: string;
  https: true;
  query_present: boolean;
  no_credentials: true;
  no_fragment: true;
  default_port: true;
  host_policy_approved: true;
  path_policy_approved: true;
}

function parseAccountScope(value: unknown, path: string): WalmartItemReportCompileContext["account_scope"] {
  const scope = asRecord(value, path);
  assertExactKeys(scope, ["channel", "store_index", "seller_account_fingerprint_sha256"], path);
  if (scope.channel !== CHANNEL) throw new Error(`${path}.channel must be ${CHANNEL}`);
  return {
    channel: CHANNEL,
    store_index: positiveInteger(scope.store_index, `${path}.store_index`),
    seller_account_fingerprint_sha256: sha256String(
      scope.seller_account_fingerprint_sha256,
      `${path}.seller_account_fingerprint_sha256`,
    ),
  };
}

function parseManifestBinding(value: unknown, path: string): WalmartItemReportRequestManifestBinding {
  const raw = asRecord(value, path);
  assertExactKeys(raw, ["account_scope", "request_correlation_id_sha256"], path);
  return {
    account_scope: parseAccountScope(raw.account_scope, `${path}.account_scope`),
    request_correlation_id_sha256: sha256String(
      raw.request_correlation_id_sha256,
      `${path}.request_correlation_id_sha256`,
    ),
  };
}

function manifestAuthority(bindingInput: WalmartItemReportRequestManifestBinding) {
  const binding = parseManifestBinding(bindingInput, "request manifest binding");
  return {
    account_scope: { ...binding.account_scope },
    request_correlation_id_sha256: binding.request_correlation_id_sha256,
  };
}

function assertManifestAuthority(
  value: unknown,
  context: WalmartItemReportCompileContext,
  expectedCorrelationSha256: string,
  path: string,
): void {
  const authority = parseManifestBinding(value, path);
  if (canonicalWalmartItemReportJson(authority.account_scope)
    !== canonicalWalmartItemReportJson(context.account_scope)) {
    throw new Error(`${path}.account_scope does not exactly match trusted credential scope`);
  }
  if (authority.request_correlation_id_sha256 !== expectedCorrelationSha256) {
    throw new Error(`${path}.request_correlation_id_sha256 does not match trusted request correlation`);
  }
}

function approvedDownloadHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return APPROVED_DOWNLOAD_HOST_SUFFIXES.some((suffix) => (
    normalized === suffix.slice(1) || normalized.endsWith(suffix)
  ));
}

function approvedDownloadUrlDescriptor(value: string, path: string): DownloadUrlDescriptor {
  const rawUrl = exactString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${path} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${path} must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${path} must not contain credentials`);
  if (parsed.hash) throw new Error(`${path} must not contain a fragment`);
  if (parsed.port) throw new Error(`${path} must not use a non-default port`);
  const hostname = parsed.hostname.toLowerCase();
  if (!approvedDownloadHostname(hostname)) throw new Error(`${path} hostname is not approved`);
  if (!parsed.pathname || parsed.pathname === "/") throw new Error(`${path} must contain a non-root report path`);
  if (/%(?:2e|2f|5c)/iu.test(parsed.pathname)) {
    throw new Error(`${path} has an ambiguous encoded path segment`);
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error(`${path} has invalid path encoding`);
  }
  if (decodedPath.includes("\\") || decodedPath.includes("\u0000")
    || decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${path} path is not approved`);
  }
  return {
    url_sha256: walmartItemReportUtf8Sha256(rawUrl),
    hostname,
    path_sha256: walmartItemReportUtf8Sha256(parsed.pathname),
    https: true,
    query_present: parsed.search.length > 1,
    no_credentials: true,
    no_fragment: true,
    default_port: true,
    host_policy_approved: true,
    path_policy_approved: true,
  };
}

function parseDownloadUrlDescriptor(
  value: unknown,
  path: string,
  exactUrl: string | null,
): DownloadUrlDescriptor {
  const raw = asRecord(value, path);
  assertExactKeys(raw, [
    "url_sha256", "hostname", "path_sha256", "https", "query_present", "no_credentials",
    "no_fragment", "default_port", "host_policy_approved", "path_policy_approved",
  ], path);
  const descriptor: DownloadUrlDescriptor = {
    url_sha256: sha256String(raw.url_sha256, `${path}.url_sha256`),
    hostname: exactString(raw.hostname, `${path}.hostname`).toLowerCase(),
    path_sha256: sha256String(raw.path_sha256, `${path}.path_sha256`),
    https: raw.https === true ? true : (() => { throw new Error(`${path}.https must be true`); })(),
    query_present: typeof raw.query_present === "boolean"
      ? raw.query_present
      : (() => { throw new Error(`${path}.query_present must be boolean`); })(),
    no_credentials: raw.no_credentials === true
      ? true
      : (() => { throw new Error(`${path}.no_credentials must be true`); })(),
    no_fragment: raw.no_fragment === true
      ? true
      : (() => { throw new Error(`${path}.no_fragment must be true`); })(),
    default_port: raw.default_port === true
      ? true
      : (() => { throw new Error(`${path}.default_port must be true`); })(),
    host_policy_approved: raw.host_policy_approved === true
      ? true
      : (() => { throw new Error(`${path}.host_policy_approved must be true`); })(),
    path_policy_approved: raw.path_policy_approved === true
      ? true
      : (() => { throw new Error(`${path}.path_policy_approved must be true`); })(),
  };
  if (raw.hostname !== descriptor.hostname || !approvedDownloadHostname(descriptor.hostname)) {
    throw new Error(`${path}.hostname is not an approved canonical hostname`);
  }
  if (exactUrl !== null) {
    const expected = approvedDownloadUrlDescriptor(exactUrl, `${path} locator URL`);
    if (canonicalWalmartItemReportJson(descriptor) !== canonicalWalmartItemReportJson(expected)) {
      throw new Error(`${path} does not exactly describe the locator URL`);
    }
  }
  return descriptor;
}

/**
 * Exact non-secret descriptor the trusted capture adapter must build before
 * issuing the POST with the selected seller credentials. Credential material is
 * intentionally absent; the account fingerprint is the scope authority root.
 */
export function buildWalmartItemReportV6CreateRequestManifest(
  binding: WalmartItemReportRequestManifestBinding,
) {
  return {
    schema_version: WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
    method: "POST",
    endpoint: "/v3/reports/reportRequests",
    query: { reportType: REPORT_TYPE, reportVersion: "v6" },
    headers: { "content-type": "application/json" },
    body: {},
    authority: manifestAuthority(binding),
  } as const;
}

export function buildWalmartItemReportReadyRequestManifest(
  requestId: string,
  binding: WalmartItemReportRequestManifestBinding,
) {
  return {
    schema_version: WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA,
    method: "GET",
    endpoint: "/v3/reports/reportRequests/{requestId}",
    path: { requestId: exactString(requestId, "READY requestId") },
    query: {},
    headers: {},
    authority: manifestAuthority(binding),
  } as const;
}

export function buildWalmartItemReportDownloadLocatorRequestManifest(
  requestId: string,
  binding: WalmartItemReportRequestManifestBinding,
) {
  return {
    schema_version: WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA,
    method: "GET",
    endpoint: "/v3/reports/downloadReport",
    query: { requestId: exactString(requestId, "download locator requestId") },
    headers: {},
    authority: manifestAuthority(binding),
  } as const;
}

export function buildWalmartItemReportFileRequestManifest(
  input: WalmartItemReportFileRequestManifestInput,
) {
  const locatorUrl = exactString(input.locator_url, "report file locator_url");
  const initial = approvedDownloadUrlDescriptor(locatorUrl, "report file locator_url");
  if (!initial.query_present) throw new Error("report file locator_url must be presigned with a query string");
  const redirects = input.redirects ?? [];
  if (!Array.isArray(redirects) || redirects.length > WALMART_ITEM_REPORT_LIMITS.max_redirects) {
    throw new Error(`report file redirects must contain at most ${WALMART_ITEM_REPORT_LIMITS.max_redirects} entries`);
  }
  let currentUrl = locatorUrl;
  const visited = new Set([initial.url_sha256]);
  const compiledRedirects = redirects.map((redirect, index) => {
    const path = `report file redirects[${index}]`;
    const raw = asRecord(redirect, path);
    assertExactKeys(raw, ["status", "from_url", "to_url"], path);
    const status = positiveInteger(raw.status, `${path}.status`);
    if (![301, 302, 303, 307, 308].includes(status)) throw new Error(`${path}.status is not an HTTP redirect`);
    const fromUrl = exactString(raw.from_url, `${path}.from_url`);
    if (fromUrl !== currentUrl) throw new Error(`${path}.from_url does not continue the exact redirect chain`);
    const toUrl = exactString(raw.to_url, `${path}.to_url`);
    const to = approvedDownloadUrlDescriptor(toUrl, `${path}.to_url`);
    if (visited.has(to.url_sha256)) throw new Error(`${path}.to_url creates a redirect loop`);
    visited.add(to.url_sha256);
    currentUrl = toUrl;
    return { status, from_url_sha256: walmartItemReportUtf8Sha256(fromUrl), to };
  });
  return {
    schema_version: WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA,
    method: "GET",
    headers: {},
    url_policy_id: WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID,
    authority: manifestAuthority({
      account_scope: input.account_scope,
      request_correlation_id_sha256: input.request_correlation_id_sha256,
    }),
    initial,
    redirects: compiledRedirects,
    final: approvedDownloadUrlDescriptor(currentUrl, "report file final URL"),
  } as const;
}

function parseCreateRequestManifest(
  requestBytes: Uint8Array,
  context: WalmartItemReportCompileContext,
): void {
  const manifest = parseJsonBytes(requestBytes, "capture.create_request_manifest_bytes");
  assertExactKeys(manifest, [
    "schema_version", "method", "endpoint", "query", "headers", "body", "authority",
  ], "create request manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA) {
    throw new Error("create request manifest.schema_version is invalid");
  }
  if (manifest.method !== "POST" || manifest.endpoint !== "/v3/reports/reportRequests") {
    throw new Error("create request manifest must bind POST /v3/reports/reportRequests");
  }
  const query = asRecord(manifest.query, "create request manifest.query");
  assertExactKeys(query, ["reportType", "reportVersion"], "create request manifest.query");
  if (query.reportType !== REPORT_TYPE || query.reportVersion !== "v6") {
    throw new Error("create request manifest must bind unfiltered ITEM reportVersion v6");
  }
  const headers = asRecord(manifest.headers, "create request manifest.headers");
  assertExactKeys(headers, ["content-type"], "create request manifest.headers");
  if (headers["content-type"] !== "application/json") {
    throw new Error("create request manifest must bind content-type application/json");
  }
  assertExactKeys(asRecord(manifest.body, "create request manifest.body"), [], "create request manifest.body");
  assertManifestAuthority(
    manifest.authority,
    context,
    context.request_correlations.create_sha256,
    "create request manifest.authority",
  );
}

function parseReadyRequestManifest(
  requestBytes: Uint8Array,
  requestId: string,
  context: WalmartItemReportCompileContext,
): void {
  const manifest = parseJsonBytes(requestBytes, "capture.ready_status_request_manifest_bytes");
  assertExactKeys(manifest, [
    "schema_version", "method", "endpoint", "path", "query", "headers", "authority",
  ], "READY request manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA
    || manifest.method !== "GET" || manifest.endpoint !== "/v3/reports/reportRequests/{requestId}") {
    throw new Error("READY request manifest must bind GET /v3/reports/reportRequests/{requestId}");
  }
  const requestPath = asRecord(manifest.path, "READY request manifest.path");
  assertExactKeys(requestPath, ["requestId"], "READY request manifest.path");
  if (requestPath.requestId !== requestId) throw new Error("READY request manifest path requestId does not exactly match create response");
  assertExactKeys(asRecord(manifest.query, "READY request manifest.query"), [], "READY request manifest.query");
  assertExactKeys(asRecord(manifest.headers, "READY request manifest.headers"), [], "READY request manifest.headers");
  assertManifestAuthority(
    manifest.authority,
    context,
    context.request_correlations.ready_status_sha256,
    "READY request manifest.authority",
  );
}

function parseDownloadLocatorRequestManifest(
  requestBytes: Uint8Array,
  requestId: string,
  context: WalmartItemReportCompileContext,
): void {
  const manifest = parseJsonBytes(requestBytes, "capture.download_locator_request_manifest_bytes");
  assertExactKeys(manifest, [
    "schema_version", "method", "endpoint", "query", "headers", "authority",
  ], "download locator request manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA
    || manifest.method !== "GET" || manifest.endpoint !== "/v3/reports/downloadReport") {
    throw new Error("download locator request manifest must bind GET /v3/reports/downloadReport");
  }
  const query = asRecord(manifest.query, "download locator request manifest.query");
  assertExactKeys(query, ["requestId"], "download locator request manifest.query");
  if (query.requestId !== requestId) {
    throw new Error("download locator request manifest requestId does not exactly match create response");
  }
  assertExactKeys(asRecord(manifest.headers, "download locator request manifest.headers"), [], "download locator request manifest.headers");
  assertManifestAuthority(
    manifest.authority,
    context,
    context.request_correlations.download_locator_sha256,
    "download locator request manifest.authority",
  );
}

function parseReportFileRequestManifest(
  requestBytes: Uint8Array,
  locatorUrl: string,
  context: WalmartItemReportCompileContext,
): { initial: DownloadUrlDescriptor; final: DownloadUrlDescriptor; redirectChainSha256: string; redirectCount: number } {
  const manifest = parseJsonBytes(requestBytes, "capture.report_file_request_manifest_bytes");
  assertExactKeys(manifest, [
    "schema_version", "method", "headers", "url_policy_id", "authority", "initial", "redirects", "final",
  ], "report file request manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA
    || manifest.method !== "GET" || manifest.url_policy_id !== WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID) {
    throw new Error("report file request manifest has invalid method, schema, or URL policy");
  }
  assertExactKeys(asRecord(manifest.headers, "report file request manifest.headers"), [], "report file request manifest.headers");
  assertManifestAuthority(
    manifest.authority,
    context,
    context.request_correlations.report_file_sha256,
    "report file request manifest.authority",
  );
  const initial = parseDownloadUrlDescriptor(manifest.initial, "report file request manifest.initial", locatorUrl);
  if (!initial.query_present) throw new Error("report file request manifest initial URL must be presigned");
  if (!Array.isArray(manifest.redirects)
    || manifest.redirects.length > WALMART_ITEM_REPORT_LIMITS.max_redirects) {
    throw new Error("report file request manifest.redirects exceeds safety cap or is not an array");
  }
  let priorUrlSha = initial.url_sha256;
  const visited = new Set([priorUrlSha]);
  for (let index = 0; index < manifest.redirects.length; index += 1) {
    const path = `report file request manifest.redirects[${index}]`;
    const redirect = asRecord(manifest.redirects[index], path);
    assertExactKeys(redirect, ["status", "from_url_sha256", "to"], path);
    const status = positiveInteger(redirect.status, `${path}.status`);
    if (![301, 302, 303, 307, 308].includes(status)) throw new Error(`${path}.status is not an HTTP redirect`);
    if (sha256String(redirect.from_url_sha256, `${path}.from_url_sha256`) !== priorUrlSha) {
      throw new Error(`${path}.from_url_sha256 breaks the redirect chain`);
    }
    const to = parseDownloadUrlDescriptor(redirect.to, `${path}.to`, null);
    if (visited.has(to.url_sha256)) throw new Error(`${path}.to creates a redirect loop`);
    visited.add(to.url_sha256);
    priorUrlSha = to.url_sha256;
  }
  const final = parseDownloadUrlDescriptor(manifest.final, "report file request manifest.final", null);
  if (final.url_sha256 !== priorUrlSha) throw new Error("report file request manifest.final breaks the redirect chain");
  return {
    initial,
    final,
    redirectChainSha256: walmartItemReportSha256(manifest.redirects),
    redirectCount: manifest.redirects.length,
  };
}

function validateAdvertisedReportBinding(payload: JsonRecord, nested: JsonRecord | null, path: string): void {
  const reportTypes = advertisedStrings(
    [payload.reportType, nested?.reportType],
    `${path} reportType`,
  ).map((value) => value.trim().toUpperCase());
  if (new Set(reportTypes).size > 1 || reportTypes.some((value) => value !== REPORT_TYPE)) {
    throw new Error(`${path} has conflicting or non-ITEM reportType`);
  }
  const reportVersions = advertisedStrings(
    [payload.reportVersion, nested?.reportVersion],
    `${path} reportVersion`,
  ).map((value) => value.trim().toLowerCase());
  if (new Set(reportVersions).size > 1 || reportVersions.some((value) => value !== "v6")) {
    throw new Error(`${path} has conflicting or non-v6 reportVersion`);
  }
}

function parseCreateResponse(createResponseBytes: Uint8Array): { requestId: string; requestedAt: string } {
  const payload = parseJsonBytes(createResponseBytes, "capture.create_response_payload_bytes");
  const nested = isRecord(payload.reportRequest) ? payload.reportRequest : null;
  const requestIds = advertisedStrings(
    [payload.requestId, payload.requestID, nested?.requestId, nested?.requestID],
    "create response request ID",
  );
  if (requestIds.length === 0 || new Set(requestIds).size !== 1) {
    throw new Error("create response must contain one unambiguous request ID");
  }
  const requestedAt = advertisedTimestamp([
    payload.requestSubmissionDate,
    payload.createdTime,
    nested?.requestSubmissionDate,
    nested?.createdTime,
  ], "create response requestSubmissionDate|createdTime", true);
  validateAdvertisedReportBinding(payload, nested, "create response");
  return {
    requestId: exactString(requestIds[0], "create response.requestId"),
    requestedAt: requestedAt as string,
  };
}

function parseReadyStatus(
  statusBytes: Uint8Array,
  requestId: string,
  requestedAt: string,
  readyAt: string,
): { requestSubmissionAt: string | null; reportGenerationAt: string | null } {
  const payload = parseJsonBytes(statusBytes, "capture.ready_status_payload_bytes");
  const nested = isRecord(payload.reportRequest) ? payload.reportRequest : null;
  const statuses = advertisedStrings(
    [payload.requestStatus, payload.status, nested?.requestStatus, nested?.status],
    "request status",
  ).map((value) => value.trim().toUpperCase());
  if (statuses.length === 0 || new Set(statuses).size !== 1 || statuses[0] !== "READY") {
    throw new Error("READY status payload must contain one unambiguous READY request status");
  }
  const requestIds = advertisedStrings(
    [payload.requestId, payload.requestID, nested?.requestId, nested?.requestID],
    "request ID",
  );
  if (requestIds.length === 0 || requestIds.some((value) => value !== requestId)) {
    throw new Error("READY status payload request ID does not exactly match create response request ID");
  }
  const reportTypes = advertisedStrings(
    [payload.reportType, nested?.reportType],
    "reportType",
  ).map((value) => value.trim().toUpperCase());
  if (reportTypes.length === 0 || new Set(reportTypes).size !== 1 || reportTypes[0] !== REPORT_TYPE) {
    throw new Error(`READY status payload must bind reportType=${REPORT_TYPE}`);
  }
  const reportVersions = advertisedStrings(
    [payload.reportVersion, nested?.reportVersion],
    "reportVersion",
  ).map((value) => value.trim().toLowerCase());
  if (reportVersions.length === 0 || new Set(reportVersions).size !== 1 || reportVersions[0] !== "v6") {
    throw new Error("READY status payload must bind reportVersion=v6");
  }
  const requestSubmissionAt = advertisedTimestamp([
    payload.requestSubmissionDate,
    payload.createdTime,
    nested?.requestSubmissionDate,
    nested?.createdTime,
  ], "READY requestSubmissionDate|createdTime", false);
  if (requestSubmissionAt !== null && !sameInstant(requestSubmissionAt, requestedAt)) {
    throw new Error("READY requestSubmissionDate|createdTime conflicts with create response");
  }
  const reportGenerationAt = advertisedTimestamp([
    payload.reportGenerationDate,
    nested?.reportGenerationDate,
  ], "READY reportGenerationDate", false);
  if (reportGenerationAt !== null
    && (Date.parse(reportGenerationAt) < Date.parse(requestedAt)
      || Date.parse(reportGenerationAt) > Date.parse(readyAt))) {
    throw new Error("READY reportGenerationDate must be between request submission and READY observation");
  }
  return { requestSubmissionAt, reportGenerationAt };
}

function parseDownloadLocatorResponse(
  responseBytes: Uint8Array,
  requestId: string,
  requestedAt: string,
  readyAt: string,
  readyGenerationAt: string | null,
): {
  downloadUrl: string;
  expirationAt: string;
  requestSubmissionAt: string | null;
  reportGenerationAt: string | null;
} {
  const payload = parseJsonBytes(responseBytes, "capture.download_locator_response_payload_bytes");
  const nested = isRecord(payload.reportRequest) ? payload.reportRequest : null;
  const urls = advertisedStrings([
    payload.downloadURL,
    payload.downloadUrl,
    nested?.downloadURL,
    nested?.downloadUrl,
  ], "download locator downloadURL");
  if (urls.length === 0 || new Set(urls).size !== 1) {
    throw new Error("download locator response must contain one unambiguous downloadURL");
  }
  const downloadUrl = exactString(urls[0], "download locator response.downloadURL");
  approvedDownloadUrlDescriptor(downloadUrl, "download locator response.downloadURL");
  const expirationAt = advertisedTimestamp([
    payload.downloadURLExpirationTime,
    payload.downloadUrlExpirationTime,
    nested?.downloadURLExpirationTime,
    nested?.downloadUrlExpirationTime,
  ], "download locator downloadURLExpirationTime", true) as string;
  const requestIds = advertisedStrings([
    payload.requestId,
    payload.requestID,
    nested?.requestId,
    nested?.requestID,
  ], "download locator request ID");
  if (requestIds.length > 0 && requestIds.some((value) => value !== requestId)) {
    throw new Error("download locator response request ID does not exactly match create response request ID");
  }
  validateAdvertisedReportBinding(payload, nested, "download locator response");
  const requestSubmissionAt = advertisedTimestamp([
    payload.requestSubmissionDate,
    payload.createdTime,
    nested?.requestSubmissionDate,
    nested?.createdTime,
  ], "download locator requestSubmissionDate|createdTime", false);
  if (requestSubmissionAt !== null && !sameInstant(requestSubmissionAt, requestedAt)) {
    throw new Error("download locator requestSubmissionDate|createdTime conflicts with create response");
  }
  const reportGenerationAt = advertisedTimestamp([
    payload.reportGenerationDate,
    nested?.reportGenerationDate,
  ], "download locator reportGenerationDate", false);
  if (reportGenerationAt !== null
    && (Date.parse(reportGenerationAt) < Date.parse(requestedAt)
      || Date.parse(reportGenerationAt) > Date.parse(readyAt))) {
    throw new Error("download locator reportGenerationDate must be between request submission and READY observation");
  }
  if (reportGenerationAt !== null && readyGenerationAt !== null
    && !sameInstant(reportGenerationAt, readyGenerationAt)) {
    throw new Error("download locator reportGenerationDate conflicts with READY reportGenerationDate");
  }
  return { downloadUrl, expirationAt, requestSubmissionAt, reportGenerationAt };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractSingleZipMember(bytes: Uint8Array): { name: string; bytes: Uint8Array } {
  const buffer = Buffer.from(bytes);
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) throw new Error("ZIP transport has no valid end-of-central-directory record");
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== 1 || totalEntries !== 1) {
    throw new Error("ZIP transport must contain exactly one member on one disk");
  }
  if (eocd + 22 + commentLength !== buffer.length) throw new Error("ZIP transport has trailing or truncated bytes");
  if (centralOffset + centralSize !== eocd || centralOffset + 46 > buffer.length) {
    throw new Error("ZIP transport central directory bounds are invalid");
  }
  if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("ZIP transport central directory entry is invalid");
  const flags = buffer.readUInt16LE(centralOffset + 8);
  const method = buffer.readUInt16LE(centralOffset + 10);
  const expectedCrc = buffer.readUInt32LE(centralOffset + 16);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
  const nameLength = buffer.readUInt16LE(centralOffset + 28);
  const extraLength = buffer.readUInt16LE(centralOffset + 30);
  const memberCommentLength = buffer.readUInt16LE(centralOffset + 32);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  if ((flags & 0x1) !== 0) throw new Error("ZIP transport member must not be encrypted");
  if (method !== 0 && method !== 8) throw new Error(`ZIP transport compression method ${method} is unsupported`);
  if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) throw new Error("ZIP64 transport is unsupported");
  if (uncompressedSize > WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes) {
    throw new Error("ZIP transport declared uncompressed size exceeds decoded-report safety cap");
  }
  if (uncompressedSize > Math.max(1, compressedSize) * WALMART_ITEM_REPORT_LIMITS.max_compression_ratio) {
    throw new Error("ZIP transport declared compression ratio exceeds safety cap");
  }
  if (centralOffset + 46 + nameLength + extraLength + memberCommentLength !== eocd) {
    throw new Error("ZIP transport central directory entry length is invalid");
  }
  const nameBytes = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength);
  const { text: name } = decodeUtf8(nameBytes, "ZIP member name", false);
  if (!name || name.endsWith("/") || name.includes("\u0000")) throw new Error("ZIP transport member name is invalid");
  if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("ZIP transport local header is invalid");
  }
  const localFlags = buffer.readUInt16LE(localOffset + 6);
  const localMethod = buffer.readUInt16LE(localOffset + 8);
  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  if (localFlags !== flags || localMethod !== method) throw new Error("ZIP transport local/central metadata conflict");
  const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
  if (!localName.equals(nameBytes)) throw new Error("ZIP transport local/central member names conflict");
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataStart > centralOffset || dataEnd > centralOffset) throw new Error("ZIP transport member bounds are invalid");
  const compressed = buffer.subarray(dataStart, dataEnd);
  let decoded: Buffer;
  try {
    decoded = method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes });
  } catch {
    throw new Error("ZIP transport member decompression failed");
  }
  if (decoded.byteLength !== uncompressedSize) throw new Error("ZIP transport uncompressed size mismatch");
  if (crc32(decoded) !== expectedCrc) throw new Error("ZIP transport member CRC32 mismatch");
  return { name, bytes: new Uint8Array(decoded) };
}

function decodeTransport(transportBytes: Uint8Array): DecodedTransport {
  const validateDecoded = (decoded: Uint8Array, container: DownloadContainer): Uint8Array => {
    if (decoded.byteLength > WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes) {
      throw new Error("decoded ITEM report exceeds decoded-report safety cap");
    }
    if (container !== "plain"
      && decoded.byteLength > Math.max(1, transportBytes.byteLength) * WALMART_ITEM_REPORT_LIMITS.max_compression_ratio) {
      throw new Error("ITEM report compression ratio exceeds safety cap");
    }
    return decoded;
  };
  if (transportBytes[0] === 0x1f && transportBytes[1] === 0x8b) {
    try {
      const decoded = new Uint8Array(gunzipSync(transportBytes, {
        maxOutputLength: WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes,
      }));
      return { container: "gzip", memberName: null, reportBytes: validateDecoded(decoded, "gzip") };
    } catch {
      throw new Error("gzip report transport decompression failed");
    }
  }
  if (transportBytes[0] === 0x50 && transportBytes[1] === 0x4b
    && (transportBytes[2] === 0x03 || transportBytes[2] === 0x05 || transportBytes[2] === 0x07)
    && (transportBytes[3] === 0x04 || transportBytes[3] === 0x06 || transportBytes[3] === 0x08)) {
    const member = extractSingleZipMember(transportBytes);
    return { container: "zip", memberName: member.name, reportBytes: validateDecoded(member.bytes, "zip") };
  }
  return {
    container: "plain",
    memberName: null,
    reportBytes: validateDecoded(new Uint8Array(transportBytes), "plain"),
  };
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function resolveHeaderRole(
  normalized: string[],
  role: RequiredHeaderRole | OptionalHeaderRole,
  aliases: readonly string[],
  required: boolean,
): number | null {
  const accepted = new Set(aliases.map(normalizeHeader));
  const matches = normalized
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => accepted.has(name))
    .map(({ index }) => index);
  if (matches.length > 1) throw new Error(`ITEM report header has ambiguous ${role} columns at indexes ${matches.join(", ")}`);
  if (required && matches.length === 0) throw new Error(`ITEM report header is missing required ${role} column`);
  return matches[0] ?? null;
}

function findHeaderMapping(header: string[], reportVersion: SupportedReportVersion): HeaderMapping {
  const normalized = header.map(normalizeHeader);
  return {
    sku: resolveHeaderRole(normalized, "sku", REQUIRED_HEADER_ALIASES.sku, true) as number,
    product_name: resolveHeaderRole(normalized, "product_name", REQUIRED_HEADER_ALIASES.product_name, true) as number,
    product_id: resolveHeaderRole(normalized, "product_id", REQUIRED_HEADER_ALIASES.product_id, true) as number,
    product_id_type: resolveHeaderRole(
      normalized,
      "product_id_type",
      REQUIRED_HEADER_ALIASES.product_id_type,
      true,
    ) as number,
    published_status: resolveHeaderRole(
      normalized,
      "published_status",
      REQUIRED_HEADER_ALIASES.published_status,
      true,
    ) as number,
    lifecycle_status: resolveHeaderRole(
      normalized,
      "lifecycle_status",
      OPTIONAL_HEADER_ALIASES.lifecycle_status,
      false,
    ),
    product_condition: resolveHeaderRole(
      normalized,
      "product_condition",
      OPTIONAL_HEADER_ALIASES.product_condition,
      reportVersion === "v6",
    ),
    legacy_item_id: resolveHeaderRole(
      normalized,
      "legacy_item_id",
      OPTIONAL_HEADER_ALIASES.legacy_item_id,
      false,
    ),
    legacy_wpid: resolveHeaderRole(normalized, "legacy_wpid", OPTIONAL_HEADER_ALIASES.legacy_wpid, false),
  };
}

function firstLogicalRecord(text: string): string {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (char === "\n" || char === "\r")) return text.slice(0, index);
  }
  if (quoted) throw new Error("ITEM report header has an unterminated quoted field");
  return text;
}

function countUnquoted(recordText: string, needle: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < recordText.length; index += 1) {
    const char = recordText[index];
    if (char === '"') {
      if (quoted && recordText[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === needle) count += 1;
  }
  if (quoted) throw new Error("ITEM report header has an unterminated quoted field");
  return count;
}

function detectDelimiter(text: string): Delimiter {
  const header = firstLogicalRecord(text);
  const commas = countUnquoted(header, ",");
  const tabs = countUnquoted(header, "\t");
  if (commas > 0 && tabs > 0) throw new Error("ITEM report header mixes comma and tab delimiters");
  if (commas === 0 && tabs === 0) throw new Error("ITEM report delimiter cannot be determined from the header");
  return tabs > 0 ? "\t" : ",";
}

function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      crlf += 1;
      index += 1;
    } else if (text[index] === "\n") lf += 1;
    else if (text[index] === "\r") throw new Error("ITEM report contains a bare carriage return");
  }
  if (crlf && lf) return "MIXED";
  if (crlf) return "CRLF";
  if (lf) return "LF";
  return "NONE";
}

function parseDelimitedRecords(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterClosingQuote = false;
  const appendField = (value: string): void => {
    if (field.length + value.length > WALMART_ITEM_REPORT_LIMITS.max_field_characters) {
      throw new Error("ITEM report field exceeds field-length safety cap");
    }
    field += value;
  };
  const pushField = (): void => {
    if (row.length >= WALMART_ITEM_REPORT_LIMITS.max_columns) {
      throw new Error("ITEM report record exceeds column-count safety cap");
    }
    row.push(field);
    field = "";
  };
  const pushRecord = (): void => {
    pushField();
    if (rows.length >= WALMART_ITEM_REPORT_LIMITS.max_logical_records) {
      throw new Error("ITEM report exceeds logical-record safety cap");
    }
    rows.push(row);
    row = [];
    afterClosingQuote = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          appendField('"');
          index += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else appendField(char);
      continue;
    }
    if (afterClosingQuote) {
      if (char === delimiter) {
        pushField();
        afterClosingQuote = false;
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        pushRecord();
      } else throw new Error(`ITEM report has data after a closing quote at character ${index + 1}`);
    } else if (char === '"') {
      if (field.length) throw new Error(`ITEM report has a quote inside an unquoted field at character ${index + 1}`);
      inQuotes = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRecord();
    } else appendField(char);
  }
  if (inQuotes) throw new Error("ITEM report has an unterminated quoted field");
  if (field.length || row.length || afterClosingQuote) pushRecord();
  return rows;
}

function parseReport(reportBytes: Uint8Array, reportVersion: SupportedReportVersion): ParsedReport {
  const { text, bom } = decodeUtf8(reportBytes, "decoded ITEM report", true);
  if (!text.length) throw new Error("decoded ITEM report is empty");
  if (text.includes("\u0000")) throw new Error("decoded ITEM report contains NUL bytes");
  const lineEnding = detectLineEnding(text);
  const delimiter = detectDelimiter(text);
  const parsed = parseDelimitedRecords(text, delimiter);
  if (parsed.length < 2) throw new Error("ITEM report must contain a header and at least one data record");
  const header = parsed[0];
  if (header.some((name) => name.length === 0)) throw new Error("ITEM report header contains an empty column name");
  for (let index = 0; index < header.length; index += 1) {
    exactString(header[index], `ITEM report header[${index}]`);
  }
  const normalized = header.map(normalizeHeader);
  const duplicate = normalized.find((name, index) => normalized.indexOf(name) !== index);
  if (duplicate) throw new Error(`ITEM report has duplicate normalized header: ${duplicate}`);
  const headerMapping = findHeaderMapping(header, reportVersion);
  const records = parsed.slice(1).map((cells, index) => {
    const sourceRecordNumber = index + 2;
    if (cells.every((cell) => cell === "")) throw new Error(`ITEM report record ${sourceRecordNumber} is blank`);
    if (cells.length !== header.length) {
      throw new Error(`ITEM report record ${sourceRecordNumber} has ${cells.length} cells; expected ${header.length}`);
    }
    return { sourceRecordNumber, cells };
  });
  return {
    delimiter,
    mediaType: delimiter === "," ? "text/csv" : "text/tab-separated-values",
    utf8Bom: bom,
    lineEnding,
    header,
    headerMapping,
    records,
  };
}

function normalizeStatus(value: string, path: string): string {
  if (!value.length) throw new Error(`${path} must be non-empty`);
  if (value !== value.trim()) throw new Error(`${path} must already be trimmed`);
  if (!/^[A-Za-z _-]+$/u.test(value)) throw new Error(`${path} has unsupported characters`);
  return value.toUpperCase().replace(/[ -]+/gu, "_");
}

function parsePublishedStatus(value: string, path: string): PublishedStatus {
  const normalized = normalizeStatus(value, path);
  if (!(PUBLISHED_STATUSES as readonly string[]).includes(normalized)) {
    throw new Error(`${path} has unsupported published status: ${value}`);
  }
  return normalized as PublishedStatus;
}

function parseLifecycleStatus(value: string, path: string): LifecycleStatus {
  const normalized = normalizeStatus(value, path);
  if (!(LIFECYCLE_STATUSES as readonly string[]).includes(normalized)) {
    throw new Error(`${path} has unsupported lifecycle status: ${value}`);
  }
  return normalized as LifecycleStatus;
}

function parseOptionalLifecycleStatus(value: string, path: string): LifecycleStatus | null {
  if (value.trim().length === 0) return null;
  return parseLifecycleStatus(value, path);
}

function fixedStatusSemantics(): WalmartItemReportPublishedSourceBody["status_semantics"] {
  return {
    policy_id: WALMART_ITEM_REPORT_STATUS_POLICY,
    accepted_published_statuses: [...PUBLISHED_STATUSES],
    accepted_lifecycle_statuses: [...LIFECYCLE_STATUSES],
    inclusion_rule: { published_status: "PUBLISHED", lifecycle_filter: "NONE" },
    lifecycle_status_role: "OPTIONAL_EVIDENCE_ONLY",
  };
}

function optionalExactCell(
  record: string[],
  index: number | null,
  path: string,
): string | null {
  if (index === null) return null;
  return exactString(record[index], path);
}

function compileBody(
  capture: ParsedCapture,
  context: WalmartItemReportCompileContext,
): WalmartItemReportPublishedSourceBody {
  assertTrustedExchangeBinding(
    capture.createRequestBytes,
    context.request_correlations.create_sha256,
    capture.createResponseBytes,
    capture.createResponseHttp,
    context.trusted_exchange_seals.create_response_sha256,
    "create response",
  );
  assertTrustedExchangeBinding(
    capture.readyRequestBytes,
    context.request_correlations.ready_status_sha256,
    capture.statusBytes,
    capture.readyStatusHttp,
    context.trusted_exchange_seals.ready_status_response_sha256,
    "READY status response",
  );
  assertTrustedExchangeBinding(
    capture.downloadLocatorRequestBytes,
    context.request_correlations.download_locator_sha256,
    capture.downloadLocatorResponseBytes,
    capture.downloadLocatorHttp,
    context.trusted_exchange_seals.download_locator_response_sha256,
    "download locator response",
  );
  assertTrustedExchangeBinding(
    capture.reportFileRequestBytes,
    context.request_correlations.report_file_sha256,
    capture.transportBytes,
    capture.downloadHttp,
    context.trusted_exchange_seals.download_response_sha256,
    "download response",
  );
  parseCreateRequestManifest(capture.createRequestBytes, context);
  const createResponse = parseCreateResponse(capture.createResponseBytes);
  if (Date.parse(createResponse.requestedAt) > Date.parse(context.ready_at)) {
    throw new Error("context.ready_at must be at or after create response requestSubmissionDate");
  }
  assertHttpEchoBindings(
    capture.createResponseHttp,
    context.request_correlations.create_sha256,
    createResponse.requestId,
    "capture.http.create_response",
  );
  parseReadyRequestManifest(capture.readyRequestBytes, createResponse.requestId, context);
  const readyEvidence = parseReadyStatus(
    capture.statusBytes,
    createResponse.requestId,
    createResponse.requestedAt,
    context.ready_at,
  );
  assertHttpEchoBindings(
    capture.readyStatusHttp,
    context.request_correlations.ready_status_sha256,
    createResponse.requestId,
    "capture.http.ready_status_response",
  );
  parseDownloadLocatorRequestManifest(capture.downloadLocatorRequestBytes, createResponse.requestId, context);
  const locator = parseDownloadLocatorResponse(
    capture.downloadLocatorResponseBytes,
    createResponse.requestId,
    createResponse.requestedAt,
    context.ready_at,
    readyEvidence.reportGenerationAt,
  );
  if (Date.parse(locator.expirationAt) < Date.parse(context.downloaded_at)) {
    throw new Error("downloadURLExpirationTime must cover the observed report download time");
  }
  assertHttpEchoBindings(
    capture.downloadLocatorHttp,
    context.request_correlations.download_locator_sha256,
    createResponse.requestId,
    "capture.http.download_locator_response",
  );
  const fileRequest = parseReportFileRequestManifest(capture.reportFileRequestBytes, locator.downloadUrl, context);
  assertHttpEchoBindings(
    capture.downloadHttp,
    context.request_correlations.report_file_sha256,
    createResponse.requestId,
    "capture.http.download_response",
  );
  const decoded = decodeTransport(capture.transportBytes);
  if (decoded.reportBytes.byteLength === 0) throw new Error("decoded ITEM report bytes are empty");
  const parsed = parseReport(decoded.reportBytes, "v6");
  const publishedCounts = new Map<PublishedStatus, number>(PUBLISHED_STATUSES.map((status) => [status, 0]));
  const lifecycleCounts = new Map<LifecycleStatus, number>(LIFECYCLE_STATUSES.map((status) => [status, 0]));
  let lifecycleNotReportedCount = 0;
  const rows: WalmartPublishedListingRow[] = [];
  const seenReportListings = new Map<string, { sourceRecordNumber: number; cells: string[] }>();

  for (const reportRecord of parsed.records) {
    const recordPath = `ITEM report record ${reportRecord.sourceRecordNumber}`;
    const sku = exactString(reportRecord.cells[parsed.headerMapping.sku], `${recordPath}.sku`);
    const listingKey = walmartListingKey(context.account_scope.store_index, sku);
    const priorReportRecord = seenReportListings.get(listingKey);
    if (priorReportRecord) {
      const duplicate = canonicalWalmartItemReportJson(priorReportRecord.cells)
        === canonicalWalmartItemReportJson(reportRecord.cells);
      throw new Error(
        `${recordPath} ${duplicate ? "duplicates" : "conflicts with"} listing_key ${listingKey} `
        + `(first seen at record ${priorReportRecord.sourceRecordNumber})`,
      );
    }
    seenReportListings.set(listingKey, {
      sourceRecordNumber: reportRecord.sourceRecordNumber,
      cells: [...reportRecord.cells],
    });
    const published = parsePublishedStatus(
      reportRecord.cells[parsed.headerMapping.published_status],
      `${recordPath}.published_status`,
    );
    const lifecycle = parsed.headerMapping.lifecycle_status === null
      ? null
      : parseOptionalLifecycleStatus(
        reportRecord.cells[parsed.headerMapping.lifecycle_status],
        `${recordPath}.lifecycle_status`,
      );
    publishedCounts.set(published, (publishedCounts.get(published) ?? 0) + 1);
    if (lifecycle === null) lifecycleNotReportedCount += 1;
    else lifecycleCounts.set(lifecycle, (lifecycleCounts.get(lifecycle) ?? 0) + 1);
    if (published !== "PUBLISHED") continue;

    const productIdentifier = exactString(
      reportRecord.cells[parsed.headerMapping.product_id],
      `${recordPath}.product_id`,
    );
    const productIdentifierType = exactString(
      reportRecord.cells[parsed.headerMapping.product_id_type],
      `${recordPath}.product_id_type`,
    );
    const productName = exactText(
      reportRecord.cells[parsed.headerMapping.product_name],
      `${recordPath}.product_name`,
    );
    const productCondition = optionalExactCell(
      reportRecord.cells,
      parsed.headerMapping.product_condition,
      `${recordPath}.product_condition`,
    );
    const legacyItemId = optionalExactCell(
      reportRecord.cells,
      parsed.headerMapping.legacy_item_id,
      `${recordPath}.legacy_item_id`,
    );
    const legacyWpid = optionalExactCell(
      reportRecord.cells,
      parsed.headerMapping.legacy_wpid,
      `${recordPath}.legacy_wpid`,
    );
    const compiled: WalmartPublishedListingRow = {
      channel: CHANNEL,
      store_index: context.account_scope.store_index,
      sku,
      listing_key: listingKey,
      reported_product_identifier_opaque: productIdentifier,
      reported_product_identifier_type_opaque: productIdentifierType,
      reported_product_identifier_header: parsed.header[parsed.headerMapping.product_id],
      reported_product_identifier_type_header: parsed.header[parsed.headerMapping.product_id_type],
      reported_product_name: productName,
      reported_product_name_header: parsed.header[parsed.headerMapping.product_name],
      reported_product_condition: productCondition,
      reported_product_condition_header: parsed.headerMapping.product_condition === null
        ? null
        : parsed.header[parsed.headerMapping.product_condition],
      reported_lifecycle_status: lifecycle,
      reported_lifecycle_status_header: parsed.headerMapping.lifecycle_status === null
        ? null
        : parsed.header[parsed.headerMapping.lifecycle_status],
      reported_legacy_item_identifier_opaque: legacyItemId,
      reported_legacy_item_identifier_header: parsed.headerMapping.legacy_item_id === null
        ? null
        : parsed.header[parsed.headerMapping.legacy_item_id],
      reported_legacy_wpid_opaque: legacyWpid,
      reported_legacy_wpid_header: parsed.headerMapping.legacy_wpid === null
        ? null
        : parsed.header[parsed.headerMapping.legacy_wpid],
      published_status: "PUBLISHED",
      source_record_number: reportRecord.sourceRecordNumber,
      source_record_sha256: walmartItemReportSha256(reportRecord.cells),
    };
    rows.push(compiled);
  }

  rows.sort((left, right) => compareCodeUnits(left.listing_key, right.listing_key));
  const includedCount = rows.length;
  const dataCount = parsed.records.length;
  return {
    schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
    account_scope: structuredClone(context.account_scope),
    report: {
      source_system: "walmart_marketplace_api",
      report_type: REPORT_TYPE,
      report_version: "v6",
      report_request_id: createResponse.requestId,
      requested_at: createResponse.requestedAt,
      cutoff_at: context.ready_at,
      cutoff_basis: "READY_OBSERVED_UPPER_BOUND",
      ready_at: context.ready_at,
      download_locator_at: context.download_locator_at,
      report_file_requested_at: context.report_file_requested_at,
      downloaded_at: context.downloaded_at,
      create_request: {
        manifest_schema_version: WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
        manifest_sha256: sha256Bytes(capture.createRequestBytes),
        manifest_byte_length: capture.createRequestBytes.byteLength,
        method: "POST",
        endpoint: "/v3/reports/reportRequests",
        report_type: REPORT_TYPE,
        report_version: "v6",
        content_type: "application/json",
        body_empty_object: true,
        unfiltered_full_report: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.create_sha256,
      },
      create_response: {
        payload_sha256: sha256Bytes(capture.createResponseBytes),
        payload_byte_length: capture.createResponseBytes.byteLength,
        http_status: capture.createResponseHttp.status,
        http_content_type: capture.createResponseHttp.contentType,
        http_content_length: capture.createResponseHttp.contentLength,
        request_id_exact_match: true,
        request_submission_date_exact_match: true,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.create_response_sha256,
        echoed_correlation_id_sha256: capture.createResponseHttp.echoedCorrelationIdSha256,
        echoed_report_request_id_sha256: capture.createResponseHttp.echoedReportRequestIdSha256,
      },
      authority_evidence: {
        request_manifest_schema_version: WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA,
        request_manifest_sha256: sha256Bytes(capture.readyRequestBytes),
        request_manifest_byte_length: capture.readyRequestBytes.byteLength,
        method: "GET",
        endpoint: "/v3/reports/reportRequests/{requestId}",
        request_id_path_exact_match: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.ready_status_sha256,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.ready_status_response_sha256,
        ready_status_payload_sha256: sha256Bytes(capture.statusBytes),
        ready_status_payload_byte_length: capture.statusBytes.byteLength,
        request_status: "READY",
        request_id_exact_match: true,
        report_type_exact_match: true,
        report_version_exact_match: true,
        http_status: capture.readyStatusHttp.status,
        http_content_type: capture.readyStatusHttp.contentType,
        http_content_length: capture.readyStatusHttp.contentLength,
        echoed_correlation_id_sha256: capture.readyStatusHttp.echoedCorrelationIdSha256,
        echoed_report_request_id_sha256: capture.readyStatusHttp.echoedReportRequestIdSha256,
      },
      download_locator: {
        request_manifest_schema_version: WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA,
        request_manifest_sha256: sha256Bytes(capture.downloadLocatorRequestBytes),
        request_manifest_byte_length: capture.downloadLocatorRequestBytes.byteLength,
        method: "GET",
        endpoint: "/v3/reports/downloadReport",
        request_id_exact_match: true,
        unfiltered_locator_request: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.download_locator_sha256,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.download_locator_response_sha256,
        response_payload_sha256: sha256Bytes(capture.downloadLocatorResponseBytes),
        response_payload_byte_length: capture.downloadLocatorResponseBytes.byteLength,
        http_status: capture.downloadLocatorHttp.status,
        http_content_type: capture.downloadLocatorHttp.contentType,
        http_content_length: capture.downloadLocatorHttp.contentLength,
        download_url_sha256: fileRequest.initial.url_sha256,
        download_url_expiration_at: locator.expirationAt,
        echoed_correlation_id_sha256: capture.downloadLocatorHttp.echoedCorrelationIdSha256,
        echoed_report_request_id_sha256: capture.downloadLocatorHttp.echoedReportRequestIdSha256,
      },
      report_file_request: {
        manifest_schema_version: WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA,
        manifest_sha256: sha256Bytes(capture.reportFileRequestBytes),
        manifest_byte_length: capture.reportFileRequestBytes.byteLength,
        method: "GET",
        url_policy_id: WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID,
        initial_url_sha256: fileRequest.initial.url_sha256,
        final_url_sha256: fileRequest.final.url_sha256,
        redirect_chain_sha256: fileRequest.redirectChainSha256,
        redirect_count: fileRequest.redirectCount,
        all_urls_policy_approved: true,
        locator_url_exact_match: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.report_file_sha256,
      },
      download_transport: {
        bytes_sha256: sha256Bytes(capture.transportBytes),
        byte_length: capture.transportBytes.byteLength,
        http_content_type: capture.downloadHttp.contentType,
        http_content_length: capture.downloadHttp.contentLength,
        http_status: capture.downloadHttp.status,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.download_response_sha256,
        echoed_correlation_id_sha256: capture.downloadHttp.echoedCorrelationIdSha256,
        echoed_report_request_id_sha256: capture.downloadHttp.echoedReportRequestIdSha256,
        detected_container: decoded.container,
        decoded_member_name: decoded.memberName,
      },
      decoded_report: {
        bytes_sha256: sha256Bytes(decoded.reportBytes),
        byte_length: decoded.reportBytes.byteLength,
        text_encoding: TEXT_ENCODING,
        utf8_bom: parsed.utf8Bom,
        delimiter: parsed.delimiter,
        media_type: parsed.mediaType,
        line_ending: parsed.lineEnding,
        header: [...parsed.header],
        header_sha256: walmartItemReportSha256(parsed.header),
        header_mapping: { ...parsed.headerMapping },
        logical_record_count: dataCount + 1,
        data_record_count: dataCount,
      },
    },
    status_semantics: fixedStatusSemantics(),
    reconciliation: {
      parsed_data_record_count: dataCount,
      included_published_count: includedCount,
      excluded_non_published_count: dataCount - includedCount,
      unique_published_listing_count: includedCount,
      output_row_count: includedCount,
      malformed_record_count: 0,
      duplicate_listing_key_count: 0,
      conflicting_listing_key_count: 0,
      published_status_counts: PUBLISHED_STATUSES.map((status) => ({
        status,
        count: publishedCounts.get(status) ?? 0,
      })),
      lifecycle_status_counts: LIFECYCLE_STATUSES.map((status) => ({
        status,
        count: lifecycleCounts.get(status) ?? 0,
      })),
      lifecycle_status_not_reported_count: lifecycleNotReportedCount,
    },
    published_population_complete: true,
    rows,
  };
}

/**
 * Compile the exact attested request/response chain. The trusted context is
 * mandatory and must come from the atomic capture adapter; no caller-authored
 * completeness override exists.
 */
export function compileWalmartItemReportPublishedSource(
  captureInput: unknown,
  contextInput: unknown,
): SealedWalmartItemReportPublishedSource {
  const capture = parseCapture(captureInput);
  const context = parseContext(contextInput);
  const body = compileBody(capture, context);
  const bodySha = walmartItemReportSha256(body);
  const source: SealedWalmartItemReportPublishedSource = {
    ...body,
    source_id: `walmart-item-report-published-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
  verifyWalmartItemReportPublishedSource(source);
  return source;
}

function parseCountArray<T extends string>(
  input: unknown,
  expectedStatuses: readonly T[],
  path: string,
): Array<StatusCount<T>> {
  if (!Array.isArray(input) || input.length !== expectedStatuses.length) {
    throw new Error(`${path} must contain exactly ${expectedStatuses.length} rows`);
  }
  return input.map((item, index) => {
    const row = asRecord(item, `${path}[${index}]`);
    assertExactKeys(row, ["status", "count"], `${path}[${index}]`);
    if (row.status !== expectedStatuses[index]) throw new Error(`${path}[${index}].status must be ${expectedStatuses[index]}`);
    return { status: expectedStatuses[index], count: nonNegativeInteger(row.count, `${path}[${index}].count`) };
  });
}

function parseHeaderMapping(
  input: unknown,
  header: string[],
  reportVersion: SupportedReportVersion,
  path: string,
): HeaderMapping {
  const raw = asRecord(input, path);
  const requiredRoles = Object.keys(REQUIRED_HEADER_ALIASES) as RequiredHeaderRole[];
  const optionalRoles = Object.keys(OPTIONAL_HEADER_ALIASES) as OptionalHeaderRole[];
  assertExactKeys(raw, [...requiredRoles, ...optionalRoles], path);
  const mapping = {} as HeaderMapping;
  const used: number[] = [];
  for (const role of requiredRoles) {
    const index = nonNegativeInteger(raw[role], `${path}.${role}`);
    if (index >= header.length) throw new Error(`${path}.${role} is outside the header`);
    const accepted = new Set(REQUIRED_HEADER_ALIASES[role].map(normalizeHeader));
    if (!accepted.has(normalizeHeader(header[index]))) throw new Error(`${path}.${role} does not point at an accepted header`);
    mapping[role] = index;
    used.push(index);
  }
  for (const role of optionalRoles) {
    const value = raw[role];
    if (value === null) {
      mapping[role] = null;
      continue;
    }
    const index = nonNegativeInteger(value, `${path}.${role}`);
    if (index >= header.length) throw new Error(`${path}.${role} is outside the header`);
    const accepted = new Set(OPTIONAL_HEADER_ALIASES[role].map(normalizeHeader));
    if (!accepted.has(normalizeHeader(header[index]))) throw new Error(`${path}.${role} does not point at an accepted header`);
    mapping[role] = index;
    used.push(index);
  }
  if (new Set(used).size !== used.length) throw new Error(`${path} roles must point at distinct columns`);
  if (reportVersion === "v6" && mapping.product_condition === null) {
    throw new Error(`${path}.product_condition is required for reportVersion v6`);
  }
  return mapping;
}

function parsePublishedRow(
  input: unknown,
  index: number,
  accountScope: WalmartItemReportCompileContext["account_scope"],
  header: string[],
  mapping: HeaderMapping,
): WalmartPublishedListingRow {
  const path = `source.rows[${index}]`;
  const raw = asRecord(input, path);
  assertExactKeys(raw, [
    "channel",
    "store_index",
    "sku",
    "listing_key",
    "reported_product_identifier_opaque",
    "reported_product_identifier_type_opaque",
    "reported_product_identifier_header",
    "reported_product_identifier_type_header",
    "reported_product_name",
    "reported_product_name_header",
    "reported_product_condition",
    "reported_product_condition_header",
    "reported_lifecycle_status",
    "reported_lifecycle_status_header",
    "reported_legacy_item_identifier_opaque",
    "reported_legacy_item_identifier_header",
    "reported_legacy_wpid_opaque",
    "reported_legacy_wpid_header",
    "published_status",
    "source_record_number",
    "source_record_sha256",
  ], path);
  if (raw.channel !== CHANNEL || raw.channel !== accountScope.channel) throw new Error(`${path}.channel must match account scope`);
  const storeIndex = positiveInteger(raw.store_index, `${path}.store_index`);
  if (storeIndex !== accountScope.store_index) throw new Error(`${path}.store_index must match account scope`);
  const sku = exactString(raw.sku, `${path}.sku`);
  const expectedKey = walmartListingKey(storeIndex, sku);
  if (raw.listing_key !== expectedKey) throw new Error(`${path}.listing_key must be ${expectedKey}`);
  if (raw.published_status !== "PUBLISHED") throw new Error(`${path}.published_status must be PUBLISHED`);

  const productIdentifier = exactString(
    raw.reported_product_identifier_opaque,
    `${path}.reported_product_identifier_opaque`,
  );
  const productIdentifierType = exactString(
    raw.reported_product_identifier_type_opaque,
    `${path}.reported_product_identifier_type_opaque`,
  );
  const productIdentifierHeader = exactString(
    raw.reported_product_identifier_header,
    `${path}.reported_product_identifier_header`,
  );
  const productIdentifierTypeHeader = exactString(
    raw.reported_product_identifier_type_header,
    `${path}.reported_product_identifier_type_header`,
  );
  const productName = exactText(raw.reported_product_name, `${path}.reported_product_name`);
  const productNameHeader = exactString(raw.reported_product_name_header, `${path}.reported_product_name_header`);
  if (productIdentifierHeader !== header[mapping.product_id]
    || productIdentifierTypeHeader !== header[mapping.product_id_type]
    || productNameHeader !== header[mapping.product_name]) {
    throw new Error(`${path} documented product evidence headers do not match decoded header mapping`);
  }

  const parseOptionalPair = (
    value: unknown,
    headerValue: unknown,
    mappingIndex: number | null,
    rolePath: string,
    allowNullWithPresentHeader = false,
  ): { value: string | null; header: string | null } => {
    const parsedValue = value === null ? null : exactString(value, `${path}.${rolePath}`);
    const parsedHeader = nullableHeaderString(headerValue, `${path}.${rolePath}_header`);
    const expectedHeader = mappingIndex === null ? null : header[mappingIndex];
    if (parsedHeader !== expectedHeader
      || (!allowNullWithPresentHeader && (parsedValue === null) !== (parsedHeader === null))
      || (allowNullWithPresentHeader && parsedHeader === null && parsedValue !== null)) {
      throw new Error(`${path}.${rolePath} evidence/header does not match decoded header mapping`);
    }
    return { value: parsedValue, header: parsedHeader };
  };
  const condition = parseOptionalPair(
    raw.reported_product_condition,
    raw.reported_product_condition_header,
    mapping.product_condition,
    "reported_product_condition",
  );
  const lifecyclePair = parseOptionalPair(
    raw.reported_lifecycle_status,
    raw.reported_lifecycle_status_header,
    mapping.lifecycle_status,
    "reported_lifecycle_status",
    true,
  );
  const lifecycle = lifecyclePair.value === null
    ? null
    : parseLifecycleStatus(lifecyclePair.value, `${path}.reported_lifecycle_status`);
  const legacyItem = parseOptionalPair(
    raw.reported_legacy_item_identifier_opaque,
    raw.reported_legacy_item_identifier_header,
    mapping.legacy_item_id,
    "reported_legacy_item_identifier_opaque",
  );
  const legacyWpid = parseOptionalPair(
    raw.reported_legacy_wpid_opaque,
    raw.reported_legacy_wpid_header,
    mapping.legacy_wpid,
    "reported_legacy_wpid_opaque",
  );
  return {
    channel: CHANNEL,
    store_index: storeIndex,
    sku,
    listing_key: expectedKey,
    reported_product_identifier_opaque: productIdentifier,
    reported_product_identifier_type_opaque: productIdentifierType,
    reported_product_identifier_header: productIdentifierHeader,
    reported_product_identifier_type_header: productIdentifierTypeHeader,
    reported_product_name: productName,
    reported_product_name_header: productNameHeader,
    reported_product_condition: condition.value,
    reported_product_condition_header: condition.header,
    reported_lifecycle_status: lifecycle,
    reported_lifecycle_status_header: lifecyclePair.header,
    reported_legacy_item_identifier_opaque: legacyItem.value,
    reported_legacy_item_identifier_header: legacyItem.header,
    reported_legacy_wpid_opaque: legacyWpid.value,
    reported_legacy_wpid_header: legacyWpid.header,
    published_status: "PUBLISHED",
    source_record_number: positiveInteger(raw.source_record_number, `${path}.source_record_number`),
    source_record_sha256: sha256String(raw.source_record_sha256, `${path}.source_record_sha256`),
  };
}

/** Strict envelope/invariant verifier. It does not authenticate detached bytes. */
export function verifyWalmartItemReportPublishedSource(
  input: unknown,
): SealedWalmartItemReportPublishedSource {
  const raw = asRecord(input, "source");
  assertExactKeys(raw, [
    "schema_version",
    "account_scope",
    "report",
    "status_semantics",
    "reconciliation",
    "published_population_complete",
    "rows",
    "source_id",
    "body_sha256",
  ], "source");
  if (raw.schema_version !== WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA) {
    throw new Error(`source.schema_version must be ${WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA}`);
  }
  if (raw.published_population_complete !== true) {
    throw new Error("source.published_population_complete must be compiler-derived true");
  }

  const scope = asRecord(raw.account_scope, "source.account_scope");
  assertExactKeys(scope, ["channel", "store_index", "seller_account_fingerprint_sha256"], "source.account_scope");
  if (scope.channel !== CHANNEL) throw new Error(`source.account_scope.channel must be ${CHANNEL}`);
  const accountScope: WalmartItemReportCompileContext["account_scope"] = {
    channel: CHANNEL,
    store_index: positiveInteger(scope.store_index, "source.account_scope.store_index"),
    seller_account_fingerprint_sha256: sha256String(
      scope.seller_account_fingerprint_sha256,
      "source.account_scope.seller_account_fingerprint_sha256",
    ),
  };

  const report = asRecord(raw.report, "source.report");
  assertExactKeys(report, [
    "source_system", "report_type", "report_version", "report_request_id",
    "requested_at", "cutoff_at", "cutoff_basis", "ready_at", "download_locator_at",
    "report_file_requested_at", "downloaded_at", "create_request", "create_response",
    "authority_evidence", "download_locator", "report_file_request", "download_transport", "decoded_report",
  ], "source.report");
  if (report.source_system !== "walmart_marketplace_api") throw new Error("source.report.source_system is invalid");
  if (report.report_type !== REPORT_TYPE) throw new Error(`source.report.report_type must be ${REPORT_TYPE}`);
  if (report.report_version !== "v6") throw new Error("source.report.report_version must be v6 for complete population");
  const requestId = exactString(report.report_request_id, "source.report.report_request_id");
  const requestedAt = isoTimestamp(report.requested_at, "source.report.requested_at");
  const createRequest = asRecord(report.create_request, "source.report.create_request");
  const createResponse = asRecord(report.create_response, "source.report.create_response");
  const authority = asRecord(report.authority_evidence, "source.report.authority_evidence");
  const downloadLocator = asRecord(report.download_locator, "source.report.download_locator");
  const reportFileRequest = asRecord(report.report_file_request, "source.report.report_file_request");
  const transport = asRecord(report.download_transport, "source.report.download_transport");
  const context = parseContext({
    account_scope: accountScope,
    request_correlations: {
      create_sha256: createRequest.request_correlation_id_sha256,
      ready_status_sha256: authority.request_correlation_id_sha256,
      download_locator_sha256: downloadLocator.request_correlation_id_sha256,
      report_file_sha256: reportFileRequest.request_correlation_id_sha256,
    },
    trusted_exchange_seals: {
      create_response_sha256: createResponse.trusted_exchange_sha256,
      ready_status_response_sha256: authority.trusted_exchange_sha256,
      download_locator_response_sha256: downloadLocator.trusted_exchange_sha256,
      download_response_sha256: transport.trusted_exchange_sha256,
    },
    ready_at: report.ready_at,
    download_locator_at: report.download_locator_at,
    report_file_requested_at: report.report_file_requested_at,
    downloaded_at: report.downloaded_at,
  });
  if (Date.parse(requestedAt) > Date.parse(context.ready_at)) {
    throw new Error("source.report.ready_at must be at or after requested_at");
  }
  const cutoffAt = isoTimestamp(report.cutoff_at, "source.report.cutoff_at");
  if (cutoffAt !== context.ready_at || report.cutoff_basis !== "READY_OBSERVED_UPPER_BOUND") {
    throw new Error("source.report cutoff must be the conservative READY-observed upper bound");
  }

  assertExactKeys(createRequest, [
    "manifest_schema_version", "manifest_sha256", "manifest_byte_length", "method", "endpoint", "report_type",
    "report_version", "content_type", "body_empty_object", "unfiltered_full_report",
    "account_scope_exact_match", "request_correlation_id_sha256",
  ], "source.report.create_request");
  const createRequestSha = sha256String(createRequest.manifest_sha256, "source.report.create_request.manifest_sha256");
  const createRequestLength = positiveInteger(
    createRequest.manifest_byte_length,
    "source.report.create_request.manifest_byte_length",
  );
  if (createRequestLength > WALMART_ITEM_REPORT_LIMITS.max_create_request_bytes) {
    throw new Error("source.report.create_request exceeds request safety cap");
  }
  if (createRequest.manifest_schema_version !== WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA
    || createRequest.method !== "POST" || createRequest.endpoint !== "/v3/reports/reportRequests"
    || createRequest.report_type !== REPORT_TYPE || createRequest.report_version !== "v6"
    || createRequest.content_type !== "application/json" || createRequest.body_empty_object !== true
    || createRequest.unfiltered_full_report !== true || createRequest.account_scope_exact_match !== true
    || createRequest.request_correlation_id_sha256 !== context.request_correlations.create_sha256) {
    throw new Error("source.report.create_request must bind the full unfiltered ITEM v6 request");
  }

  assertExactKeys(createResponse, [
    "payload_sha256", "payload_byte_length", "http_status", "http_content_type",
    "http_content_length", "request_id_exact_match", "request_submission_date_exact_match",
    "trusted_exchange_policy_id", "trusted_exchange_sha256",
    "echoed_correlation_id_sha256", "echoed_report_request_id_sha256",
  ], "source.report.create_response");
  const createResponseSha = sha256String(createResponse.payload_sha256, "source.report.create_response.payload_sha256");
  const createResponseLength = positiveInteger(
    createResponse.payload_byte_length,
    "source.report.create_response.payload_byte_length",
  );
  if (createResponseLength > WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes) {
    throw new Error("source.report.create_response exceeds response safety cap");
  }
  const createResponseStatus = positiveInteger(createResponse.http_status, "source.report.create_response.http_status");
  if (createResponseStatus !== 200 && createResponseStatus !== 201) {
    throw new Error("source.report.create_response.http_status must be 200 or 201");
  }
  const createResponseContentType = createResponse.http_content_type === null
    ? null
    : exactString(createResponse.http_content_type, "source.report.create_response.http_content_type");
  const createResponseContentLength = nullableNonNegativeInteger(
    createResponse.http_content_length,
    "source.report.create_response.http_content_length",
  );
  if (createResponseContentLength !== null && createResponseContentLength !== createResponseLength) {
    throw new Error("source.report.create_response HTTP/payload lengths do not match");
  }
  if (createResponse.request_id_exact_match !== true
    || createResponse.request_submission_date_exact_match !== true) {
    throw new Error("source.report.create_response must bind request ID and submission date");
  }
  if (createResponse.trusted_exchange_policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID
    || createResponse.trusted_exchange_sha256 !== context.trusted_exchange_seals.create_response_sha256) {
    throw new Error("source.report.create_response must bind the trusted atomic exchange seal");
  }
  const createResponseEchoCorrelation = nullableSha256String(
    createResponse.echoed_correlation_id_sha256,
    "source.report.create_response.echoed_correlation_id_sha256",
  );
  const createResponseEchoRequestId = nullableSha256String(
    createResponse.echoed_report_request_id_sha256,
    "source.report.create_response.echoed_report_request_id_sha256",
  );
  if (createResponseEchoCorrelation !== null
    && createResponseEchoCorrelation !== context.request_correlations.create_sha256) {
    throw new Error("source.report.create_response echoed correlation conflicts with request manifest");
  }
  if (createResponseEchoRequestId !== null
    && createResponseEchoRequestId !== walmartItemReportUtf8Sha256(requestId)) {
    throw new Error("source.report.create_response echoed report request ID conflicts with payload");
  }

  assertExactKeys(authority, [
    "request_manifest_schema_version", "request_manifest_sha256", "request_manifest_byte_length",
    "method", "endpoint", "request_id_path_exact_match", "account_scope_exact_match",
    "request_correlation_id_sha256", "trusted_exchange_policy_id", "trusted_exchange_sha256",
    "ready_status_payload_sha256", "ready_status_payload_byte_length",
    "request_status", "request_id_exact_match", "report_type_exact_match",
    "report_version_exact_match", "http_status", "http_content_type", "http_content_length",
    "echoed_correlation_id_sha256", "echoed_report_request_id_sha256",
  ], "source.report.authority_evidence");
  const readyRequestManifestSha = sha256String(
    authority.request_manifest_sha256,
    "source.report.authority_evidence.request_manifest_sha256",
  );
  const readyRequestManifestLength = positiveInteger(
    authority.request_manifest_byte_length,
    "source.report.authority_evidence.request_manifest_byte_length",
  );
  if (readyRequestManifestLength > WALMART_ITEM_REPORT_LIMITS.max_ready_request_bytes) {
    throw new Error("source.report.authority_evidence READY request manifest exceeds safety cap");
  }
  if (authority.request_manifest_schema_version !== WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA
    || authority.method !== "GET" || authority.endpoint !== "/v3/reports/reportRequests/{requestId}"
    || authority.request_id_path_exact_match !== true || authority.account_scope_exact_match !== true
    || authority.request_correlation_id_sha256 !== context.request_correlations.ready_status_sha256) {
    throw new Error("source.report.authority_evidence must bind the exact scoped READY status GET");
  }
  if (authority.trusted_exchange_policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID
    || authority.trusted_exchange_sha256 !== context.trusted_exchange_seals.ready_status_response_sha256) {
    throw new Error("source.report.authority_evidence must bind the trusted atomic exchange seal");
  }
  const readyStatusSha = sha256String(
    authority.ready_status_payload_sha256,
    "source.report.authority_evidence.ready_status_payload_sha256",
  );
  const readyStatusLength = positiveInteger(
    authority.ready_status_payload_byte_length,
    "source.report.authority_evidence.ready_status_payload_byte_length",
  );
  if (readyStatusLength > WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes) {
    throw new Error("source.report.authority_evidence exceeds status safety cap");
  }
  if (authority.request_status !== "READY" || authority.request_id_exact_match !== true
    || authority.report_type_exact_match !== true || authority.report_version_exact_match !== true) {
    throw new Error("source.report.authority_evidence must bind exact READY/request/report evidence");
  }
  const readyHttpStatus = positiveInteger(authority.http_status, "source.report.authority_evidence.http_status");
  if (readyHttpStatus !== 200) throw new Error("source.report.authority_evidence.http_status must be 200");
  const readyHttpContentType = authority.http_content_type === null
    ? null
    : exactString(authority.http_content_type, "source.report.authority_evidence.http_content_type");
  const readyHttpContentLength = nullableNonNegativeInteger(
    authority.http_content_length,
    "source.report.authority_evidence.http_content_length",
  );
  if (readyHttpContentLength !== null && readyHttpContentLength !== readyStatusLength) {
    throw new Error("source.report.authority_evidence HTTP/payload lengths do not match");
  }
  const readyEchoCorrelation = nullableSha256String(
    authority.echoed_correlation_id_sha256,
    "source.report.authority_evidence.echoed_correlation_id_sha256",
  );
  const readyEchoRequestId = nullableSha256String(
    authority.echoed_report_request_id_sha256,
    "source.report.authority_evidence.echoed_report_request_id_sha256",
  );
  if (readyEchoCorrelation !== null
    && readyEchoCorrelation !== context.request_correlations.ready_status_sha256) {
    throw new Error("source.report.authority_evidence echoed correlation conflicts with READY request manifest");
  }
  if (readyEchoRequestId !== null && readyEchoRequestId !== walmartItemReportUtf8Sha256(requestId)) {
    throw new Error("source.report.authority_evidence echoed report request ID conflicts with payload");
  }

  assertExactKeys(downloadLocator, [
    "request_manifest_schema_version", "request_manifest_sha256", "request_manifest_byte_length",
    "method", "endpoint", "request_id_exact_match", "unfiltered_locator_request",
    "account_scope_exact_match", "request_correlation_id_sha256", "trusted_exchange_policy_id",
    "trusted_exchange_sha256", "response_payload_sha256",
    "response_payload_byte_length", "http_status", "http_content_type", "http_content_length",
    "download_url_sha256", "download_url_expiration_at", "echoed_correlation_id_sha256",
    "echoed_report_request_id_sha256",
  ], "source.report.download_locator");
  const locatorRequestManifestSha = sha256String(
    downloadLocator.request_manifest_sha256,
    "source.report.download_locator.request_manifest_sha256",
  );
  const locatorRequestManifestLength = positiveInteger(
    downloadLocator.request_manifest_byte_length,
    "source.report.download_locator.request_manifest_byte_length",
  );
  if (locatorRequestManifestLength > WALMART_ITEM_REPORT_LIMITS.max_download_locator_request_bytes) {
    throw new Error("source.report.download_locator request manifest exceeds safety cap");
  }
  if (downloadLocator.request_manifest_schema_version
      !== WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA
    || downloadLocator.method !== "GET" || downloadLocator.endpoint !== "/v3/reports/downloadReport"
    || downloadLocator.request_id_exact_match !== true || downloadLocator.unfiltered_locator_request !== true
    || downloadLocator.account_scope_exact_match !== true
    || downloadLocator.request_correlation_id_sha256 !== context.request_correlations.download_locator_sha256) {
    throw new Error("source.report.download_locator must bind the exact scoped unfiltered locator GET");
  }
  if (downloadLocator.trusted_exchange_policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID
    || downloadLocator.trusted_exchange_sha256
      !== context.trusted_exchange_seals.download_locator_response_sha256) {
    throw new Error("source.report.download_locator must bind the trusted atomic exchange seal");
  }
  const locatorResponseSha = sha256String(
    downloadLocator.response_payload_sha256,
    "source.report.download_locator.response_payload_sha256",
  );
  const locatorResponseLength = positiveInteger(
    downloadLocator.response_payload_byte_length,
    "source.report.download_locator.response_payload_byte_length",
  );
  if (locatorResponseLength > WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes) {
    throw new Error("source.report.download_locator response exceeds safety cap");
  }
  const locatorHttpStatus = positiveInteger(downloadLocator.http_status, "source.report.download_locator.http_status");
  if (locatorHttpStatus !== 200) throw new Error("source.report.download_locator.http_status must be 200");
  const locatorHttpContentType = downloadLocator.http_content_type === null
    ? null
    : exactString(downloadLocator.http_content_type, "source.report.download_locator.http_content_type");
  const locatorHttpContentLength = nullableNonNegativeInteger(
    downloadLocator.http_content_length,
    "source.report.download_locator.http_content_length",
  );
  if (locatorHttpContentLength !== null && locatorHttpContentLength !== locatorResponseLength) {
    throw new Error("source.report.download_locator HTTP/payload lengths do not match");
  }
  const locatorUrlSha = sha256String(
    downloadLocator.download_url_sha256,
    "source.report.download_locator.download_url_sha256",
  );
  const locatorExpirationAt = isoTimestamp(
    downloadLocator.download_url_expiration_at,
    "source.report.download_locator.download_url_expiration_at",
  );
  if (Date.parse(locatorExpirationAt) < Date.parse(context.downloaded_at)) {
    throw new Error("source.report.download_locator URL expiration must cover downloaded_at");
  }
  const locatorEchoCorrelation = nullableSha256String(
    downloadLocator.echoed_correlation_id_sha256,
    "source.report.download_locator.echoed_correlation_id_sha256",
  );
  const locatorEchoRequestId = nullableSha256String(
    downloadLocator.echoed_report_request_id_sha256,
    "source.report.download_locator.echoed_report_request_id_sha256",
  );
  if (locatorEchoCorrelation !== null
    && locatorEchoCorrelation !== context.request_correlations.download_locator_sha256) {
    throw new Error("source.report.download_locator echoed correlation conflicts with request manifest");
  }
  if (locatorEchoRequestId !== null && locatorEchoRequestId !== walmartItemReportUtf8Sha256(requestId)) {
    throw new Error("source.report.download_locator echoed report request ID conflicts with payload");
  }

  assertExactKeys(reportFileRequest, [
    "manifest_schema_version", "manifest_sha256", "manifest_byte_length", "method", "url_policy_id",
    "initial_url_sha256", "final_url_sha256", "redirect_chain_sha256", "redirect_count",
    "all_urls_policy_approved", "locator_url_exact_match", "account_scope_exact_match",
    "request_correlation_id_sha256",
  ], "source.report.report_file_request");
  const fileRequestManifestSha = sha256String(
    reportFileRequest.manifest_sha256,
    "source.report.report_file_request.manifest_sha256",
  );
  const fileRequestManifestLength = positiveInteger(
    reportFileRequest.manifest_byte_length,
    "source.report.report_file_request.manifest_byte_length",
  );
  if (fileRequestManifestLength > WALMART_ITEM_REPORT_LIMITS.max_report_file_request_bytes) {
    throw new Error("source.report.report_file_request manifest exceeds safety cap");
  }
  const fileInitialUrlSha = sha256String(
    reportFileRequest.initial_url_sha256,
    "source.report.report_file_request.initial_url_sha256",
  );
  const fileFinalUrlSha = sha256String(
    reportFileRequest.final_url_sha256,
    "source.report.report_file_request.final_url_sha256",
  );
  const redirectChainSha = sha256String(
    reportFileRequest.redirect_chain_sha256,
    "source.report.report_file_request.redirect_chain_sha256",
  );
  const redirectCount = nonNegativeInteger(
    reportFileRequest.redirect_count,
    "source.report.report_file_request.redirect_count",
  );
  if (redirectCount > WALMART_ITEM_REPORT_LIMITS.max_redirects) {
    throw new Error("source.report.report_file_request redirect_count exceeds safety cap");
  }
  if (reportFileRequest.manifest_schema_version !== WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA
    || reportFileRequest.method !== "GET"
    || reportFileRequest.url_policy_id !== WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID
    || reportFileRequest.all_urls_policy_approved !== true || reportFileRequest.locator_url_exact_match !== true
    || reportFileRequest.account_scope_exact_match !== true
    || reportFileRequest.request_correlation_id_sha256 !== context.request_correlations.report_file_sha256
    || fileInitialUrlSha !== locatorUrlSha) {
    throw new Error("source.report.report_file_request must bind the exact scoped approved locator URL chain");
  }

  assertExactKeys(transport, [
    "bytes_sha256", "byte_length", "http_content_type", "http_content_length",
    "http_status", "trusted_exchange_policy_id", "trusted_exchange_sha256",
    "echoed_correlation_id_sha256", "echoed_report_request_id_sha256",
    "detected_container", "decoded_member_name",
  ], "source.report.download_transport");
  const transportSha = sha256String(transport.bytes_sha256, "source.report.download_transport.bytes_sha256");
  const transportLength = positiveInteger(transport.byte_length, "source.report.download_transport.byte_length");
  if (transportLength > WALMART_ITEM_REPORT_LIMITS.max_transport_bytes) {
    throw new Error("source.report.download_transport exceeds transport safety cap");
  }
  const httpContentType = transport.http_content_type === null
    ? null
    : exactString(transport.http_content_type, "source.report.download_transport.http_content_type");
  const httpContentLength = nullableNonNegativeInteger(
    transport.http_content_length,
    "source.report.download_transport.http_content_length",
  );
  if (httpContentLength !== null && httpContentLength !== transportLength) {
    throw new Error("source.report.download_transport HTTP/observed lengths do not match");
  }
  const downloadHttpStatus = positiveInteger(transport.http_status, "source.report.download_transport.http_status");
  if (downloadHttpStatus !== 200) throw new Error("source.report.download_transport.http_status must be 200");
  if (transport.trusted_exchange_policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID
    || transport.trusted_exchange_sha256 !== context.trusted_exchange_seals.download_response_sha256) {
    throw new Error("source.report.download_transport must bind the trusted atomic exchange seal");
  }
  const downloadEchoCorrelation = nullableSha256String(
    transport.echoed_correlation_id_sha256,
    "source.report.download_transport.echoed_correlation_id_sha256",
  );
  const downloadEchoRequestId = nullableSha256String(
    transport.echoed_report_request_id_sha256,
    "source.report.download_transport.echoed_report_request_id_sha256",
  );
  if (downloadEchoCorrelation !== null
    && downloadEchoCorrelation !== context.request_correlations.report_file_sha256) {
    throw new Error("source.report.download_transport echoed correlation conflicts with file request manifest");
  }
  if (downloadEchoRequestId !== null && downloadEchoRequestId !== walmartItemReportUtf8Sha256(requestId)) {
    throw new Error("source.report.download_transport echoed report request ID conflicts with payload");
  }
  if (!(transport.detected_container === "plain" || transport.detected_container === "gzip"
    || transport.detected_container === "zip")) {
    throw new Error("source.report.download_transport.detected_container is invalid");
  }
  const memberName = transport.decoded_member_name === null
    ? null
    : exactText(transport.decoded_member_name, "source.report.download_transport.decoded_member_name");
  if ((transport.detected_container === "zip") !== (memberName !== null)) {
    throw new Error("source.report.download_transport ZIP/member metadata is inconsistent");
  }

  const decoded = asRecord(report.decoded_report, "source.report.decoded_report");
  assertExactKeys(decoded, [
    "bytes_sha256", "byte_length", "text_encoding", "utf8_bom", "delimiter",
    "media_type", "line_ending", "header", "header_sha256", "header_mapping",
    "logical_record_count", "data_record_count",
  ], "source.report.decoded_report");
  const decodedSha = sha256String(decoded.bytes_sha256, "source.report.decoded_report.bytes_sha256");
  const decodedLength = positiveInteger(decoded.byte_length, "source.report.decoded_report.byte_length");
  if (decodedLength > WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes) {
    throw new Error("source.report.decoded_report exceeds decoded-report safety cap");
  }
  if (transport.detected_container !== "plain"
    && decodedLength > Math.max(1, transportLength) * WALMART_ITEM_REPORT_LIMITS.max_compression_ratio) {
    throw new Error("source.report decoded/transport compression ratio exceeds safety cap");
  }
  if (transport.detected_container === "plain"
    && (decodedLength !== transportLength || decodedSha !== transportSha)) {
    throw new Error("source.report plain transport must exactly equal decoded report bytes");
  }
  if (decoded.text_encoding !== TEXT_ENCODING) throw new Error(`source.report.decoded_report.text_encoding must be ${TEXT_ENCODING}`);
  if (typeof decoded.utf8_bom !== "boolean") throw new Error("source.report.decoded_report.utf8_bom must be boolean");
  if (decoded.delimiter !== "," && decoded.delimiter !== "\t") {
    throw new Error("source.report.decoded_report.delimiter must be comma or tab");
  }
  const expectedMedia = decoded.delimiter === "," ? "text/csv" : "text/tab-separated-values";
  if (decoded.media_type !== expectedMedia) throw new Error("source.report.decoded_report.media_type does not match delimiter");
  if (!(decoded.line_ending === "LF" || decoded.line_ending === "CRLF"
    || decoded.line_ending === "MIXED" || decoded.line_ending === "NONE")) {
    throw new Error("source.report.decoded_report.line_ending is invalid");
  }
  if (!Array.isArray(decoded.header) || decoded.header.length === 0) {
    throw new Error("source.report.decoded_report.header must be a non-empty array");
  }
  if (decoded.header.length > WALMART_ITEM_REPORT_LIMITS.max_columns) {
    throw new Error("source.report.decoded_report.header exceeds column-count safety cap");
  }
  const header = decoded.header.map((value, index) => exactString(value, `source.report.decoded_report.header[${index}]`));
  const normalizedHeader = header.map(normalizeHeader);
  if (new Set(normalizedHeader).size !== header.length) throw new Error("source.report.decoded_report.header has duplicates");
  const headerSha = sha256String(decoded.header_sha256, "source.report.decoded_report.header_sha256");
  if (headerSha !== walmartItemReportSha256(header)) throw new Error("source.report.decoded_report.header_sha256 mismatch");
  const headerMapping = parseHeaderMapping(
    decoded.header_mapping,
    header,
    "v6",
    "source.report.decoded_report.header_mapping",
  );
  const logicalRecords = positiveInteger(decoded.logical_record_count, "source.report.decoded_report.logical_record_count");
  const dataRecords = positiveInteger(decoded.data_record_count, "source.report.decoded_report.data_record_count");
  if (logicalRecords > WALMART_ITEM_REPORT_LIMITS.max_logical_records) {
    throw new Error("source.report.decoded_report exceeds logical-record safety cap");
  }
  if (logicalRecords !== dataRecords + 1) throw new Error("source.report.decoded_report record counts do not reconcile");

  const semantics = asRecord(raw.status_semantics, "source.status_semantics");
  assertExactKeys(semantics, [
    "policy_id", "accepted_published_statuses", "accepted_lifecycle_statuses",
    "inclusion_rule", "lifecycle_status_role",
  ], "source.status_semantics");
  if (canonicalWalmartItemReportJson(semantics) !== canonicalWalmartItemReportJson(fixedStatusSemantics())) {
    throw new Error("source.status_semantics does not match the frozen policy");
  }

  const reconciliation = asRecord(raw.reconciliation, "source.reconciliation");
  assertExactKeys(reconciliation, [
    "parsed_data_record_count", "included_published_count", "excluded_non_published_count",
    "unique_published_listing_count", "output_row_count", "malformed_record_count",
    "duplicate_listing_key_count", "conflicting_listing_key_count", "published_status_counts",
    "lifecycle_status_counts", "lifecycle_status_not_reported_count",
  ], "source.reconciliation");
  const parsedCount = positiveInteger(reconciliation.parsed_data_record_count, "source.reconciliation.parsed_data_record_count");
  const includedCount = nonNegativeInteger(reconciliation.included_published_count, "source.reconciliation.included_published_count");
  const excludedCount = nonNegativeInteger(reconciliation.excluded_non_published_count, "source.reconciliation.excluded_non_published_count");
  const uniqueCount = nonNegativeInteger(reconciliation.unique_published_listing_count, "source.reconciliation.unique_published_listing_count");
  const outputCount = nonNegativeInteger(reconciliation.output_row_count, "source.reconciliation.output_row_count");
  for (const field of ["malformed_record_count", "duplicate_listing_key_count", "conflicting_listing_key_count"] as const) {
    if (reconciliation[field] !== 0) throw new Error(`source.reconciliation.${field} must be zero`);
  }
  const publishedStatusCounts = parseCountArray(
    reconciliation.published_status_counts,
    PUBLISHED_STATUSES,
    "source.reconciliation.published_status_counts",
  );
  const lifecycleStatusCounts = parseCountArray(
    reconciliation.lifecycle_status_counts,
    LIFECYCLE_STATUSES,
    "source.reconciliation.lifecycle_status_counts",
  );
  const lifecycleNotReportedCount = nonNegativeInteger(
    reconciliation.lifecycle_status_not_reported_count,
    "source.reconciliation.lifecycle_status_not_reported_count",
  );

  if (!Array.isArray(raw.rows)) throw new Error("source.rows must be an array");
  const rows = raw.rows.map((row, index) => parsePublishedRow(row, index, accountScope, header, headerMapping));
  const listingKeys = rows.map((row) => row.listing_key);
  const sortedListingKeys = [...listingKeys].sort(compareCodeUnits);
  if (canonicalWalmartItemReportJson(listingKeys) !== canonicalWalmartItemReportJson(sortedListingKeys)) {
    throw new Error("source.rows must be sorted by listing_key using code-unit order");
  }
  if (new Set(listingKeys).size !== rows.length) throw new Error("source.rows has duplicate listing_key values");
  if (new Set(rows.map((row) => row.source_record_number)).size !== rows.length) {
    throw new Error("source.rows has duplicate source_record_number values");
  }
  if (rows.some((row) => row.source_record_number < 2 || row.source_record_number > logicalRecords)) {
    throw new Error("source.rows references a record outside the decoded report");
  }
  const sum = <T,>(values: T[], getter: (value: T) => number): number => (
    values.reduce((total, value) => total + getter(value), 0)
  );
  if (parsedCount !== dataRecords || parsedCount !== includedCount + excludedCount) {
    throw new Error("source.reconciliation parsed/included/excluded counts do not reconcile");
  }
  if (sum(publishedStatusCounts, (item) => item.count) !== parsedCount
    || sum(lifecycleStatusCounts, (item) => item.count) + lifecycleNotReportedCount !== parsedCount) {
    throw new Error("source.reconciliation status counts do not reconcile");
  }
  if (headerMapping.lifecycle_status === null && lifecycleNotReportedCount !== parsedCount) {
    throw new Error("source.reconciliation missing lifecycle count does not match absent header");
  }
  if (includedCount !== publishedStatusCounts[0].count || includedCount !== rows.length
    || uniqueCount !== rows.length || outputCount !== rows.length) {
    throw new Error("source.reconciliation output counts do not reconcile with rows");
  }

  const parsed: SealedWalmartItemReportPublishedSource = {
    schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
    account_scope: accountScope,
    report: {
      source_system: "walmart_marketplace_api",
      report_type: REPORT_TYPE,
      report_version: "v6",
      report_request_id: requestId,
      requested_at: requestedAt,
      cutoff_at: context.ready_at,
      cutoff_basis: "READY_OBSERVED_UPPER_BOUND",
      ready_at: context.ready_at,
      download_locator_at: context.download_locator_at,
      report_file_requested_at: context.report_file_requested_at,
      downloaded_at: context.downloaded_at,
      create_request: {
        manifest_schema_version: WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
        manifest_sha256: createRequestSha,
        manifest_byte_length: createRequestLength,
        method: "POST",
        endpoint: "/v3/reports/reportRequests",
        report_type: REPORT_TYPE,
        report_version: "v6",
        content_type: "application/json",
        body_empty_object: true,
        unfiltered_full_report: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.create_sha256,
      },
      create_response: {
        payload_sha256: createResponseSha,
        payload_byte_length: createResponseLength,
        http_status: createResponseStatus,
        http_content_type: createResponseContentType,
        http_content_length: createResponseContentLength,
        request_id_exact_match: true,
        request_submission_date_exact_match: true,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.create_response_sha256,
        echoed_correlation_id_sha256: createResponseEchoCorrelation,
        echoed_report_request_id_sha256: createResponseEchoRequestId,
      },
      authority_evidence: {
        request_manifest_schema_version: WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA,
        request_manifest_sha256: readyRequestManifestSha,
        request_manifest_byte_length: readyRequestManifestLength,
        method: "GET",
        endpoint: "/v3/reports/reportRequests/{requestId}",
        request_id_path_exact_match: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.ready_status_sha256,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.ready_status_response_sha256,
        ready_status_payload_sha256: readyStatusSha,
        ready_status_payload_byte_length: readyStatusLength,
        request_status: "READY",
        request_id_exact_match: true,
        report_type_exact_match: true,
        report_version_exact_match: true,
        http_status: readyHttpStatus,
        http_content_type: readyHttpContentType,
        http_content_length: readyHttpContentLength,
        echoed_correlation_id_sha256: readyEchoCorrelation,
        echoed_report_request_id_sha256: readyEchoRequestId,
      },
      download_locator: {
        request_manifest_schema_version: WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA,
        request_manifest_sha256: locatorRequestManifestSha,
        request_manifest_byte_length: locatorRequestManifestLength,
        method: "GET",
        endpoint: "/v3/reports/downloadReport",
        request_id_exact_match: true,
        unfiltered_locator_request: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.download_locator_sha256,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.download_locator_response_sha256,
        response_payload_sha256: locatorResponseSha,
        response_payload_byte_length: locatorResponseLength,
        http_status: locatorHttpStatus,
        http_content_type: locatorHttpContentType,
        http_content_length: locatorHttpContentLength,
        download_url_sha256: locatorUrlSha,
        download_url_expiration_at: locatorExpirationAt,
        echoed_correlation_id_sha256: locatorEchoCorrelation,
        echoed_report_request_id_sha256: locatorEchoRequestId,
      },
      report_file_request: {
        manifest_schema_version: WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA,
        manifest_sha256: fileRequestManifestSha,
        manifest_byte_length: fileRequestManifestLength,
        method: "GET",
        url_policy_id: WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID,
        initial_url_sha256: fileInitialUrlSha,
        final_url_sha256: fileFinalUrlSha,
        redirect_chain_sha256: redirectChainSha,
        redirect_count: redirectCount,
        all_urls_policy_approved: true,
        locator_url_exact_match: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.report_file_sha256,
      },
      download_transport: {
        bytes_sha256: transportSha,
        byte_length: transportLength,
        http_content_type: httpContentType,
        http_content_length: httpContentLength,
        http_status: downloadHttpStatus,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.download_response_sha256,
        echoed_correlation_id_sha256: downloadEchoCorrelation,
        echoed_report_request_id_sha256: downloadEchoRequestId,
        detected_container: transport.detected_container,
        decoded_member_name: memberName,
      },
      decoded_report: {
        bytes_sha256: decodedSha,
        byte_length: decodedLength,
        text_encoding: TEXT_ENCODING,
        utf8_bom: decoded.utf8_bom,
        delimiter: decoded.delimiter,
        media_type: expectedMedia,
        line_ending: decoded.line_ending,
        header,
        header_sha256: headerSha,
        header_mapping: headerMapping,
        logical_record_count: logicalRecords,
        data_record_count: dataRecords,
      },
    },
    status_semantics: fixedStatusSemantics(),
    reconciliation: {
      parsed_data_record_count: parsedCount,
      included_published_count: includedCount,
      excluded_non_published_count: excludedCount,
      unique_published_listing_count: uniqueCount,
      output_row_count: outputCount,
      malformed_record_count: 0,
      duplicate_listing_key_count: 0,
      conflicting_listing_key_count: 0,
      published_status_counts: publishedStatusCounts,
      lifecycle_status_counts: lifecycleStatusCounts,
      lifecycle_status_not_reported_count: lifecycleNotReportedCount,
    },
    published_population_complete: true,
    rows,
    source_id: exactString(raw.source_id, "source.source_id"),
    body_sha256: sha256String(raw.body_sha256, "source.body_sha256"),
  };
  const body = structuredClone(parsed) as unknown as JsonRecord;
  delete body.source_id;
  delete body.body_sha256;
  const expectedBodySha = walmartItemReportSha256(body);
  if (parsed.body_sha256 !== expectedBodySha) throw new Error("source.body_sha256 mismatch");
  const expectedSourceId = `walmart-item-report-published-${expectedBodySha.slice(0, 16)}`;
  if (parsed.source_id !== expectedSourceId) throw new Error(`source.source_id must be ${expectedSourceId}`);
  return parsed;
}

/**
 * Rebuild every byte-derived field and verify all external atomic-exchange
 * attestations from trusted context. This is capture provenance, not a Walmart
 * server signature.
 */
export function verifyWalmartItemReportPublishedSourceAgainstCapture(
  input: unknown,
  captureInput: unknown,
  trustedContextInput: unknown,
): SealedWalmartItemReportPublishedSource {
  const verified = verifyWalmartItemReportPublishedSource(input);
  const rebuilt = compileWalmartItemReportPublishedSource(captureInput, trustedContextInput);
  if (canonicalWalmartItemReportJson(verified) !== canonicalWalmartItemReportJson(rebuilt)) {
    throw new Error("source does not exactly recompile from the trusted ITEM report capture and context");
  }
  return verified;
}

export const WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA =
  "walmart-shadow-published-catalog-source/v2" as const;

export interface WalmartShadowPublishedCatalogSourceFromItemReport {
  schema_version: typeof WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA;
  snapshot_id: string;
  body_sha256: string;
  captured_at: string;
  channel: typeof CHANNEL;
  published_population_complete: true;
  source_artifact: {
    schema_version: typeof WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA;
    source_id: string;
    body_sha256: string;
    raw_transport_sha256: string;
    decoded_report_sha256: string;
    cutoff_at: string;
  };
  rows: Array<WalmartListingIdentity & { published_status: "PUBLISHED" }>;
}

/**
 * Integrity-only projection into the Shadow source schema. Operational callers
 * must first run verifyWalmartItemReportPublishedSourceAgainstCapture; this
 * helper alone does not authenticate a detached upstream artifact.
 */
export function compileWalmartShadowPublishedCatalogSourceFromItemReport(
  upstreamInput: unknown,
): WalmartShadowPublishedCatalogSourceFromItemReport {
  const upstream = verifyWalmartItemReportPublishedSource(upstreamInput);
  const body = {
    schema_version: WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA,
    captured_at: upstream.report.cutoff_at,
    channel: CHANNEL,
    published_population_complete: true as const,
    source_artifact: {
      schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
      source_id: upstream.source_id,
      body_sha256: upstream.body_sha256,
      raw_transport_sha256: upstream.report.download_transport.bytes_sha256,
      decoded_report_sha256: upstream.report.decoded_report.bytes_sha256,
      cutoff_at: upstream.report.cutoff_at,
    },
    rows: upstream.rows.map((row) => ({
      channel: CHANNEL,
      store_index: row.store_index,
      sku: row.sku,
      listing_key: row.listing_key,
      published_status: "PUBLISHED" as const,
    })),
  };
  const bodySha = walmartItemReportSha256(body);
  return {
    ...body,
    snapshot_id: `walmart-shadow-catalog-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

/** Integrity/self-seal verifier only; not a substitute for capture-aware verification. */
export function verifyWalmartShadowPublishedCatalogSource(
  input: unknown,
): WalmartShadowPublishedCatalogSourceFromItemReport {
  const raw = asRecord(input, "shadow published source");
  assertExactKeys(raw, [
    "schema_version", "snapshot_id", "body_sha256", "captured_at", "channel",
    "published_population_complete", "source_artifact", "rows",
  ], "shadow published source");
  if (raw.schema_version !== WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA) {
    throw new Error(`shadow published source.schema_version must be ${WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA}`);
  }
  if (raw.channel !== CHANNEL || raw.published_population_complete !== true) {
    throw new Error("shadow published source scope/completeness is invalid");
  }
  const capturedAt = isoTimestamp(raw.captured_at, "shadow published source.captured_at");
  const binding = asRecord(raw.source_artifact, "shadow published source.source_artifact");
  assertExactKeys(binding, [
    "schema_version", "source_id", "body_sha256", "raw_transport_sha256",
    "decoded_report_sha256", "cutoff_at",
  ], "shadow published source.source_artifact");
  if (binding.schema_version !== WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA) {
    throw new Error("shadow published source.source_artifact schema is invalid");
  }
  const cutoffAt = isoTimestamp(binding.cutoff_at, "shadow published source.source_artifact.cutoff_at");
  if (capturedAt !== cutoffAt) throw new Error("shadow published source captured_at must equal source cutoff_at");
  if (!Array.isArray(raw.rows)) throw new Error("shadow published source.rows must be an array");
  const rows = raw.rows.map((inputRow, index) => {
    const path = `shadow published source.rows[${index}]`;
    const row = asRecord(inputRow, path);
    assertExactKeys(row, ["channel", "store_index", "sku", "listing_key", "published_status"], path);
    if (row.channel !== CHANNEL || row.published_status !== "PUBLISHED") throw new Error(`${path} scope/status is invalid`);
    const storeIndex = positiveInteger(row.store_index, `${path}.store_index`);
    const sku = exactString(row.sku, `${path}.sku`);
    const listingKey = walmartListingKey(storeIndex, sku);
    if (row.listing_key !== listingKey) throw new Error(`${path}.listing_key is invalid`);
    return { channel: CHANNEL, store_index: storeIndex, sku, listing_key: listingKey, published_status: "PUBLISHED" as const };
  });
  const keys = rows.map((row) => row.listing_key);
  if (new Set(keys).size !== keys.length
    || canonicalWalmartItemReportJson(keys) !== canonicalWalmartItemReportJson([...keys].sort(compareCodeUnits))) {
    throw new Error("shadow published source.rows must be unique and canonically sorted");
  }
  const parsed: WalmartShadowPublishedCatalogSourceFromItemReport = {
    schema_version: WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA,
    snapshot_id: exactString(raw.snapshot_id, "shadow published source.snapshot_id"),
    body_sha256: sha256String(raw.body_sha256, "shadow published source.body_sha256"),
    captured_at: capturedAt,
    channel: CHANNEL,
    published_population_complete: true,
    source_artifact: {
      schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
      source_id: exactString(binding.source_id, "shadow published source.source_artifact.source_id"),
      body_sha256: sha256String(binding.body_sha256, "shadow published source.source_artifact.body_sha256"),
      raw_transport_sha256: sha256String(
        binding.raw_transport_sha256,
        "shadow published source.source_artifact.raw_transport_sha256",
      ),
      decoded_report_sha256: sha256String(
        binding.decoded_report_sha256,
        "shadow published source.source_artifact.decoded_report_sha256",
      ),
      cutoff_at: cutoffAt,
    },
    rows,
  };
  const body = structuredClone(parsed) as unknown as JsonRecord;
  delete body.snapshot_id;
  delete body.body_sha256;
  const bodySha = walmartItemReportSha256(body);
  if (parsed.body_sha256 !== bodySha) throw new Error("shadow published source.body_sha256 mismatch");
  const snapshotId = `walmart-shadow-catalog-${bodySha.slice(0, 16)}`;
  if (parsed.snapshot_id !== snapshotId) throw new Error(`shadow published source.snapshot_id must be ${snapshotId}`);
  return parsed;
}

/** Strong bridge verification all the way back to exact HTTP/status capture bytes. */
export function verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture(
  bridgeInput: unknown,
  upstreamInput: unknown,
  captureInput: unknown,
  trustedContextInput: unknown,
): WalmartShadowPublishedCatalogSourceFromItemReport {
  const bridge = verifyWalmartShadowPublishedCatalogSource(bridgeInput);
  const upstream = verifyWalmartItemReportPublishedSourceAgainstCapture(
    upstreamInput,
    captureInput,
    trustedContextInput,
  );
  const rebuilt = compileWalmartShadowPublishedCatalogSourceFromItemReport(upstream);
  if (canonicalWalmartItemReportJson(bridge) !== canonicalWalmartItemReportJson(rebuilt)) {
    throw new Error("shadow published source does not exactly rebuild from the source-verified ITEM report");
  }
  return bridge;
}

function fixedCatalogStatusSemantics(): WalmartItemReportCatalogSourceBody["status_semantics"] {
  return {
    policy_id: WALMART_ITEM_REPORT_CATALOG_STATUS_POLICY,
    included_published_statuses: [...PUBLISHED_STATUSES],
    accepted_lifecycle_statuses: [...LIFECYCLE_STATUSES],
    inclusion_rule: "ALL_REPORT_ROWS",
    lifecycle_status_role: "OPTIONAL_EVIDENCE_ONLY",
  };
}

function findCatalogBrandIndex(header: string[]): number {
  const accepted = normalizeHeader("Brand");
  const matches = header
    .map((value, index) => ({ value: normalizeHeader(value), index }))
    .filter(({ value }) => value === accepted)
    .map(({ index }) => index);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "ITEM v6 catalog source is missing required Brand column"
        : `ITEM v6 catalog source has ambiguous Brand columns at indexes ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

function optionalCatalogCell(
  record: string[],
  index: number | null,
  path: string,
): string | null {
  if (index === null || record[index] === "") return null;
  return exactString(record[index], path);
}

function compileCatalogRow(
  reportRecord: ParsedReport["records"][number],
  parsed: ParsedReport,
  brandIndex: number,
  accountScope: WalmartItemReportCompileContext["account_scope"],
): WalmartItemReportCatalogRow {
  const recordPath = `ITEM report record ${reportRecord.sourceRecordNumber}`;
  const cells = reportRecord.cells;
  const sku = exactString(cells[parsed.headerMapping.sku], `${recordPath}.sku`);
  const publishedStatus = parsePublishedStatus(
    cells[parsed.headerMapping.published_status],
    `${recordPath}.published_status`,
  );
  const lifecycleStatus = parsed.headerMapping.lifecycle_status === null
    ? null
    : parseOptionalLifecycleStatus(
      cells[parsed.headerMapping.lifecycle_status],
      `${recordPath}.lifecycle_status`,
    );
  const productCondition = optionalCatalogCell(
    cells,
    parsed.headerMapping.product_condition,
    `${recordPath}.product_condition`,
  );
  return {
    channel: CHANNEL,
    store_index: accountScope.store_index,
    sku,
    listing_key: walmartListingKey(accountScope.store_index, sku),
    reported_product_identifier_opaque: exactString(
      cells[parsed.headerMapping.product_id],
      `${recordPath}.product_id`,
    ),
    reported_product_identifier_type_opaque: exactString(
      cells[parsed.headerMapping.product_id_type],
      `${recordPath}.product_id_type`,
    ),
    reported_product_identifier_header: parsed.header[parsed.headerMapping.product_id],
    reported_product_identifier_type_header: parsed.header[parsed.headerMapping.product_id_type],
    reported_product_name: exactText(
      cells[parsed.headerMapping.product_name],
      `${recordPath}.product_name`,
    ),
    reported_product_name_header: parsed.header[parsed.headerMapping.product_name],
    reported_brand: cells[brandIndex] === ""
      ? null
      : exactText(cells[brandIndex], `${recordPath}.brand`),
    reported_brand_header: parsed.header[brandIndex],
    reported_product_condition: productCondition,
    reported_product_condition_header: parsed.header[parsed.headerMapping.product_condition as number],
    reported_lifecycle_status: lifecycleStatus,
    reported_lifecycle_status_header: parsed.headerMapping.lifecycle_status === null
      ? null
      : parsed.header[parsed.headerMapping.lifecycle_status],
    reported_legacy_item_identifier_opaque: optionalCatalogCell(
      cells,
      parsed.headerMapping.legacy_item_id,
      `${recordPath}.legacy_item_id`,
    ),
    reported_legacy_item_identifier_header: parsed.headerMapping.legacy_item_id === null
      ? null
      : parsed.header[parsed.headerMapping.legacy_item_id],
    reported_legacy_wpid_opaque: optionalCatalogCell(
      cells,
      parsed.headerMapping.legacy_wpid,
      `${recordPath}.legacy_wpid`,
    ),
    reported_legacy_wpid_header: parsed.headerMapping.legacy_wpid === null
      ? null
      : parsed.header[parsed.headerMapping.legacy_wpid],
    published_status: publishedStatus,
    source_record_number: reportRecord.sourceRecordNumber,
    source_record_sha256: walmartItemReportSha256(cells),
  };
}

/**
 * Compile a strict, all-status ITEM v6 catalog projection from the same atomic
 * capture and separately trusted context used by published-source/v1. The
 * published-only artifact is rebuilt first so this projection is bound to the
 * complete request/READY/download trust chain rather than detached report bytes.
 */
export function compileWalmartItemReportCatalogSource(
  captureInput: unknown,
  trustedContextInput: unknown,
): SealedWalmartItemReportCatalogSource {
  const publishedSource = compileWalmartItemReportPublishedSource(
    captureInput,
    trustedContextInput,
  );
  const capture = parseCapture(captureInput);
  const context = parseContext(trustedContextInput);
  const decoded = decodeTransport(capture.transportBytes);
  const parsed = parseReport(decoded.reportBytes, "v6");
  const brandIndex = findCatalogBrandIndex(parsed.header);

  if (sha256Bytes(capture.transportBytes) !== publishedSource.report.download_transport.bytes_sha256
    || sha256Bytes(decoded.reportBytes) !== publishedSource.report.decoded_report.bytes_sha256
    || parsed.records.length !== publishedSource.report.decoded_report.data_record_count) {
    throw new Error("ITEM v6 catalog projection does not match the compiled published source bytes");
  }

  const rows = parsed.records.map((record) => compileCatalogRow(
    record,
    parsed,
    brandIndex,
    context.account_scope,
  ));
  rows.sort((left, right) => compareCodeUnits(left.listing_key, right.listing_key));
  if (new Set(rows.map((row) => row.listing_key)).size !== rows.length) {
    throw new Error("ITEM v6 catalog projection contains duplicate listing_key values");
  }

  const publishedCounts = new Map<PublishedStatus, number>(
    PUBLISHED_STATUSES.map((status) => [status, 0]),
  );
  const lifecycleCounts = new Map<LifecycleStatus, number>(
    LIFECYCLE_STATUSES.map((status) => [status, 0]),
  );
  let lifecycleNotReportedCount = 0;
  for (const row of rows) {
    publishedCounts.set(row.published_status, (publishedCounts.get(row.published_status) ?? 0) + 1);
    if (row.reported_lifecycle_status === null) lifecycleNotReportedCount += 1;
    else {
      lifecycleCounts.set(
        row.reported_lifecycle_status,
        (lifecycleCounts.get(row.reported_lifecycle_status) ?? 0) + 1,
      );
    }
  }
  const publishedStatusCounts = PUBLISHED_STATUSES.map((status) => ({
    status,
    count: publishedCounts.get(status) ?? 0,
  }));
  const lifecycleStatusCounts = LIFECYCLE_STATUSES.map((status) => ({
    status,
    count: lifecycleCounts.get(status) ?? 0,
  }));
  if (canonicalWalmartItemReportJson(publishedStatusCounts)
    !== canonicalWalmartItemReportJson(publishedSource.reconciliation.published_status_counts)
    || canonicalWalmartItemReportJson(lifecycleStatusCounts)
      !== canonicalWalmartItemReportJson(publishedSource.reconciliation.lifecycle_status_counts)
    || lifecycleNotReportedCount
      !== publishedSource.reconciliation.lifecycle_status_not_reported_count) {
    throw new Error("ITEM v6 catalog projection status counts conflict with published-source reconciliation");
  }

  const body: WalmartItemReportCatalogSourceBody = {
    schema_version: WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
    account_scope: structuredClone(context.account_scope),
    report: {
      source_system: "walmart_marketplace_api",
      report_type: REPORT_TYPE,
      report_version: "v6",
      report_request_id: publishedSource.report.report_request_id,
      report_request_id_sha256: walmartItemReportUtf8Sha256(
        publishedSource.report.report_request_id,
      ),
      requested_at: publishedSource.report.requested_at,
      cutoff_at: publishedSource.report.cutoff_at,
      cutoff_basis: "READY_OBSERVED_UPPER_BOUND",
      downloaded_at: publishedSource.report.downloaded_at,
      raw_transport_sha256: publishedSource.report.download_transport.bytes_sha256,
      decoded_report_sha256: publishedSource.report.decoded_report.bytes_sha256,
      parsed_data_record_count: parsed.records.length,
    },
    published_source: {
      schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
      source_id: publishedSource.source_id,
      body_sha256: publishedSource.body_sha256,
    },
    status_semantics: fixedCatalogStatusSemantics(),
    reconciliation: {
      parsed_data_record_count: parsed.records.length,
      output_row_count: rows.length,
      unique_listing_count: rows.length,
      rows_sha256: walmartItemReportSha256(rows),
      published_row_count: rows.filter((row) => row.published_status === "PUBLISHED").length,
      published_rows_sha256: walmartItemReportSha256(
        rows.filter((row) => row.published_status === "PUBLISHED"),
      ),
      malformed_record_count: 0,
      duplicate_listing_key_count: 0,
      conflicting_listing_key_count: 0,
      published_status_counts: publishedStatusCounts,
      lifecycle_status_counts: lifecycleStatusCounts,
      lifecycle_status_not_reported_count: lifecycleNotReportedCount,
    },
    catalog_population_complete: true,
    rows,
  };
  const bodySha256 = walmartItemReportSha256(body);
  const source: SealedWalmartItemReportCatalogSource = {
    ...body,
    source_id: `walmart-item-report-catalog-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256,
  };
  verifyWalmartItemReportCatalogSource(source);
  return source;
}

function exactCatalogHeader(
  value: unknown,
  aliases: readonly string[],
  path: string,
): string {
  const header = exactString(value, path);
  if (!new Set(aliases.map(normalizeHeader)).has(normalizeHeader(header))) {
    throw new Error(`${path} is not an accepted ITEM v6 header`);
  }
  return header;
}

function parseCatalogOptionalEvidence(
  value: unknown,
  headerValue: unknown,
  aliases: readonly string[],
  path: string,
  parseValue: (value: string, path: string) => string = exactString,
): { value: string | null; header: string | null } {
  const header = headerValue === null
    ? null
    : exactCatalogHeader(headerValue, aliases, `${path}_header`);
  if (value === null) return { value: null, header };
  if (header === null) throw new Error(`${path} cannot be present without its report header`);
  return { value: parseValue(value as string, path), header };
}

function parseCatalogRow(
  input: unknown,
  index: number,
  accountScope: WalmartItemReportCompileContext["account_scope"],
): WalmartItemReportCatalogRow {
  const path = `catalog source.rows[${index}]`;
  const raw = asRecord(input, path);
  assertExactKeys(raw, [
    "channel",
    "store_index",
    "sku",
    "listing_key",
    "reported_product_identifier_opaque",
    "reported_product_identifier_type_opaque",
    "reported_product_identifier_header",
    "reported_product_identifier_type_header",
    "reported_product_name",
    "reported_product_name_header",
    "reported_brand",
    "reported_brand_header",
    "reported_product_condition",
    "reported_product_condition_header",
    "reported_lifecycle_status",
    "reported_lifecycle_status_header",
    "reported_legacy_item_identifier_opaque",
    "reported_legacy_item_identifier_header",
    "reported_legacy_wpid_opaque",
    "reported_legacy_wpid_header",
    "published_status",
    "source_record_number",
    "source_record_sha256",
  ], path);
  if (raw.channel !== CHANNEL || raw.channel !== accountScope.channel) {
    throw new Error(`${path}.channel must match account scope`);
  }
  const storeIndex = positiveInteger(raw.store_index, `${path}.store_index`);
  if (storeIndex !== accountScope.store_index) {
    throw new Error(`${path}.store_index must match account scope`);
  }
  const sku = exactString(raw.sku, `${path}.sku`);
  const listingKey = walmartListingKey(storeIndex, sku);
  if (raw.listing_key !== listingKey) throw new Error(`${path}.listing_key must be ${listingKey}`);
  if (!(PUBLISHED_STATUSES as readonly unknown[]).includes(raw.published_status)) {
    throw new Error(`${path}.published_status is not supported`);
  }
  const publishedStatus = raw.published_status as PublishedStatus;

  const productIdentifierHeader = exactCatalogHeader(
    raw.reported_product_identifier_header,
    REQUIRED_HEADER_ALIASES.product_id,
    `${path}.reported_product_identifier_header`,
  );
  const productIdentifierTypeHeader = exactCatalogHeader(
    raw.reported_product_identifier_type_header,
    REQUIRED_HEADER_ALIASES.product_id_type,
    `${path}.reported_product_identifier_type_header`,
  );
  const productNameHeader = exactCatalogHeader(
    raw.reported_product_name_header,
    REQUIRED_HEADER_ALIASES.product_name,
    `${path}.reported_product_name_header`,
  );
  const brandHeader = exactCatalogHeader(
    raw.reported_brand_header,
    ["Brand"],
    `${path}.reported_brand_header`,
  );
  const condition = parseCatalogOptionalEvidence(
    raw.reported_product_condition,
    raw.reported_product_condition_header,
    OPTIONAL_HEADER_ALIASES.product_condition,
    `${path}.reported_product_condition`,
  );
  if (condition.header === null) {
    throw new Error(`${path}.reported_product_condition_header is required for ITEM v6`);
  }
  const lifecyclePair = parseCatalogOptionalEvidence(
    raw.reported_lifecycle_status,
    raw.reported_lifecycle_status_header,
    OPTIONAL_HEADER_ALIASES.lifecycle_status,
    `${path}.reported_lifecycle_status`,
    (value, valuePath) => {
      const parsed = parseLifecycleStatus(value, valuePath);
      if (parsed !== value) throw new Error(`${valuePath} must use the canonical lifecycle status`);
      return parsed;
    },
  );
  const legacyItem = parseCatalogOptionalEvidence(
    raw.reported_legacy_item_identifier_opaque,
    raw.reported_legacy_item_identifier_header,
    OPTIONAL_HEADER_ALIASES.legacy_item_id,
    `${path}.reported_legacy_item_identifier_opaque`,
  );
  const legacyWpid = parseCatalogOptionalEvidence(
    raw.reported_legacy_wpid_opaque,
    raw.reported_legacy_wpid_header,
    OPTIONAL_HEADER_ALIASES.legacy_wpid,
    `${path}.reported_legacy_wpid_opaque`,
  );
  return {
    channel: CHANNEL,
    store_index: storeIndex,
    sku,
    listing_key: listingKey,
    reported_product_identifier_opaque: exactString(
      raw.reported_product_identifier_opaque,
      `${path}.reported_product_identifier_opaque`,
    ),
    reported_product_identifier_type_opaque: exactString(
      raw.reported_product_identifier_type_opaque,
      `${path}.reported_product_identifier_type_opaque`,
    ),
    reported_product_identifier_header: productIdentifierHeader,
    reported_product_identifier_type_header: productIdentifierTypeHeader,
    reported_product_name: exactText(raw.reported_product_name, `${path}.reported_product_name`),
    reported_product_name_header: productNameHeader,
    reported_brand: raw.reported_brand === null
      ? null
      : exactText(raw.reported_brand, `${path}.reported_brand`),
    reported_brand_header: brandHeader,
    reported_product_condition: condition.value,
    reported_product_condition_header: condition.header,
    reported_lifecycle_status: lifecyclePair.value as LifecycleStatus | null,
    reported_lifecycle_status_header: lifecyclePair.header,
    reported_legacy_item_identifier_opaque: legacyItem.value,
    reported_legacy_item_identifier_header: legacyItem.header,
    reported_legacy_wpid_opaque: legacyWpid.value,
    reported_legacy_wpid_header: legacyWpid.header,
    published_status: publishedStatus,
    source_record_number: positiveInteger(raw.source_record_number, `${path}.source_record_number`),
    source_record_sha256: sha256String(raw.source_record_sha256, `${path}.source_record_sha256`),
  };
}

/** Strict self-consistency verifier. Capture provenance requires the stronger verifier below. */
export function verifyWalmartItemReportCatalogSource(
  input: unknown,
): SealedWalmartItemReportCatalogSource {
  const raw = asRecord(input, "catalog source");
  assertExactKeys(raw, [
    "schema_version",
    "account_scope",
    "report",
    "published_source",
    "status_semantics",
    "reconciliation",
    "catalog_population_complete",
    "rows",
    "source_id",
    "body_sha256",
  ], "catalog source");
  if (raw.schema_version !== WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA) {
    throw new Error(`catalog source.schema_version must be ${WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA}`);
  }
  if (raw.catalog_population_complete !== true) {
    throw new Error("catalog source.catalog_population_complete must be compiler-derived true");
  }
  const accountScope = parseAccountScope(raw.account_scope, "catalog source.account_scope");

  const report = asRecord(raw.report, "catalog source.report");
  assertExactKeys(report, [
    "source_system",
    "report_type",
    "report_version",
    "report_request_id",
    "report_request_id_sha256",
    "requested_at",
    "cutoff_at",
    "cutoff_basis",
    "downloaded_at",
    "raw_transport_sha256",
    "decoded_report_sha256",
    "parsed_data_record_count",
  ], "catalog source.report");
  if (report.source_system !== "walmart_marketplace_api"
    || report.report_type !== REPORT_TYPE
    || report.report_version !== "v6"
    || report.cutoff_basis !== "READY_OBSERVED_UPPER_BOUND") {
    throw new Error("catalog source.report must bind the full ITEM v6 READY-cutoff source");
  }
  const reportRequestId = exactString(report.report_request_id, "catalog source.report.report_request_id");
  const reportRequestIdSha256 = sha256String(
    report.report_request_id_sha256,
    "catalog source.report.report_request_id_sha256",
  );
  if (reportRequestIdSha256 !== walmartItemReportUtf8Sha256(reportRequestId)) {
    throw new Error("catalog source.report.report_request_id_sha256 mismatch");
  }
  const requestedAt = isoTimestamp(report.requested_at, "catalog source.report.requested_at");
  const cutoffAt = isoTimestamp(report.cutoff_at, "catalog source.report.cutoff_at");
  const downloadedAt = isoTimestamp(report.downloaded_at, "catalog source.report.downloaded_at");
  if (Date.parse(requestedAt) > Date.parse(cutoffAt)
    || Date.parse(cutoffAt) > Date.parse(downloadedAt)) {
    throw new Error("catalog source.report chronology must satisfy requested_at <= cutoff_at <= downloaded_at");
  }
  const rawTransportSha256 = sha256String(
    report.raw_transport_sha256,
    "catalog source.report.raw_transport_sha256",
  );
  const decodedReportSha256 = sha256String(
    report.decoded_report_sha256,
    "catalog source.report.decoded_report_sha256",
  );
  const reportParsedCount = positiveInteger(
    report.parsed_data_record_count,
    "catalog source.report.parsed_data_record_count",
  );

  const publishedSource = asRecord(raw.published_source, "catalog source.published_source");
  assertExactKeys(
    publishedSource,
    ["schema_version", "source_id", "body_sha256"],
    "catalog source.published_source",
  );
  if (publishedSource.schema_version !== WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA) {
    throw new Error("catalog source.published_source schema is invalid");
  }
  const publishedBodySha256 = sha256String(
    publishedSource.body_sha256,
    "catalog source.published_source.body_sha256",
  );
  const expectedPublishedSourceId = `walmart-item-report-published-${publishedBodySha256.slice(0, 16)}`;
  const publishedSourceId = exactString(
    publishedSource.source_id,
    "catalog source.published_source.source_id",
  );
  if (publishedSourceId !== expectedPublishedSourceId) {
    throw new Error(`catalog source.published_source.source_id must be ${expectedPublishedSourceId}`);
  }

  const statusSemantics = asRecord(raw.status_semantics, "catalog source.status_semantics");
  if (canonicalWalmartItemReportJson(statusSemantics)
    !== canonicalWalmartItemReportJson(fixedCatalogStatusSemantics())) {
    throw new Error("catalog source.status_semantics does not match the all-status policy");
  }

  const reconciliation = asRecord(raw.reconciliation, "catalog source.reconciliation");
  assertExactKeys(reconciliation, [
    "parsed_data_record_count",
    "output_row_count",
    "unique_listing_count",
    "rows_sha256",
    "published_row_count",
    "published_rows_sha256",
    "malformed_record_count",
    "duplicate_listing_key_count",
    "conflicting_listing_key_count",
    "published_status_counts",
    "lifecycle_status_counts",
    "lifecycle_status_not_reported_count",
  ], "catalog source.reconciliation");
  const parsedCount = positiveInteger(
    reconciliation.parsed_data_record_count,
    "catalog source.reconciliation.parsed_data_record_count",
  );
  const outputCount = positiveInteger(
    reconciliation.output_row_count,
    "catalog source.reconciliation.output_row_count",
  );
  const uniqueCount = positiveInteger(
    reconciliation.unique_listing_count,
    "catalog source.reconciliation.unique_listing_count",
  );
  const rowsSha256 = sha256String(reconciliation.rows_sha256, "catalog source.reconciliation.rows_sha256");
  const publishedRowCount = nonNegativeInteger(
    reconciliation.published_row_count,
    "catalog source.reconciliation.published_row_count",
  );
  const publishedRowsSha256 = sha256String(
    reconciliation.published_rows_sha256,
    "catalog source.reconciliation.published_rows_sha256",
  );
  for (const field of [
    "malformed_record_count",
    "duplicate_listing_key_count",
    "conflicting_listing_key_count",
  ] as const) {
    if (reconciliation[field] !== 0) {
      throw new Error(`catalog source.reconciliation.${field} must be zero`);
    }
  }
  const publishedStatusCounts = parseCountArray(
    reconciliation.published_status_counts,
    PUBLISHED_STATUSES,
    "catalog source.reconciliation.published_status_counts",
  );
  const lifecycleStatusCounts = parseCountArray(
    reconciliation.lifecycle_status_counts,
    LIFECYCLE_STATUSES,
    "catalog source.reconciliation.lifecycle_status_counts",
  );
  const lifecycleNotReportedCount = nonNegativeInteger(
    reconciliation.lifecycle_status_not_reported_count,
    "catalog source.reconciliation.lifecycle_status_not_reported_count",
  );

  if (!Array.isArray(raw.rows)) throw new Error("catalog source.rows must be an array");
  const rows = raw.rows.map((row, index) => parseCatalogRow(row, index, accountScope));
  const listingKeys = rows.map((row) => row.listing_key);
  if (canonicalWalmartItemReportJson(listingKeys)
    !== canonicalWalmartItemReportJson([...listingKeys].sort(compareCodeUnits))) {
    throw new Error("catalog source.rows must be sorted by listing_key using code-unit order");
  }
  if (new Set(listingKeys).size !== rows.length) {
    throw new Error("catalog source.rows has duplicate listing_key values");
  }
  const sourceRecordNumbers = rows.map((row) => row.source_record_number);
  if (new Set(sourceRecordNumbers).size !== rows.length
    || sourceRecordNumbers.some((number) => number < 2 || number > parsedCount + 1)) {
    throw new Error("catalog source.rows must cover unique decoded source record numbers");
  }
  if (reportParsedCount !== parsedCount
    || parsedCount !== rows.length
    || outputCount !== rows.length
    || uniqueCount !== rows.length) {
    throw new Error("catalog source record/output counts do not reconcile");
  }
  if (rowsSha256 !== walmartItemReportSha256(rows)) {
    throw new Error("catalog source.reconciliation.rows_sha256 mismatch");
  }
  const publishedRows = rows.filter((row) => row.published_status === "PUBLISHED");
  if (publishedRowCount !== publishedRows.length
    || publishedRowsSha256 !== walmartItemReportSha256(publishedRows)) {
    throw new Error("catalog source PUBLISHED projection count/hash mismatch");
  }
  const countRows = <T extends string>(
    statuses: readonly T[],
    selector: (row: WalmartItemReportCatalogRow) => T | null,
  ): Array<StatusCount<T>> => statuses.map((status) => ({
    status,
    count: rows.filter((row) => selector(row) === status).length,
  }));
  if (canonicalWalmartItemReportJson(publishedStatusCounts)
      !== canonicalWalmartItemReportJson(countRows(PUBLISHED_STATUSES, (row) => row.published_status))
    || canonicalWalmartItemReportJson(lifecycleStatusCounts)
      !== canonicalWalmartItemReportJson(countRows(LIFECYCLE_STATUSES, (row) => row.reported_lifecycle_status))
    || lifecycleNotReportedCount !== rows.filter((row) => row.reported_lifecycle_status === null).length) {
    throw new Error("catalog source status counts do not reconcile with rows");
  }

  const parsed: SealedWalmartItemReportCatalogSource = {
    schema_version: WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
    account_scope: accountScope,
    report: {
      source_system: "walmart_marketplace_api",
      report_type: REPORT_TYPE,
      report_version: "v6",
      report_request_id: reportRequestId,
      report_request_id_sha256: reportRequestIdSha256,
      requested_at: requestedAt,
      cutoff_at: cutoffAt,
      cutoff_basis: "READY_OBSERVED_UPPER_BOUND",
      downloaded_at: downloadedAt,
      raw_transport_sha256: rawTransportSha256,
      decoded_report_sha256: decodedReportSha256,
      parsed_data_record_count: reportParsedCount,
    },
    published_source: {
      schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
      source_id: publishedSourceId,
      body_sha256: publishedBodySha256,
    },
    status_semantics: fixedCatalogStatusSemantics(),
    reconciliation: {
      parsed_data_record_count: parsedCount,
      output_row_count: outputCount,
      unique_listing_count: uniqueCount,
      rows_sha256: rowsSha256,
      published_row_count: publishedRowCount,
      published_rows_sha256: publishedRowsSha256,
      malformed_record_count: 0,
      duplicate_listing_key_count: 0,
      conflicting_listing_key_count: 0,
      published_status_counts: publishedStatusCounts,
      lifecycle_status_counts: lifecycleStatusCounts,
      lifecycle_status_not_reported_count: lifecycleNotReportedCount,
    },
    catalog_population_complete: true,
    rows,
    source_id: exactString(raw.source_id, "catalog source.source_id"),
    body_sha256: sha256String(raw.body_sha256, "catalog source.body_sha256"),
  };
  const body = structuredClone(parsed) as unknown as JsonRecord;
  delete body.source_id;
  delete body.body_sha256;
  const expectedBodySha256 = walmartItemReportSha256(body);
  if (parsed.body_sha256 !== expectedBodySha256) {
    throw new Error("catalog source.body_sha256 mismatch");
  }
  const expectedSourceId = `walmart-item-report-catalog-${expectedBodySha256.slice(0, 16)}`;
  if (parsed.source_id !== expectedSourceId) {
    throw new Error(`catalog source.source_id must be ${expectedSourceId}`);
  }
  return parsed;
}

/**
 * Recompile the complete catalog artifact from exact capture bytes and the
 * separately trusted exchange context. This is the provenance verifier that
 * rejects coherently re-sealed/self-authored catalog artifacts.
 */
export function verifyWalmartItemReportCatalogSourceAgainstCapture(
  input: unknown,
  captureInput: unknown,
  trustedContextInput: unknown,
): SealedWalmartItemReportCatalogSource {
  const verified = verifyWalmartItemReportCatalogSource(input);
  const rebuilt = compileWalmartItemReportCatalogSource(captureInput, trustedContextInput);
  if (canonicalWalmartItemReportJson(verified) !== canonicalWalmartItemReportJson(rebuilt)) {
    throw new Error("catalog source does not exactly recompile from the trusted ITEM report capture and context");
  }
  return verified;
}
