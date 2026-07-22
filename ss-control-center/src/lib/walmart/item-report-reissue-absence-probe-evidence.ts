import { createHash } from "node:crypto";

import { canonicalWalmartItemReportJson } from "./item-report-published-source.ts";

export const WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA =
  "walmart-item-v6-absence-probe/1.0.0" as const;
export const WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_MAX_AGE_MS =
  24 * 60 * 60 * 1000;
export const WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_STORE_INDEX = 1;
export const WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_SELLER_ID = "10001624309";
export const WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_ACCOUNT_FINGERPRINT =
  "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127";
export const WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY = Object.freeze({
  reportType: "ITEM",
  reportVersion: "v6",
  src: "API",
  requestSubmissionStartDate: "2026-07-19T03:55:00Z",
  requestSubmissionEndDate: "2026-07-19T04:00:00Z",
});
export const WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES = Object.freeze([
  "00-probe-authority.json",
  "10-get-reserved.json",
  "20-response-raw.bytes",
  "21-response-http.json",
  "22-exchange-seal.json",
  "30-result.json",
] as const);

const API_ENDPOINT = "/v3/reports/reportRequests";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECT_BYTES = 64 * 1024;

type JsonRecord = Record<string, unknown>;

export interface WalmartItemV6AbsenceProbeEvidenceArtifact {
  path: string;
  byte_length: number;
  sha256: string;
}

export interface VerifiedWalmartItemV6AbsenceProbeEvidenceFamily {
  schema_version: typeof WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA;
  probe_id: string;
  account_scope: {
    channel: "WALMART_US";
    store_index: 1;
    seller_id: string;
    seller_account_fingerprint_sha256: string;
  };
  query: typeof WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY;
  created_at: string;
  reserved_at: string;
  observed_at: string;
  completed_at: string;
  fresh_until: string;
  request_correlation_id: string;
  request_correlation_id_sha256: string;
  walmart_x_request_id: string | null;
  raw_response_sha256: string;
  raw_response_byte_length: number;
  artifact_inventory: WalmartItemV6AbsenceProbeEvidenceArtifact[];
  evidence_family_sha256: string;
  result_artifact_sha256: string;
  outcome: "ABSENCE_ONLY";
  exact_query_absence_verified: true;
  http_calls: {
    oauth_token_posts: 1;
    report_requests_gets: 1;
    presigned_file_calls: 0;
  };
}

export class WalmartItemV6AbsenceProbeEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartItemV6AbsenceProbeEvidenceError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartItemV6AbsenceProbeEvidenceError(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail("INVALID_PROBE_EVIDENCE", `${label} must be an object`);
  return value;
}

function exactString(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_PROBE_EVIDENCE", `${label} is invalid`);
  }
  return value;
}

