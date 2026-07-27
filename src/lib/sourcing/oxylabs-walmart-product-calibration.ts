/**
 * One-call Oxylabs `walmart_product` schema-calibration contract.
 *
 * This belongs to the shared Sourcing/Enrichment Engine. It captures one raw
 * provider response for parser calibration; it does not create listing truth,
 * parse product fields, download images, or retry/fallback to another source.
 */

import { createHash } from "node:crypto";
import { withMeteredProviderCall } from "./metered-provider-call";

export const OXYLABS_REALTIME_QUERIES_ENDPOINT =
  "https://realtime.oxylabs.io/v1/queries" as const;
export const OXYLABS_WALMART_PRODUCT_CALIBRATION_PLAN_SCHEMA =
  "oxylabs-walmart-product-calibration-plan/v1" as const;
export const OXYLABS_WALMART_PRODUCT_CALIBRATION_RECEIPT_SCHEMA =
  "oxylabs-walmart-product-calibration-receipt/v1" as const;
export const OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const OXYLABS_WALMART_PRODUCT_TIMEOUT_MS = 60_000;

const SHA256_RE = /^[a-f0-9]{64}$/;
const ITEM_ID_RE = /^\d{1,20}$/;
const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface OxylabsWalmartProductCalibrationPlanBody {
  schema_version: typeof OXYLABS_WALMART_PRODUCT_CALIBRATION_PLAN_SCHEMA;
  purpose: "buyer_pdp_schema_calibration";
  item_id: string;
  provider: "oxylabs_realtime";
  request: {
    endpoint: typeof OXYLABS_REALTIME_QUERIES_ENDPOINT;
    method: "POST";
    content_type: "application/json";
    body: {
      source: "walmart_product";
      query: string;
      parse: true;
    };
  };
  execution_contract: {
    owner_approval_required: true;
    global_metered_run_permit_required: true;
    max_primary_calls: 1;
    max_attempts: 1;
    retries: 0;
    fallbacks: 0;
    health_probes: 0;
    timeout_ms: typeof OXYLABS_WALMART_PRODUCT_TIMEOUT_MS;
    max_response_bytes: typeof OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES;
    response_parsing_performed: false;
    image_downloads: 0;
    database_writes: 0;
    walmart_writes: 0;
    r2_writes: 0;
    model_calls: 0;
  };
  credential_contract: {
    username_env: "OXYLABS_USERNAME";
    password_env: "OXYLABS_PASSWORD";
    persisted_or_logged: false;
  };
  artifact_contract: {
    raw_response_filename: string;
    receipt_filename: string;
    exclusive_create_before_call: true;
    raw_response_persisted_before_any_parsing: true;
  };
}

export interface SealedOxylabsWalmartProductCalibrationPlan
  extends OxylabsWalmartProductCalibrationPlanBody {
  plan_id: string;
  body_sha256: string;
}

export interface OxylabsCalibrationTransportRequest {
  endpoint: typeof OXYLABS_REALTIME_QUERIES_ENDPOINT;
  method: "POST";
  headers: {
    "content-type": "application/json";
    authorization: string;
  };
  body: string;
  timeout_ms: typeof OXYLABS_WALMART_PRODUCT_TIMEOUT_MS;
  max_response_bytes: typeof OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES;
}

export interface OxylabsCalibrationTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type OxylabsCalibrationTransport = (
  request: OxylabsCalibrationTransportRequest,
) => Promise<OxylabsCalibrationTransportResponse>;

export interface OxylabsWalmartProductCalibrationReceiptBody {
  schema_version: typeof OXYLABS_WALMART_PRODUCT_CALIBRATION_RECEIPT_SCHEMA;
  purpose: "buyer_pdp_schema_calibration";
  plan_id: string;
  plan_body_sha256: string;
  item_id: string;
  started_at: string;
  completed_at: string;
  sanitized_request: {
    endpoint: typeof OXYLABS_REALTIME_QUERIES_ENDPOINT;
    method: "POST";
    content_type: "application/json";
    authorization: "basic_auth_present_redacted";
    body: {
      source: "walmart_product";
      query: string;
      parse: true;
    };
  };
  response: {
    http_status: number;
    content_type: string | null;
    provider_request_ids: string[];
    raw_body_sha256: string;
    raw_body_bytes: number;
    raw_response_filename: string;
  };
  execution: {
    primary_calls: 1;
    attempts: 1;
    retries: 0;
    fallbacks: 0;
    health_probes: 0;
    response_parsing_performed: false;
    image_downloads: 0;
    database_writes: 0;
    walmart_writes: 0;
    r2_writes: 0;
    model_calls: 0;
  };
}

export interface SealedOxylabsWalmartProductCalibrationReceipt
  extends OxylabsWalmartProductCalibrationReceiptBody {
  receipt_id: string;
  body_sha256: string;
}