function strictInstant(value: unknown, label: string): string {
  const parsed = exactString(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || !Number.isFinite(Date.parse(parsed))
    || new Date(Date.parse(parsed)).toISOString() !== parsed) {
    fail("INVALID_PROBE_EVIDENCE", `${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalWalmartItemReportJson(value), "utf8");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}

function assertCanonicalEqual(actual: unknown, expected: unknown, label: string): void {
  if (!sameCanonical(actual, expected)) {
    fail("PROBE_EVIDENCE_BINDING_MISMATCH", `${label} differs from the sealed family`);
  }
}

function parseCanonicalJson(bytes: Uint8Array, label: string): JsonRecord {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("INVALID_PROBE_EVIDENCE", `${label} is not UTF-8 JSON`);
  }
  if (!isRecord(value) || text !== canonicalWalmartItemReportJson(value)) {
    fail("NON_CANONICAL_PROBE_EVIDENCE", `${label} is not canonical JSON`);
  }
  return value;
}

function fixedRequest(correlationId: string): JsonRecord {
  return {
    kind: "walmart-api",
    method: "GET",
    endpoint: API_ENDPOINT,
    query: { ...WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY },
    url: null,
    headers: { accept: "application/json", "accept-encoding": "identity" },
    body: null,
    correlation_id: correlationId,
    redirect: "manual",
    max_response_bytes: MAX_RESPONSE_BYTES,
    max_redirect_response_bytes: MAX_REDIRECT_BYTES,
    timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function validateSafeHeaders(value: unknown): JsonRecord {
  const headers = record(value, "safe_response_headers");
  const allowed = new Set([
    "content-length",
    "content-type",
    "x-request-id",
    "wm_qos.correlation_id",
    "wm-qos-correlation-id",
  ]);
  for (const [name, raw] of Object.entries(headers)) {
    if (!allowed.has(name) || typeof raw !== "string" || raw.length === 0
      || raw.length > 512 || /[\u0000-\u001f\u007f]/u.test(raw)) {
      fail("INVALID_PROBE_EVIDENCE", "safe response headers are invalid");
    }
  }
  const contentType = headers["content-type"];
  if (typeof contentType !== "string"
    || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    fail("INVALID_PROBE_EVIDENCE", "safe response content-type is invalid");
  }
  return headers;
}

function parseExactZeroResponse(bytes: Uint8Array): {
  page: 1;
  totalCount: 0;
  limit: number;
  requests: [];
} {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("INVALID_PROBE_EVIDENCE", "raw response is not UTF-8 JSON");
  }
  const raw = record(value, "raw response");
  const keys = Object.keys(raw).sort();
  const allowed = ["limit", "nextCursor", "page", "requests", "totalCount"];
  if (keys.some((key) => !allowed.includes(key))
    || raw.page !== 1 || raw.totalCount !== 0
    || !Number.isSafeInteger(raw.limit) || Number(raw.limit) < 0
    || !Array.isArray(raw.requests) || raw.requests.length !== 0
    || (raw.nextCursor !== undefined && raw.nextCursor !== null && raw.nextCursor !== "")) {
    fail("ABSENCE_NOT_PROVEN", "raw response is not the exact zero-result page");
  }
  return {
    page: 1,
    totalCount: 0,
    limit: Number(raw.limit),
    requests: [],
  };
}

function artifact(bytes: Uint8Array, path: string): WalmartItemV6AbsenceProbeEvidenceArtifact {
  return { path, byte_length: bytes.byteLength, sha256: sha256(bytes) };
}

export function verifyWalmartItemV6AbsenceProbeEvidenceFamily(input: {
  artifacts: Readonly<Record<string, Uint8Array>>;
  expected_probe_id?: string;
  expected_account_fingerprint_for_test?: string;
}): VerifiedWalmartItemV6AbsenceProbeEvidenceFamily {
  const actualNames = Object.keys(input.artifacts).sort();
  assertCanonicalEqual(
    actualNames,
    [...WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES],
    "probe artifact inventory",
  );
  const bytes = new Map<string, Uint8Array>();
  for (const name of WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES) {
    const value = input.artifacts[name];
    if (!(value instanceof Uint8Array) || value.byteLength < 1
      || value.byteLength > MAX_RESPONSE_BYTES) {
      fail("INVALID_PROBE_EVIDENCE", `${name} bytes are invalid`);
    }
    bytes.set(name, value);
  }
  const authorityBytes = bytes.get("00-probe-authority.json")!;
  const reservationBytes = bytes.get("10-get-reserved.json")!;
  const responseBytes = bytes.get("20-response-raw.bytes")!;
  const httpBytes = bytes.get("21-response-http.json")!;
  const sealBytes = bytes.get("22-exchange-seal.json")!;
  const resultBytes = bytes.get("30-result.json")!;
  const authority = parseCanonicalJson(authorityBytes, "probe authority");
  const reservation = parseCanonicalJson(reservationBytes, "GET reservation");
  const http = parseCanonicalJson(httpBytes, "HTTP metadata");
  const seal = parseCanonicalJson(sealBytes, "exchange seal");
  const result = parseCanonicalJson(resultBytes, "probe result");
  const probeId = exactString(authority.probe_id, "probe_id", 180);
  if (input.expected_probe_id !== undefined && probeId !== input.expected_probe_id) {
    fail("PROBE_EVIDENCE_BINDING_MISMATCH", "probe_id differs from the expected custody root");
  }
  const correlationId = exactString(
    record(authority.request, "authority request").request_correlation_id,
    "request correlation ID",
    128,
  );
  const correlationSha = sha256(Buffer.from(correlationId, "utf8"));
  const createdAt = strictInstant(authority.created_at, "authority created_at");
  const expectedFingerprint = input.expected_account_fingerprint_for_test
    ?? WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_ACCOUNT_FINGERPRINT;
  const accountScope = {
    channel: "WALMART_US" as const,
    store_index: 1 as const,
    seller_id: WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_SELLER_ID,
    seller_account_fingerprint_sha256: expectedFingerprint,
  };
  assertCanonicalEqual(authority, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "probe-authority",
    probe_id: probeId,
    created_at: createdAt,
    account_scope: accountScope,
    request: {
      method: "GET",
      endpoint: API_ENDPOINT,
      query: { ...WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY },
      request_correlation_id: correlationId,
      request_correlation_id_sha256: correlationSha,
    },
    budget: {
      oauth_token_posts_maximum: 1,
      report_requests_gets_maximum: 1,
      report_create_posts_maximum: 0,
      retries_allowed: 0,
      redirects_allowed: 0,
      cursor_calls_allowed: 0,
      listing_content_writes_allowed: 0,
      model_calls_allowed: 0,
      database_calls_allowed: 0,
    },
  }, "probe authority");
  const reservedAt = strictInstant(reservation.reserved_at, "reservation reserved_at");
  assertCanonicalEqual(reservation, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "get-reservation",
    probe_id: probeId,
    reserved_at: reservedAt,
    authority_sha256: sha256(authorityBytes),
    request_sha256: sha256(canonicalBytes(fixedRequest(correlationId))),
    state: "GET_RESERVED",
    retry_allowed: false,
  }, "GET reservation");
  const observedAt = strictInstant(http.observed_at, "HTTP observed_at");
  const headers = validateSafeHeaders(http.safe_response_headers);
  assertCanonicalEqual(http, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "response-http",
    probe_id: probeId,
    observed_at: observedAt,
    status: 200,
    safe_response_headers: headers,
    raw_response_byte_length: responseBytes.byteLength,
    raw_response_sha256: sha256(responseBytes),
    request_correlation_id_sha256: correlationSha,
    validation_error_code: null,
  }, "HTTP metadata");
  const parsedResponse = parseExactZeroResponse(responseBytes);
  const inventory = [
    artifact(authorityBytes, "00-probe-authority.json"),
    artifact(reservationBytes, "10-get-reserved.json"),
    artifact(responseBytes, "20-response-raw.bytes"),
    artifact(httpBytes, "21-response-http.json"),
  ];
  const sealPreimage = {
    authority_sha256: inventory[0].sha256,
    reservation_sha256: inventory[1].sha256,
    raw_response_sha256: inventory[2].sha256,
    http_metadata_sha256: inventory[3].sha256,
  };
  assertCanonicalEqual(seal, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "exchange-seal",
    probe_id: probeId,
    ...sealPreimage,
    exchange_sha256: sha256(canonicalBytes(sealPreimage)),
  }, "exchange seal");
  inventory.push(artifact(sealBytes, "22-exchange-seal.json"));
  const completedAt = strictInstant(result.completed_at, "result completed_at");
  const evidenceFamilySha = sha256(canonicalBytes(inventory));
  assertCanonicalEqual(result, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "result",
    probe_id: probeId,
    completed_at: completedAt,
    outcome: "ABSENCE_ONLY",
    absence_proven_for_exact_query: true,
    stop_required: false,
    response: {
      page: parsedResponse.page,
      total_count: parsedResponse.totalCount,
      limit: parsedResponse.limit,
      request_count: 0,
      next_cursor_present: false,
    },
    http_calls: {
      oauth_token_posts: 1,
      report_requests_gets: 1,
      presigned_file_calls: 0,
    },
    report_create_posts: 0,
    retries: 0,
    cursor_calls: 0,
    listing_content_writes: 0,
    model_calls: 0,
    database_calls: 0,
    evidence_inventory: inventory,
    evidence_family_sha256: evidenceFamilySha,
  }, "probe result");
  if (!(Date.parse(createdAt) <= Date.parse(reservedAt)
    && Date.parse(reservedAt) <= Date.parse(observedAt)
    && Date.parse(observedAt) <= Date.parse(completedAt))) {
    fail("INVALID_PROBE_EVIDENCE", "probe chronology is invalid");
  }
  const xRequestId = typeof headers["x-request-id"] === "string"
    ? headers["x-request-id"]
    : null;
  return {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    probe_id: probeId,
    account_scope: accountScope,
    query: WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY,
    created_at: createdAt,
    reserved_at: reservedAt,
    observed_at: observedAt,
    completed_at: completedAt,
    fresh_until: new Date(
      Date.parse(observedAt) + WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_MAX_AGE_MS,
    ).toISOString(),
    request_correlation_id: correlationId,
    request_correlation_id_sha256: correlationSha,
    walmart_x_request_id: xRequestId,
    raw_response_sha256: sha256(responseBytes),
    raw_response_byte_length: responseBytes.byteLength,
    artifact_inventory: [...inventory, artifact(resultBytes, "30-result.json")],
    evidence_family_sha256: evidenceFamilySha,
    result_artifact_sha256: sha256(resultBytes),
    outcome: "ABSENCE_ONLY",
    exact_query_absence_verified: true,
    http_calls: {
      oauth_token_posts: 1,
      report_requests_gets: 1,
      presigned_file_calls: 0,
    },
  };
}