export interface OxylabsWalmartProductCalibrationExecution {
  receipt: SealedOxylabsWalmartProductCalibrationReceipt;
  raw_response_bytes: Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const keys = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !keys.has(key));
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length) throw new Error(`${path} has unsupported fields: ${extras.join(", ")}`);
  if (missing.length) throw new Error(`${path} is missing required fields: ${missing.join(", ")}`);
}

export function canonicalOxylabsCalibrationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOxylabsCalibrationJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new Error(`canonical JSON does not allow undefined at ${key}`);
      return `${JSON.stringify(key)}:${canonicalOxylabsCalibrationJson(value[key])}`;
    }).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON does not allow undefined");
  return encoded;
}

export function oxylabsCalibrationSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSha(value: unknown): string {
  return oxylabsCalibrationSha256(canonicalOxylabsCalibrationJson(value));
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function requiredSha(value: unknown, path: string): string {
  const parsed = requiredString(value, path);
  if (!SHA256_RE.test(parsed)) throw new Error(`${path} must be a lowercase SHA-256`);
  return parsed;
}

function exactItemId(value: unknown, path = "item_id"): string {
  const parsed = requiredString(value, path);
  if (!ITEM_ID_RE.test(parsed)) throw new Error(`${path} must contain 1-20 digits`);
  return parsed;
}

function canonicalInstant(value: unknown, path: string): string {
  const parsed = requiredString(value, path);
  if (!CANONICAL_INSTANT_RE.test(parsed) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${path} must be a canonical UTC millisecond instant`);
  }
  return parsed;
}

function artifactNames(itemId: string): {
  raw_response_filename: string;
  receipt_filename: string;
} {
  const stem = `oxylabs-walmart-product-calibration-${itemId}`;
  return {
    raw_response_filename: `${stem}.raw-response.bin`,
    receipt_filename: `${stem}.receipt.json`,
  };
}

export function buildOxylabsWalmartProductCalibrationPlan(
  rawItemId: unknown,
): SealedOxylabsWalmartProductCalibrationPlan {
  const itemId = exactItemId(rawItemId);
  const names = artifactNames(itemId);
  const body: OxylabsWalmartProductCalibrationPlanBody = {
    schema_version: OXYLABS_WALMART_PRODUCT_CALIBRATION_PLAN_SCHEMA,
    purpose: "buyer_pdp_schema_calibration",
    item_id: itemId,
    provider: "oxylabs_realtime",
    request: {
      endpoint: OXYLABS_REALTIME_QUERIES_ENDPOINT,
      method: "POST",
      content_type: "application/json",
      body: { source: "walmart_product", query: itemId, parse: true },
    },
    execution_contract: {
      owner_approval_required: true,
      global_metered_run_permit_required: true,
      max_primary_calls: 1,
      max_attempts: 1,
      retries: 0,
      fallbacks: 0,
      health_probes: 0,
      timeout_ms: OXYLABS_WALMART_PRODUCT_TIMEOUT_MS,
      max_response_bytes: OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES,
      response_parsing_performed: false,
      image_downloads: 0,
      database_writes: 0,
      walmart_writes: 0,
      r2_writes: 0,
      model_calls: 0,
    },
    credential_contract: {
      username_env: "OXYLABS_USERNAME",
      password_env: "OXYLABS_PASSWORD",
      persisted_or_logged: false,
    },
    artifact_contract: {
      ...names,
      exclusive_create_before_call: true,
      raw_response_persisted_before_any_parsing: true,
    },
  };
  const bodySha = canonicalSha(body);
  return {
    ...body,
    plan_id: `oxylabs-walmart-product-calibration-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

export function verifyOxylabsWalmartProductCalibrationPlan(
  raw: unknown,
): SealedOxylabsWalmartProductCalibrationPlan {
  if (!isRecord(raw)) throw new Error("calibration plan must be an object");
  assertExactKeys(raw, [
    "schema_version", "purpose", "item_id", "provider", "request",
    "execution_contract", "credential_contract", "artifact_contract", "plan_id",
    "body_sha256",
  ], "calibration plan");
  const expected = buildOxylabsWalmartProductCalibrationPlan(raw.item_id);
  if (canonicalOxylabsCalibrationJson(raw) !== canonicalOxylabsCalibrationJson(expected)) {
    throw new Error("calibration plan differs from the fixed one-call contract");
  }
  return expected;
}

function normalizedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key.toLowerCase(), String(value),
  ]));
}

function providerRequestIds(headers: Record<string, string>): string[] {
  const normalized = normalizedHeaders(headers);
  const names = [
    "x-oxylabs-job-id", "x-request-id", "x-correlation-id", "request-id",
  ];
  return [...new Set(names.flatMap((name) => {
    const value = normalized[name]?.trim();
    return value ? [`${name}:${value.slice(0, 300)}`] : [];
  }))].sort();
}

function sealReceipt(
  body: OxylabsWalmartProductCalibrationReceiptBody,
): SealedOxylabsWalmartProductCalibrationReceipt {
  const bodySha = canonicalSha(body);
  return {
    ...body,
    receipt_id: `oxylabs-walmart-product-calibration-receipt-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha,
  };
}

export function verifyOxylabsWalmartProductCalibrationReceipt(
  raw: unknown,
): SealedOxylabsWalmartProductCalibrationReceipt {
  if (!isRecord(raw)) throw new Error("calibration receipt must be an object");
  assertExactKeys(raw, [
    "schema_version", "purpose", "plan_id", "plan_body_sha256", "item_id",
    "started_at", "completed_at", "sanitized_request", "response", "execution",
    "receipt_id", "body_sha256",
  ], "calibration receipt");
  const body = { ...raw };
  delete body.receipt_id;
  delete body.body_sha256;
  const bodySha = requiredSha(raw.body_sha256, "calibration receipt.body_sha256");
  if (canonicalSha(body) !== bodySha) throw new Error("calibration receipt body SHA mismatch");
  if (raw.receipt_id !== `oxylabs-walmart-product-calibration-receipt-${bodySha.slice(0, 16)}`) {
    throw new Error("calibration receipt ID mismatch");
  }
  const plan = buildOxylabsWalmartProductCalibrationPlan(raw.item_id);
  if (raw.plan_id !== plan.plan_id || raw.plan_body_sha256 !== plan.body_sha256) {
    throw new Error("calibration receipt is detached from the fixed plan");
  }
  if (canonicalOxylabsCalibrationJson(raw.sanitized_request) !== canonicalOxylabsCalibrationJson({
    endpoint: plan.request.endpoint,
    method: plan.request.method,
    content_type: plan.request.content_type,
    authorization: "basic_auth_present_redacted",
    body: plan.request.body,
  })) {
    throw new Error("calibration receipt request differs from the fixed plan");
  }
  canonicalInstant(raw.started_at, "calibration receipt.started_at");
  canonicalInstant(raw.completed_at, "calibration receipt.completed_at");
  if (Date.parse(String(raw.completed_at)) < Date.parse(String(raw.started_at))) {
    throw new Error("calibration receipt completed_at predates started_at");
  }
  if (!isRecord(raw.response)) throw new Error("calibration receipt.response must be an object");
  assertExactKeys(raw.response, [
    "http_status", "content_type", "provider_request_ids", "raw_body_sha256",
    "raw_body_bytes", "raw_response_filename",
  ], "calibration receipt.response");
  if (!Number.isInteger(raw.response.http_status)
    || Number(raw.response.http_status) < 100 || Number(raw.response.http_status) > 599) {
    throw new Error("calibration receipt.response.http_status is invalid");
  }
  if (raw.response.content_type !== null && typeof raw.response.content_type !== "string") {
    throw new Error("calibration receipt.response.content_type is invalid");
  }
  if (!Array.isArray(raw.response.provider_request_ids)
    || raw.response.provider_request_ids.some((value) => typeof value !== "string")) {
    throw new Error("calibration receipt.response.provider_request_ids is invalid");
  }
  requiredSha(raw.response.raw_body_sha256, "calibration receipt.response.raw_body_sha256");
  if (!Number.isSafeInteger(raw.response.raw_body_bytes)
    || Number(raw.response.raw_body_bytes) < 0
    || Number(raw.response.raw_body_bytes) > OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES) {
    throw new Error("calibration receipt.response.raw_body_bytes is invalid");
  }
  if (raw.response.raw_response_filename !== plan.artifact_contract.raw_response_filename) {
    throw new Error("calibration receipt raw response filename differs from plan");
  }
  if (canonicalOxylabsCalibrationJson(raw.execution) !== canonicalOxylabsCalibrationJson({
    primary_calls: 1,
    attempts: 1,
    retries: 0,
    fallbacks: 0,
    health_probes: 0,
    response_parsing_performed: false,
    image_downloads: 0,
    database_writes: 0,
    walmart_writes: 0,
    r2_writes: 0,
    model_calls: 0,
  })) {
    throw new Error("calibration receipt execution contract is invalid");
  }
  return raw as unknown as SealedOxylabsWalmartProductCalibrationReceipt;
}

export function verifyOxylabsWalmartProductCalibrationReceiptAgainstRawResponse(
  rawReceipt: unknown,
  rawResponseBytes: unknown,
): SealedOxylabsWalmartProductCalibrationReceipt {
  const receipt = verifyOxylabsWalmartProductCalibrationReceipt(rawReceipt);
  if (!(rawResponseBytes instanceof Uint8Array)) {
    throw new Error("calibration raw response must be Uint8Array bytes");
  }
  if (rawResponseBytes.byteLength !== receipt.response.raw_body_bytes) {
    throw new Error("calibration raw response byte length differs from receipt");
  }
  if (oxylabsCalibrationSha256(rawResponseBytes) !== receipt.response.raw_body_sha256) {
    throw new Error("calibration raw response SHA differs from receipt");
  }
  return receipt;
}

function cleanCredential(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} is required`);
  return value.trim().replace(/^['"]|['"]$/g, "");
}

export async function executeOxylabsWalmartProductCalibration(options: {
  plan: unknown;
  username: unknown;
  password: unknown;
  transport: OxylabsCalibrationTransport;
  now?: () => string;
}): Promise<OxylabsWalmartProductCalibrationExecution> {
  const plan = verifyOxylabsWalmartProductCalibrationPlan(options.plan);
  const username = cleanCredential(options.username, "Oxylabs username");
  const password = cleanCredential(options.password, "Oxylabs password");
  if (typeof options.transport !== "function") throw new Error("calibration transport is required");
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = canonicalInstant(now(), "calibration started_at");
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  // Exactly one awaited transport invocation: no health check, retry, or fallback.
  const response = await options.transport({
    endpoint: OXYLABS_REALTIME_QUERIES_ENDPOINT,
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(plan.request.body),
    timeout_ms: OXYLABS_WALMART_PRODUCT_TIMEOUT_MS,
    max_response_bytes: OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES,
  });
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new Error("Oxylabs transport returned an invalid HTTP status");
  }
  if (!(response.body instanceof Uint8Array)) {
    throw new Error("Oxylabs transport must return raw Uint8Array bytes");
  }
  if (response.body.byteLength > OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES) {
    throw new Error("Oxylabs response exceeds the calibration byte cap");
  }
  const completedAt = canonicalInstant(now(), "calibration completed_at");
  const headers = normalizedHeaders(response.headers);
  const receipt = sealReceipt({
    schema_version: OXYLABS_WALMART_PRODUCT_CALIBRATION_RECEIPT_SCHEMA,
    purpose: "buyer_pdp_schema_calibration",
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    item_id: plan.item_id,
    started_at: startedAt,
    completed_at: completedAt,
    sanitized_request: {
      endpoint: plan.request.endpoint,
      method: plan.request.method,
      content_type: plan.request.content_type,
      authorization: "basic_auth_present_redacted",
      body: plan.request.body,
    },
    response: {
      http_status: response.status,
      content_type: headers["content-type"] ?? null,
      provider_request_ids: providerRequestIds(headers),
      raw_body_sha256: oxylabsCalibrationSha256(response.body),
      raw_body_bytes: response.body.byteLength,
      raw_response_filename: plan.artifact_contract.raw_response_filename,
    },
    execution: {
      primary_calls: 1,
      attempts: 1,
      retries: 0,
      fallbacks: 0,
      health_probes: 0,
      response_parsing_performed: false,
      image_downloads: 0,
      database_writes: 0,
      walmart_writes: 0,
      r2_writes: 0,
      model_calls: 0,
    },
  });
  verifyOxylabsWalmartProductCalibrationReceiptAgainstRawResponse(receipt, response.body);
  return { receipt, raw_response_bytes: new Uint8Array(response.body) };
}

export async function readBoundedOxylabsResponseBody(
  response: Response,
  maxBytes = OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES,
): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > maxBytes) {
    throw new Error("Oxylabs response Content-Length exceeds the byte cap");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response byte cap exceeded");
      throw new Error("Oxylabs response exceeds the byte cap");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/** Real transport used only after the script's explicit one-call owner gate. */
export const fetchOxylabsCalibrationTransport: OxylabsCalibrationTransport = async (request) => {
  if (request.endpoint !== OXYLABS_REALTIME_QUERIES_ENDPOINT
    || request.method !== "POST"
    || request.timeout_ms !== OXYLABS_WALMART_PRODUCT_TIMEOUT_MS
    || request.max_response_bytes !== OXYLABS_WALMART_PRODUCT_RESPONSE_MAX_BYTES) {
    throw new Error("Oxylabs transport request violates the fixed calibration contract");
  }
  const response = await withMeteredProviderCall({
    provider: "oxylabs",
    operation: "walmart_product_calibration",
    requestFingerprint: {
      endpoint: request.endpoint,
      method: request.method,
      bodySha256: oxylabsCalibrationSha256(request.body),
      timeoutMs: request.timeout_ms,
      maxResponseBytes: request.max_response_bytes,
    },
  }, () => fetch(request.endpoint, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: AbortSignal.timeout(request.timeout_ms),
    }));
  const body = await readBoundedOxylabsResponseBody(response, request.max_response_bytes);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return {
    status: response.status,
    headers: responseHeaders,
    body,
  };
};
